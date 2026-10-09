'use strict';
// 服务端指定轨迹，当前租约观察者仅返回本地流式地图的碰撞候选；从不计算伤害或选择受害者。
self.createWorldCollisionBridge = function ({ ex, memory, post }) {
  const MAX_DISTANCE = 180, MAX_ACTIVE = 8, MAX_JOBS = 32, MAX_SEGMENTS = 16;
  // 世界、物体、植被；角色由服务器胶囊独立判定。载具精确动态碰撞尚未接入此查询。
  const FLAGS = 1 | 16 | 256;
  const supported = ['mpAlloc', 'mpGetEntityCoords', 'mpStartShapeTestLOS', 'mpStartShapeTestSweptSphere',
    'mpShapeTestResultMaterial', 'mpCollisionLoadedAroundEntity', 'mpWaitingForWorldCollision']
    .every(name => typeof ex[name] === 'function');
  const jobs = new Map(), seen = new Set(), pending = new Map();
  let scratch = 0, identity = '';
  const point = value => Array.isArray(value) && value.length === 3 && value.every(n => Number.isFinite(n) && Math.abs(n) <= 16000);
  const distance = (a, b) => Math.hypot(...a.map((n, i) => n - b[i]));
  const view = () => new DataView(memory.buffer);
  function input(offset, values) {
    values.forEach((n, i) => view().setFloat32(scratch + offset + i * 8, n, true));
    return BigInt(scratch + offset);
  }
  const output = offset => [0, 4, 8].map(i => view().getFloat32(scratch + offset + i, true));
  function finish(job, complete, reason) {
    if (!jobs.has(job.query.query_id)) return;
    jobs.delete(job.query.query_id);
    seen.add(job.query.query_id);
    while (seen.size > 512) seen.delete(seen.values().next().value);
    post({ type: 'collision_result', schema_version: 2, world_epoch: job.query.world_epoch,
      query_id: job.query.query_id, hits: complete ? job.hits : [], complete,
      ...(reason ? { reason } : {}) });
  }
  function accept(query, packet, now) {
    if (!query || query.observer_id !== packet.client_id || query.world_epoch !== packet.world?.world_epoch
      || query.schema_version !== 2 || typeof query.query_id !== 'string' || query.query_id.length > 128
      || seen.has(query.query_id) || jobs.has(query.query_id)) return;
    const job = { query, hits: [], next: 0, remaining: 0, deadline: now + 1000 };
    jobs.set(query.query_id, job);
    if (jobs.size > MAX_JOBS || !Array.isArray(query.segments) || !query.segments.length
      || query.segments.length > MAX_SEGMENTS || !Number.isSafeInteger(query.issued_at)
      || !Number.isSafeInteger(query.expires_at) || query.expires_at <= query.issued_at
      || query.expires_at - query.issued_at > 5000 || !['shot', 'projectile', 'visibility'].includes(query.purpose)
      || query.segments.some(segment => !point(segment?.from) || !point(segment?.to)
        || !Number.isFinite(segment.radius) || segment.radius < 0 || segment.radius > 2
        || distance(segment.from, segment.to) > MAX_DISTANCE * 2)) return finish(job, false, 'invalid_query');
    job.deadline = now + Math.min(1000, query.expires_at - query.issued_at);
    job.hits = Array(query.segments.length).fill(null);
  }
  function tick(packet, now, ped, { localReady = true } = {}) {
    const current = packet?.connected ? packet.client_id + ':' + packet.world?.world_epoch : '';
    if (current !== identity) {
      // 已发起native请求仍轮询消费；旧身份结果不得回发到新房间。
      jobs.clear(); seen.clear(); identity = current;
    }
    if (packet?.connected && packet.world?.ready) {
      for (const query of packet.collision_queries || []) accept(query, packet, now);
    }
    if (!supported) { for (const job of jobs.values()) finish(job, false, 'native_unavailable'); return; }
    if (!scratch) {
      scratch = Number(ex.mpAlloc(128n));
      if (!Number.isSafeInteger(scratch) || scratch <= 0 || scratch + 128 > memory.buffer.byteLength) {
        scratch = 0; for (const job of jobs.values()) finish(job, false, 'allocation_failed'); return;
      }
    }
    // 一帧只读一次每个句柄；返回2后原生已释放，绝不能再次查询相同句柄。
    for (const [handle, entry] of pending) {
      new Uint8Array(memory.buffer, scratch + 48, 64).fill(0);
      let status;
      try { status = ex.mpShapeTestResultMaterial(handle, BigInt(scratch + 48), BigInt(scratch + 64),
        BigInt(scratch + 80), BigInt(scratch + 96), BigInt(scratch + 100)); }
      catch { status = 0; }
      if (status === 1) continue;
      pending.delete(handle);
      const job = jobs.get(entry.id);
      if (!job || job !== entry.job) continue;
      job.remaining--;
      if (status !== 2) { finish(job, false, 'invalid_native_result'); continue; }
      if (view().getInt32(scratch + 48, true)) {
        const position = output(64), normal = output(80), length = Math.hypot(...normal);
        if (!point(position) || !point(normal) || length < 0.5 || length > 1.5) {
          finish(job, false, 'invalid_native_result'); continue;
        }
        job.hits[entry.index] = { position, normal: normal.map(n => n / length), material: view().getUint32(scratch + 96, true) };
      }
      if (!job.remaining && job.next === job.query.segments.length) finish(job, true);
    }
    if (!jobs.size) return;
    let observer = null;
    if (localReady && ped && ex.mpCollisionLoadedAroundEntity(ped) && !ex.mpWaitingForWorldCollision(ped)) {
      ex.mpGetEntityCoords(BigInt(scratch), ped, 1);
      observer = [0, 8, 16].map(i => view().getFloat32(scratch + i, true));
    }
    let launched = 0;
    for (const job of jobs.values()) {
      if (now >= job.deadline) { finish(job, false, 'query_timeout'); continue; }
      if (!point(observer)) { finish(job, false, 'collision_not_loaded'); continue; }
      if (job.query.segments.some(segment => distance(observer, segment.from) > MAX_DISTANCE
        || distance(observer, segment.to) > MAX_DISTANCE)) { finish(job, false, 'outside_streaming_range'); continue; }
      while (job.next < job.query.segments.length && pending.size < MAX_ACTIVE && launched < 4) {
        const index = job.next++, segment = job.query.segments[index];
        let handle = 0;
        try {
          const from = input(0, segment.from), to = input(24, segment.to);
          handle = segment.radius > 0 ? ex.mpStartShapeTestSweptSphere(from, to, segment.radius, FLAGS, 0, 0)
            : ex.mpStartShapeTestLOS(from, to, FLAGS, 0, 0);
        } catch { /* 无法创建查询时不能宣称这条轨迹无遮挡。 */ }
        if (!Number.isInteger(handle) || !handle || pending.has(handle)) { finish(job, false, 'native_query_failed'); break; }
        pending.set(handle, { id: job.query.query_id, job, index }); job.remaining++; launched++;
      }
    }
  }
  return { supported, tick(...args) {
    try { tick(...args); }
    catch { for (const job of jobs.values()) finish(job, false, 'native_query_failed'); }
  } };
};
