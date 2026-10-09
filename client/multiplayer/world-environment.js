'use strict';
// 仅在合法脚本 owner 阶段应用服务端环境；不声明原生 GTA Online 会话已初始化。
self.createWorldEnvironmentBridge = function ({ ex, memory, post }) {
  let epoch = null, revision = 0, weatherBuffer = 0, weatherType = '', lastApply = -Infinity, transitionEnd = 0, lastWeatherApply = -Infinity;
  function reset() { epoch = null; revision = 0; weatherType = ''; lastApply = lastWeatherApply = -Infinity; transitionEnd = 0; }
  function update(packet, now) {
    const world = packet?.world, environment = world?.environment;
    if (!packet?.connected || !world?.ready || !environment || !Number.isFinite(now)) return false;
    if (epoch !== world.world_epoch) { reset(); epoch = world.world_epoch; }
    if (environment.revision < revision || now - lastApply < 250) return false;
    const clock = environment.clock, weather = environment.weather;
    if (!clock || !weather || !Number.isFinite(clock.rate) || clock.rate < 0 || clock.rate > 120
        || !/^(EXTRASUNNY|CLEAR|CLOUDS|OVERCAST|RAIN|THUNDER|CLEARING|SMOG|FOGGY)$/.test(weather.type)) return false;
    lastApply = now; revision = environment.revision;
    // 引擎本地时钟暂停，仅用服务器时间锚点加本机经过时长；暂停菜单不会推进各自的单机时钟。
    const nowEpoch = Number.isFinite(globalThis.performance?.timeOrigin) ? globalThis.performance.timeOrigin + now : 0;
    const elapsed = nowEpoch && world.environment_received_at_epoch
      ? Math.max(0, nowEpoch - world.environment_received_at_epoch)
      : Math.max(0, now - (Number.isFinite(world.environment_received_at) ? world.environment_received_at : now));
    const tick = (Number.isFinite(world.environment_server_tick) ? world.environment_server_tick : world.world_tick) + elapsed;
    const seconds = ((clock.hour * 3600 + clock.minute * 60 + clock.second
      + (clock.paused ? 0 : Math.max(0, tick - clock.anchor_tick) / 1000 * clock.rate)) % 86400 + 86400) % 86400;
    ex.mpPauseClock?.(1);
    ex.mpSetClockTime?.(Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, Math.floor(seconds) % 60);
    if (!weatherBuffer && ex.mpAlloc) weatherBuffer = Number(ex.mpAlloc(32n));
    if (weatherBuffer) {
      const bytes = new Uint8Array(memory.buffer, weatherBuffer, 32); bytes.fill(0);
      bytes.set(new TextEncoder().encode(weather.type));
      if (weatherType !== weather.type) {
        const remaining = Math.max(0, weather.anchor_tick + weather.transition_ms - tick);
        transitionEnd = now + remaining; ex.mpClearOverrideWeather?.();
        if (remaining > 0 && ex.mpWeatherOvertime) ex.mpWeatherOvertime(BigInt(weatherBuffer), remaining / 1000);
        else { ex.mpWeatherPersist?.(BigInt(weatherBuffer)); transitionEnd = now; }
        lastWeatherApply = now;
      } else if (now >= transitionEnd && now - lastWeatherApply >= 1000) {
        ex.mpClearOverrideWeather?.(); ex.mpWeatherPersist?.(BigInt(weatherBuffer)); lastWeatherApply = now;
      }
      ex.mpRain?.(weather.rain); ex.mpWind?.(weather.wind * 12);
    }
    // 本地 dispatch、随机警察与目击报案不能各自生成另一套战局。
    for (let service = 1; service <= 15; service++) ex.mpDispatchService?.(service, 0);
    ex.mpRandomCops?.(0); ex.mpRandomCopsNotScenarios?.(0); ex.mpRandomCopsScenarios?.(0);
    ex.mpAIWeaponDamage?.(0); ex.mpAIMeleeDamage?.(0);
    ex.mpPlayerWeaponDamage?.(ex.mpPlayerId(), 0); ex.mpPlayerMeleeDamage?.(ex.mpPlayerId(), 0, 1);
    ex.mpSuppressWitnesses?.(ex.mpPlayerId());
    const wanted = world.law?.players?.find((value) => value.player_id === packet.client_id);
    const stars = wanted?.stars || 0;
    const playerId = ex.mpPlayerId();
    if (ex.mpWantedLevel && ex.mpWantedLevel(playerId) !== stars) {
      if (!stars) ex.mpClearWanted?.(playerId);
      else { ex.mpSetWantedLevel?.(playerId, stars, 0); ex.mpSetWantedNow?.(playerId, 0); }
    }
    if (weatherType !== weather.type) {
      weatherType = weather.type;
      post?.({ type: 'world_environment_status', world_epoch: epoch, revision,
        weather: weatherType, hour: Math.floor(seconds / 3600), script_mode: 'server_rules' });
    }
    return true;
  }
  function suppressLocalDispatch(packet) {
    if (packet?.connected && packet.world?.ready && packet.world.environment) ex.mpSuppressWitnesses?.(ex.mpPlayerId());
  }
  return { update, reset, suppressLocalDispatch };
};
