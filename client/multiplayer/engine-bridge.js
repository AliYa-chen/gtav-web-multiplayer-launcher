'use strict';
// 此桥在 scrThread::Run 安装有效脚本上下文后执行。网络消息通过共享内存快照输入。
// 原始引擎保留；只有公共战局 /play/ 选用另一个带导出和线程回调的 WASM 副本。
self.prepareMultiplayerBridge = function (imports) {
  const MAGIC = 0x4d505442;
  const original = imports.env.wasm_module_int_js;
  let tick = null;
  imports.env.wasm_module_int_js = (pointer, value) => {
    if (value === MAGIC) { if (tick) tick(Number(pointer)); return 0; }
    return original(pointer, value);
  };
  return function bind(instance) {
    const ex = instance.exports;
    const memory = imports.env.memory;
    const CAPACITY = 128 * 1024;
    // 公共战局测试区：所有玩家使用同一中心点，按顺序错开两米防止重叠。
    const TEST_SPAWN = [711.5, -1088.1, 22.4];
    const replicas = new Map();
    const requested = new Map();
    const consumedShots = new Set();
    const decoder = new TextDecoder();
    let scratch = 0, block = 0, sequence = -1, packet = null, lastTick = 0, nameBuffer = 0;
    let lastShot = 0, lastState = 0, initialPlacement = false, stopped = false;
    let smoothingTime = 0, lastStatus = 0;

    const post = (value) => self.postMessage({ multiplayer: value });
    const validPosition = (position) => Array.isArray(position) && position.length === 3 &&
      position.every((value) => Number.isFinite(value) && Math.abs(value) <= 16000);
    function view() { return new DataView(memory.buffer); }
    function vector(offset, position) {
      const data = view();
      for (let i = 0; i < 3; i++) data.setFloat32(scratch + offset + 8 * i, position[i], true);
      return BigInt(scratch + offset);
    }
    function readVector(offset) {
      const data = view();
      return [0, 8, 16].map((part) => data.getFloat32(scratch + offset + part, true));
    }
    function requestModel(hash, now) {
      if (now - (requested.get(hash) ?? -Infinity) >= 1000) {
        ex.mpRequestModel(hash);
        requested.set(hash, now);
      }
    }
    function readPacket() {
      const header = new Int32Array(memory.buffer, block, 4);
      const before = Atomics.load(header, 0);
      if ((before & 1) || before === sequence) return;
      const length = Atomics.load(header, 1);
      if (length < 0 || length > CAPACITY) return;
      const bytes = new Uint8Array(memory.buffer, block + 16, length).slice();
      if (before !== Atomics.load(header, 0)) return;
      sequence = before;
      if (!length) return;
      try { packet = JSON.parse(decoder.decode(bytes)); } catch { return; }
    }
    function erase(replica) {
      if (replica?.blip && ex.mpRemoveBlip) {
        view().setInt32(scratch + 124, replica.blip, true);
        ex.mpRemoveBlip(BigInt(scratch + 124));
      }
      if (replica && ex.mpExists(replica.ped)) {
        view().setInt32(scratch + 120, replica.ped, true);
        ex.mpDeletePed(BigInt(scratch + 120));
      }
    }
    function updateReplica(id, state, now, delta) {
      if (!validPosition(state?.position) || !Number.isInteger(state.model) || !Number.isFinite(state.heading)) return;
      let replica = replicas.get(id);
      if (replica && (replica.model !== state.model || !ex.mpExists(replica.ped))) {
        erase(replica); replicas.delete(id); replica = null;
      }
      const hash = state.model | 0;
      if (!replica) {
        if (!ex.mpHasModel(hash)) {
          requestModel(hash, now);
          return;
        }
        const ped = ex.mpCreatePed(4, hash, vector(72, state.position), state.heading, 0, 0);
        if (!ped) return;
        ex.mpBlockEvents(ped, 1);
        if (ex.mpDefaultVariation) ex.mpDefaultVariation(ped);
        ex.mpFreeze(ped, 1);
        ex.mpSetCoordsNoOffset(ped, vector(72, state.position), 1, 1, 1);
        let blip = 0;
        if (ex.mpAddBlipForEntity) {
          blip = ex.mpAddBlipForEntity(ped);
          if (blip) {
            ex.mpSetBlipColour(blip, 3);
            ex.mpSetBlipSprite(blip, 1);
            ex.mpSetBlipScale(blip, .85);
            ex.mpSetBlipAsShortRange(blip, 0);
            const name = packet.members?.find((member) => member.id === id)?.name;
            if (name && ex.mpBeginSetBlipName && ex.mpAddTextPlayerSubstring && ex.mpEndSetBlipName) {
              if (!nameBuffer) nameBuffer = Number(ex.mpAlloc(256n));
              if (nameBuffer) {
                const buffer = new Uint8Array(memory.buffer, nameBuffer, 256);
                buffer.fill(0);
                buffer.set(new TextEncoder().encode('STRING'), 0);
                buffer.set(new TextEncoder().encode(String(name).slice(0, 24)), 32);
                ex.mpBeginSetBlipName(BigInt(nameBuffer));
                ex.mpAddTextPlayerSubstring(BigInt(nameBuffer + 32));
                ex.mpEndSetBlipName(blip);
              }
            }
          }
        }
        replica = { ped, model: state.model, position: [...state.position], weapon: 0, seen: now, blip };
        replicas.set(id, replica);
      }
      replica.seen = now;
      const distance = Math.hypot(...state.position.map((value, i) => value - replica.position[i]));
      const amount = distance > 20 ? 1 : Math.min(1, delta / 100);
      replica.position = state.position.map((value, i) => replica.position[i] + (value - replica.position[i]) * amount);
      ex.mpSetCoordsNoOffset(replica.ped, vector(72, replica.position), 1, 1, 1);
      ex.mpSetHeading(replica.ped, state.heading);
      if (ex.mpSetHealth && Number.isInteger(state.health)) ex.mpSetHealth(replica.ped, state.health, 0);
      if (state.weapon && replica.weapon !== state.weapon) {
        ex.mpGiveWeapon(replica.ped, state.weapon | 0, 999, 0, 1);
        ex.mpSetCurrentWeapon(replica.ped, state.weapon | 0, 1);
        replica.weapon = state.weapon;
      }
    }
    tick = (thread) => {
      try {
        const now = performance.now();
        if (stopped || now - lastTick < 40) return;
        // 跳过没有游戏脚本资源管理器的线程，不能从任意帧回调直接写实体。
        if (Number(ex.mpGetActiveThread()) !== thread || !ex.mpGetCurrentHandler()) return;
        lastTick = now;
        let localPed = ex.mpGetPlayerPed(-1);
        if (!localPed) return;
        if (!scratch) {
          scratch = Number(ex.mpAlloc(128n));
          block = Number(ex.mpAlloc(BigInt(CAPACITY + 16)));
          if (!scratch || !block) throw new Error('同步缓冲区分配失败');
          new Uint8Array(memory.buffer, block, CAPACITY + 16).fill(0);
          post({ type: 'memory', memory, block, capacity: CAPACITY });
        }
        ex.mpGetEntityCoords(BigInt(scratch), localPed, 1);
        let position = readVector(0);
        if (!validPosition(position) || (position[0] === 0 && position[1] === 0)) return;
        readPacket();
        if (!packet?.connected) {
          for (const replica of replicas.values()) erase(replica);
          replicas.clear(); initialPlacement = false;
          return;
        }
        // 公共战局使用 GTA 的多人自由模式角色；不替换单机三位主角。
        if (ex.mpSetPlayerModel && ex.mpPlayerId && ex.mpDefaultVariation) {
          const avatar = packet.avatar === 'female' ? 0x9c9effd8 : 0x705e61f2;
          if ((ex.mpGetModel(localPed) >>> 0) !== avatar) {
            const hash = avatar | 0;
            if (!ex.mpHasModel(hash)) {
              requestModel(hash, now);
              if (now - lastStatus >= 1000) {
                lastStatus = now;
                post({ type: 'game_status', connected: true, role_loading: true, peer_count: replicas.size });
              }
              return;
            }
            ex.mpSetPlayerModel(ex.mpPlayerId(), hash);
            localPed = ex.mpGetPlayerPed(-1);
            if (!localPed) return;
            ex.mpDefaultVariation(localPed);
            ex.mpGetEntityCoords(BigInt(scratch), localPed, 1);
            position = readVector(0);
          }
        }
        const peers = (packet.peers || []).filter((peer) => peer.player_id !== packet.client_id && validPosition(peer.state?.position));
        // 测试阶段固定出生区，既不使用随机点，也不依赖对方状态是否已经到达。
        if (!initialPlacement) {
          const index = Math.max(0, (packet.members || []).findIndex((member) => member.id === packet.client_id));
          position = [TEST_SPAWN[0] + (index % 8) * 2, TEST_SPAWN[1] + Math.floor(index / 8) * 2, TEST_SPAWN[2]];
          ex.mpSetCoordsNoOffset(localPed, vector(0, position), 1, 1, 1);
          ex.mpSetHeading(localPed, 90);
          initialPlacement = true;
          post({ type: 'game_status', connected: true, peer_count: replicas.size, spawned: true });
        }
        const model = ex.mpGetModel(localPed) >>> 0;
        const heading = ((ex.mpHeading(localPed) % 360) + 360) % 360;
        const health = Math.max(0, Math.min(1000, ex.mpGetHealth(localPed)));
        const weapon = ex.mpSelectedWeapon(localPed) >>> 0;
        const shooting = !!ex.mpIsShooting(localPed);
        if (now - lastState >= 50) {
          lastState = now;
          post({ type: 'local_state', state: { position, model, heading, health, weapon, shooting } });
        }
        const members = new Set((packet.members || []).map((member) => member.id));
        for (const [id, replica] of replicas) {
          if (!members.has(id)) { erase(replica); replicas.delete(id); }
        }
        const delta = smoothingTime ? Math.min(100, now - smoothingTime) : 40;
        smoothingTime = now;
        for (const peer of peers.slice(0, 32)) updateReplica(peer.player_id, peer.state, now, delta);
        for (const shot of packet.shots || []) {
          if (consumedShots.has(shot.id)) continue;
          consumedShots.add(shot.id);
          if (consumedShots.size > 128) consumedShots.delete(consumedShots.values().next().value);
          const replica = replicas.get(shot.player_id);
          if (replica && validPosition(shot.event?.target)) {
            ex.mpTaskShootAtCoord(replica.ped, vector(72, shot.event.target), 300, 0xc6ee6b4c | 0);
          }
        }
        if (packet.shots?.length) post({ type: 'shot_ack', ids: packet.shots.map((shot) => shot.id) });
        packet.shots = [];
        if (now - lastStatus >= 1000) {
          lastStatus = now;
          post({ type: 'game_status', connected: true, peer_count: replicas.size });
        }
        if (shooting && weapon && now - lastShot >= 100) {
          lastShot = now;
          ex.mpCamCoords(BigInt(scratch + 24));
          ex.mpCamRot(BigInt(scratch + 48), 2);
          const origin = readVector(24), rotation = readVector(48);
          const pitch = rotation[0] * Math.PI / 180, yaw = rotation[2] * Math.PI / 180;
          const direction = [-Math.sin(yaw) * Math.cos(pitch), Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch)];
          const target = origin.map((value, i) => value + 100 * direction[i]);
          if (validPosition(origin) && validPosition(target)) post({ type: 'local_shot', event: { origin, target, weapon } });
        }
      } catch (error) {
        // 不能把 JS 异常抛回 scrThread::Run；它必须继续执行原来的 TLS 清理路径。
        stopped = true;
        try { post({ type: 'bridge_error', message: String(error) }); } catch { /* 不向 WASM 抛异常 */ }
      }
    };
  };
};
