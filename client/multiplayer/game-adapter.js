// 游戏页面与同一浏览器实例的公共战局大厅之间传递状态。
// 网络连接由大厅持有；引擎线程通过共享内存读取最新快照，避免阻塞其帧循环。
export function installGameAdapter(worker) {
  const channel = new BroadcastChannel('gta5-public-bridge-v1');
  const peers = new Map();
  let session = { connected: false, client_id: null, members: [], avatar: 'male' };
  let shots = [];
  let nextShotId = 0;
  let shared = null;
  let timer = 0;
  let closed = false;
  let lastReport = '';

  function reportStatus(value) {
    const text = JSON.stringify(value);
    if (text === lastReport) return;
    lastReport = text;
    // 保存状态变化和错误，便于实际客户端复测；不输出调试面板或上传位置。
    try { fetch('/log', { method: 'POST', body: '[public-client] ' + text }).catch(() => {}); } catch { /* 日志失败不影响同步 */ }
  }

  const crashes = new BroadcastChannel('game-crash');
  crashes.onmessage = ({ data }) => {
    if (!data || !data.text) return;
    reportStatus({ phase: 'engine_crash', thread: data.thread, text: data.text, tail: data.tail || [] });
  };

  function publish() {
    timer = 0;
    if (!shared || closed) return;
    const packet = { ...session, peers: [...peers.values()], shots };
    const bytes = new TextEncoder().encode(JSON.stringify(packet));
    if (bytes.length > shared.capacity) return;
    const header = new Int32Array(shared.memory.buffer, shared.block, 4);
    const payload = new Uint8Array(shared.memory.buffer, shared.block + 16, shared.capacity);
    // 序列锁：奇数表示写入中，偶数表示完整；引擎复制前后检查同一序号。
    Atomics.add(header, 0, 1);
    payload.set(bytes);
    Atomics.store(header, 1, bytes.length);
    Atomics.add(header, 0, 1);
  }

  function schedule() {
    if (!timer) timer = setTimeout(publish, 40);
  }

  channel.onmessage = ({ data }) => {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'session') {
      session = { connected: data.connected === true, client_id: data.client_id || null,
        members: Array.isArray(data.members) ? data.members : [],
        avatar: data.avatar === 'female' ? 'female' : 'male' };
      peers.clear();
      for (const peer of data.peers || []) {
        if (peer?.player_id && peer.player_id !== session.client_id && peer.state) peers.set(peer.player_id, peer);
      }
      if (!session.connected) shots = [];
    } else if (data.type === 'player_state' && data.player_id !== session.client_id && data.state) {
      peers.set(data.player_id, { player_id: data.player_id, state: data.state });
    } else if (data.type === 'shot_event' && data.player_id !== session.client_id && data.event) {
      shots.push({ id: ++nextShotId, player_id: data.player_id, event: data.event });
      if (shots.length > 32) shots.shift();
    } else return;
    schedule();
  };

  function onWorkerMessage(data) {
    const message = data?.multiplayer;
    if (!message) return;
    if (message.type === 'memory') {
      shared = message;
      publish();
      channel.postMessage({ type: 'bridge_ready' });
      reportStatus({ phase: 'engine_ready' });
    } else if (message.type === 'shot_ack' && Array.isArray(message.ids)) {
      const consumed = new Set(message.ids);
      shots = shots.filter((shot) => !consumed.has(shot.id));
      schedule();
    } else if (message.type === 'local_state' || message.type === 'local_shot') {
      channel.postMessage(message);
    } else if (message.type === 'game_status') {
      const hud = document.getElementById('hud');
      if (hud) hud.textContent = message.role_loading ? '公共战局 · 正在加载在线角色…'
        : '公共战局 · 正在同步 ' + message.peer_count + ' 位其他玩家';
      reportStatus({ phase: message.role_loading ? 'loading_avatar' : 'synchronizing', peers: message.peer_count });
    } else if (message.type === 'bridge_error') {
      const hud = document.getElementById('hud');
      if (hud) { hud.textContent = '角色同步已暂停：' + message.message; hud.style.color = '#f96'; }
      reportStatus({ phase: 'error', message: message.message });
    }
  }

  channel.postMessage({ type: 'bridge_ready' });
  addEventListener('pagehide', () => {
    closed = true;
    clearTimeout(timer);
    channel.postMessage({ type: 'game_closed' });
    channel.close();
    crashes.close();
  }, { once: true });
  return { onWorkerMessage };
}
