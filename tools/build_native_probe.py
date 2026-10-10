#!/usr/bin/env python3
"""制作非生产的 native 探针 WASM 副本，不覆盖游戏引擎。

默认增加只读玩家/坐标/脚本上下文与分配器导出；--entity-probe 增加隔离实体实验导出。
--entity-probe --public-client 另生成公共战局副本，屏蔽单机脚本角色模型切换并增加暂停菜单前端回调。
在脚本线程安装活动上下文后插入回调。
此工具不会运行 WASM；生成文件仍需浏览器实际验证，不能据此声明多人同步可用。
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
from inspect_native_bridge import DEFAULT_WASM, ROOT, Reader, WasmAudit
from readonly_game_outputs import atomic_write_bytes, atomic_write_text, validate_outputs

ORIGINAL_SHA256 = "11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0"
HOOK_FUNCTION = 16953
HOOK_INSTRUCTION_START = 9966559
HOOK_INSTRUCTION_OFFSET = 108
MAGIC = 0x4D505442
FRONTEND_MAGIC = 0x4D505549
SCRIPT_GATE_MAGIC = 0x4D505343
FRONTEND_FUNCTION = 36291
FRONTEND_BODY_SHA256 = '77649c56f6a2303de1a31efd373ae4757fde6a95bf6e77d3cf33f8f1e6df3c63'
FRONTEND_TAIL = bytes.fromhex('20064280047c24000b')
CALLBACK_IMPORT = 11
PUBLIC_MODEL_WRAPPER = 58868
PUBLIC_MODEL_WRAPPER_NAME = "player_commands::SetupScriptCommands()::scrWrapped_SET_PLAYER_MODEL::Call(rage::scrThread::Info&)"
EXPECTED_MODEL_WRAPPER = bytes.fromhex("002000290310220028020020002802081081ca030b")
EXPECTED_RUN_PREFIX = bytes.fromhex(
    "031a7e0c7f067d230042f00b7d220521082005240042b0d6ac07200042ac037c2214370300"
    "2000280220221d417e714102470440200042c0017c210642a0d6ac07290300211a42a0d6ac07"
    "2000370300230122024298187c221b41013a000020024290187c2218290300211920182000370300"
)
ADDITIONAL_EXPORTS = {
    "mpGetPlayerPed": (58627, "player_commands::CommandGetPlayerPed(int)", ["i32"], ["i32"]),
    "mpGetEntityCoords": (50028, "entity_commands::CommandGetEntityCoords(int, bool)", ["i64", "i32", "i32"], []),
    "mpGetActiveThread": (16949, "rage::scrThread::GetActiveThread()", [], ["i64"]),
    "mpGetCurrentHandler": (63772, "CTheScripts::GetCurrentGtaScriptHandler()", [], ["i64"]),
    "mpAlloc": (91000, "emscripten_builtin_malloc", ["i64"], ["i64"]),
    "mpFree": (91002, "emscripten_builtin_free", ["i64"], []),
}
ENTITY_EXPORTS = {
    # 只在活动脚本上下文发起异步形状查询；不导出内部 phBound/WorldProbe 指针接口。
    # 输入 scrVector: f32 @0/8/16；结果 Vector3: f32 @0/4/8，但原实现写满16字节。
    # Get 返回 0=无效,1=待完成,2=完成并消费句柄；material 为名称 Jenkins hash。
    "mpStartShapeTestLOS": (59400, "shapetest_commands::CommandStartShapeTestLOSProbe(rage::scrVector const&, rage::scrVector const&, int, int, int)", ["i64", "i64", "i32", "i32", "i32"], ["i32"]),
    "mpStartShapeTestSweptSphere": (59407, "shapetest_commands::CommandStartShapeTestSweptSphere(rage::scrVector const&, rage::scrVector const&, float, int, int, int)", ["i64", "i64", "f32", "i32", "i32", "i32"], ["i32"]),
    "mpShapeTestResultMaterial": (59410, "shapetest_commands::CommandGetShapeTestResultIncludingMaterial(int, int&, rage::Vector3&, rage::Vector3&, int&, int&)", ["i32", "i64", "i64", "i64", "i64", "i64"], ["i32"]),
    "mpCollisionLoadedAroundEntity": (50141, "entity_commands::CommandHasCollisionLoadedAroundEntity(int)", ["i32"], ["i32"]),
    "mpWaitingForWorldCollision": (50087, "entity_commands::CommandIsEntityWaitingForWorldCollision(int)", ["i32"], ["i32"]),
    "mpModelDimensions": (52892, "misc_commands::CommandGetModelDimensions(int, rage::Vector3&, rage::Vector3&)", ["i32", "i64", "i64"], []),
    # 共同世界的时钟/天气仅由服务器基线驱动；采用单机安全命令，不伪造网络会话。
    # 服务端时钟先按 anchor_tick/rate 推算，再 PauseClock(true)+SetClockTime 应用。
    # 天气字符串为本 tick 内有效的 NUL 结尾 UTF-8；客户端只接受已校验的天气枚举。
    "mpSetClockTime": (49437, "clock_commands::CommandSetClockTime(int, int, int)", ["i32", "i32", "i32"], []),
    "mpPauseClock": (49443, "clock_commands::CommandPauseClock(bool)", ["i32"], []),
    "mpWeatherPersist": (52794, "misc_commands::CommandSetWeatherTypeNowPersist(char const*)", ["i64"], []),
    # duration 为秒；同一天气段只设置一次，重复调用会从当前状态重新开始过渡。
    "mpWeatherOvertime": (52796, "misc_commands::CommandSetWeatherTypeOvertimePersist(char const*, float)", ["i64", "f32"], []),
    "mpClearOverrideWeather": (52803, "misc_commands::CommandClearOverrideWeather()", [], []),
    "mpRain": (52824, "misc_commands::CommandSetRain(float)", ["f32"], []),
    "mpWind": (52820, "misc_commands::CommandSetWindSpeed(float)", ["f32"], []),
    # 禁止各客户端独立派出警察/救护等实体；真实警员由服务器实体与 AI 租约管理。
    # DispatchType 仅用经校验的 1..15，不调用内部 CDispatchService* 或重写其指针。
    "mpDispatchService": (52957, "misc_commands::CommandEnableDispatchService(int, bool)", ["i32", "i32"], []),
    "mpRandomCops": (57371, "ped_commands::CommandSetCreateRandomCops(bool)", ["i32"], []),
    "mpRandomCopsNotScenarios": (57372, "ped_commands::CommandSetCreateRandomCopsNotOnScenarios(bool)", ["i32"], []),
    "mpRandomCopsScenarios": (57373, "ped_commands::CommandSetCreateRandomCopsOnScenarios(bool)", ["i32"], []),
    # 星级是服务器 law 的显示投影；本地升星可报告，但客户端不能裁决共同通缉状态。
    # player index 来自 mpPlayerId；当前适配层仍保留真实单机 network flag，因此为 0。
    "mpWantedLevel": (58655, "player_commands::CommandGetPlayerWantedLevel(int)", ["i32"], ["i32"]),
    "mpSetWantedLevel": (58638, "player_commands::CommandAlterWantedLevel(int, int, bool)", ["i32", "i32", "i32"], []),
    "mpSetWantedNow": (58640, "player_commands::CommandApplyWantedLevelChangeNow(int, bool)", ["i32", "i32"], []),
    "mpClearWanted": (58646, "player_commands::CommandClearWantedLevel(int)", ["i32"], []),
    "mpSuppressWitnesses": (58680, "player_commands::CommandSuppressWitnessesCallingPoliceThisFrame(int)", ["i32"], []),
    # 仅服务器分配的当前模拟者可对已验证且仍存在的真实 NPC 句柄创建任务。
    # Combat 会产生真实本地 AI/物理伤害，不能用于远端玩家表现副本；伤害仍需服务器裁决。
    "mpTaskCombatPed": (60593, "task_commands::CommandTaskCombat(int, int, int, int)", ["i32", "i32", "i32", "i32"], []),
    "mpSetPedAsCop": (57350, "ped_commands::CommandSetPedAsCop(int, bool)", ["i32", "i32"], []),
    # AI 实弹/近战仅表现，由服务器裁决一次扣血；0 是合法值，原生实现直接写 f32。
    # 命令本身不校验 NaN 或负值，公共世界适配层只传常量 0；不影响玩家武器 modifier。
    "mpAIWeaponDamage": (57226, "ped_commands::SetAiWeaponDamageModifier(float)", ["f32"], []),
    "mpAIMeleeDamage": (57228, "ped_commands::SetAiMeleeWeaponDamageModifier(float)", ["f32"], []),
    "mpCachedMeleeInputs": (41719, "CPlayerInfo::GetCachedMeleeInputs(bool&, bool&)", ["i64", "i64"], []),
    "mpCreateVehicle": (61266, "vehicle_commands::CommandCreateVehicle(int, rage::scrVector const&, float, bool, bool, bool)", ["i32", "i64", "f32", "i32", "i32", "i32"], ["i32"]),
    "mpDeleteVehicle": (61267, "vehicle_commands::CommandDeleteVehicle(int&)", ["i64"], []),
    "mpGetQuaternion": (50044, "entity_commands::CommandGetEntityQuaternion(int, float&, float&, float&, float&)", ["i32", "i64", "i64", "i64", "i64"], []),
    "mpSetQuaternion": (50147, "entity_commands::CommandSetEntityQuaternion(int, float, float, float, float)", ["i32", "f32", "f32", "f32", "f32"], []),
    "mpGetVelocity": (50052, "entity_commands::CommandGetEntityVelocity(int)", ["i64", "i32"], []),
    "mpSetVelocity": (50154, "entity_commands::CommandSetEntityVelocity(int, rage::scrVector const&)", ["i32", "i64"], []),
    "mpGetAngularVelocity": (50047, "entity_commands::CommandGetEntityRotationVelocity(int)", ["i64", "i32"], []),
    "mpSetAngularVelocity": (50155, "entity_commands::CommandSetEntityAngularVelocity(int, rage::scrVector const&)", ["i32", "i64"], []),
    "mpGetVehiclePedIsIn": (57184, "ped_commands::CommandGetVehiclePedIsIn(int, bool)", ["i32", "i32"], ["i32"]),
    "mpGetPedInSeat": (61366, "vehicle_commands::CommandGetPedInVehicleSeat(int, int, bool)", ["i32", "i32", "i32"], ["i32"]),
    "mpSetPedIntoVehicle": (57201, "ped_commands::CommandSetPedIntoVehicle(int, int, int)", ["i32", "i32", "i32"], []),
    # 用 184/PreventAutoShuffleToDriversSeat 暂停自动换驾驶位，挂接解除时恢复原值。
    # 两者沿用原 native 的 GUID/flag 范围检查，不改写 CPed 内存布局或会话标志。
    "mpSetPedConfigFlag": (57558, "ped_commands::CommandSetPedConfigFlag(int, int, bool)", ["i32", "i32", "i32"], []),
    "mpGetPedConfigFlag": (57560, "ped_commands::CommandGetPedConfigFlag(int, int, bool)", ["i32", "i32", "i32"], ["i32"]),
    "mpTryingVehicle": (57306, "ped_commands::CommandGetVehiclePedIsTryingToEnter(int)", ["i32"], ["i32"]),
    "mpTryingSeat": (57305, "ped_commands::CommandGetSeatPedIsTryingToEnter(int)", ["i32"], ["i32"]),
    "mpLeaveVehicle": (60572, "task_commands::CommandTaskLeaveVehicle(int, int, int)", ["i32", "i32", "i32"], []),
    "mpIsArrested": (58711, "player_commands::CommandIsPlayerBeingArrested(int, bool)", ["i32", "i32"], ["i32"]),
    "mpMeleeAction": (57608, "ped_commands::CommandIsPedPeformingMeleeAction(int)", ["i32"], ["i32"]),
    "mpMeleeTarget": (57612, "ped_commands::CommandGetMeleeTargetForPed(int)", ["i32"], ["i32"]),
    # 单独播放原剪辑仅用于表现；不得使用真实战斗任务在本地再次产生伤害。
    # 字典/剪辑参数为 NUL 结尾 UTF-8 指针；Request/Play 必须在有效脚本 handler 上执行。
    "mpAnimDictExists": (60331, "streaming_commands::DoesAnimDictExist(char const*)", ["i64"], ["i32"]),
    "mpRequestAnimDict": (60332, "streaming_commands::RequestAnimDict(char const*)", ["i64"], []),
    "mpHasAnimDictLoaded": (60333, "streaming_commands::HasAnimDictLoaded(char const*)", ["i64"], ["i32"]),
    "mpTaskPlayAnim": (60617, "task_commands::CommandTaskPlayAnim(int, char const*, char const*, float, float, int, int, float, bool, int, bool)", ["i32", "i64", "i64", "f32", "f32", "i32", "i32", "f32", "i32", "i32", "i32"], []),
    "mpIsPlayingAnim": (50077, "entity_commands::CommandIsEntityPlayingAnim(int, char const*, char const*, int)", ["i32", "i64", "i64", "i32"], ["i32"]),
    "mpAnimTime": (50024, "entity_commands::CommandGetEntityAnimCurrentTime(int, char const*, char const*)", ["i32", "i64", "i64"], ["f32"]),
    "mpPedDensity": (57186, "ped_commands::CommandSetPedDensityMultiplierThisFrame(float)", ["f32"], []),
    "mpScenarioDensity": (57187, "ped_commands::CommandSetScenarioPedDensityMultiplierThisFrame(float, float)", ["f32", "f32"], []),
    "mpVehicleDensity": (61298, "vehicle_commands::CommandSetVehicleDensityMultiplierThisFrame(float)", ["f32"], []),
    "mpRandomVehicleDensity": (61299, "vehicle_commands::CommandSetRandomVehicleDensityMultiplierThisFrame(float)", ["f32"], []),
    "mpParkedVehicleDensity": (61300, "vehicle_commands::CommandSetParkedVehicleDensityMultiplierThisFrame(float)", ["f32"], []),
    "mpAllVehicles": (61943, "vehicle_commands::CommandGetAllVehicles(int&)", ["i64"], ["i32"]),
    "mpNearbyPeds": (57673, "ped_commands::CommandGetNearbyPeds(int, int&, int)", ["i32", "i64", "i32"], ["i32"]),
    "mpPopulationType": (50055, "entity_commands::CommandGetEntityPopulationType(int)", ["i32"], ["i32"]),
    "mpEngineHealth": (61599, "vehicle_commands::CommandGetVehicleEngineHealth(int)", ["i32"], ["f32"]),
    "mpBodyHealth": (61604, "vehicle_commands::CommandGetVehicleBodyHealth(int)", ["i32"], ["f32"]),
    "mpSetEngineHealth": (61600, "vehicle_commands::CommandSetVehicleEngineHealth(int, float)", ["i32", "f32"], []),
    "mpSetBodyHealth": (61605, "vehicle_commands::CommandSetVehicleBodyHealth(int, float)", ["i32", "f32"], []),
    "mpEngineRunning": (61653, "vehicle_commands::CommandGetIsVehicleEngineRunning(int)", ["i32"], ["i32"]),
    "mpSetEngineOn": (61505, "vehicle_commands::CommandSetVehicleEngineOn(int, bool, bool, bool)", ["i32", "i32", "i32", "i32"], []),
    "mpTaskWander": (60591, "task_commands::CommandTaskWanderStandard(int, float, int)", ["i32", "f32", "i32"], []),
    "mpDriveWander": (60576, "task_commands::CommandTaskVehicleDriveWander(int, int, float, int)", ["i32", "i32", "f32", "i32"], []),
    "mpFadeAfterDeath": (52752, "misc_commands::CommandSetFadeOutAfterDeath(bool)", ["i32"], []),
    "mpFadeAfterArrest": (52753, "misc_commands::CommandSetFadeOutAfterArrest(bool)", ["i32"], []),
    "mpFadeAfterRestart": (52754, "misc_commands::CommandSetFadeInAfterDeathArrest(bool)", ["i32"], []),
    # 只观察原同步树及脚本上下文是否初始化；getter 不解引用传入 this。
    "mpPedSyncTree": (88346, "CNetObjPed::GetSyncTree()", ["i64"], ["i64"]),
    "mpPlayerSyncTree": (88355, "CNetObjPlayer::GetSyncTree()", ["i64"], ["i64"]),
    "mpNetworkScriptHandler": (63797, "CTheScripts::GetCurrentGtaScriptHandlerNetwork()", [], ["i64"]),
    "mpForcePlaying": (18890, "CGameLogic::ForceStatePlaying()", [], []),
    "mpResurrectLocalPlayer": (54881, "network_commands::CommandNetworkResurrectLocalPlayer(rage::scrVector const&, float, int, bool, bool, int, int)", ["i64", "f32", "i32", "i32", "i32", "i32", "i32"], []),
    "mpPauseDeathRestart": (52750, "misc_commands::CommandPauseDeathArrestRestart(bool)", ["i32"], []),
    "mpScreenFadeIn": (49036, "camera_commands::CommandDoScreenFadeIn(int)", ["i32"], []),
    "mpIsScreenFadedOut": (49034, "camera_commands::CommandIsScreenFadedOut()", [], ["i32"]),
    "mpScreenFadeOut": (49037, "camera_commands::CommandDoScreenFadeOut(int)", ["i32"], []),
    "mpIsScreenFadedIn": (49035, "camera_commands::CommandIsScreenFadedIn()", [], ["i32"]),
    # 入局镜头只拥有 CreateCam 返回的相机；创建/操作/释放限于同一有效脚本 handler。
    # CreateCam 的类型名为 NUL 结尾 UTF-8；创建失败返回 -1，0 仍是合法候选句柄。
    # DestroyCam 的第二参数必须为 false，true 会跨 handler 全局移除脚本资源。
    "mpCreateCam": (48924, "camera_commands::CommandCreateCam(char const*, bool)", ["i64", "i32"], ["i32"]),
    "mpDestroyCam": (48928, "camera_commands::CommandDestroyCam(int, bool)", ["i32", "i32"], []),
    "mpDoesCamExist": (48930, "camera_commands::CommandDoesCamExist(int)", ["i32"], ["i32"]),
    "mpSetCamActive": (48931, "camera_commands::CommandSetCamActive(int, bool)", ["i32", "i32"], []),
    "mpIsCamActive": (48932, "camera_commands::CommandIsCamActive(int)", ["i32"], ["i32"]),
    "mpIsCamRendering": (48933, "camera_commands::CommandIsCamRendering(int)", ["i32"], ["i32"]),
    "mpGetRenderingCam": (48934, "camera_commands::CommandGetRenderingCam()", [], ["i32"]),
    # Coord/Rot 的 scrVector 输入及 mpCamCoords/mpCamRot 输出均为 f32 @0/8/16。
    # 旋转单位为度，order 必须与 mpCamRot 读取时相同；setter 会取消该相机的原生插值。
    "mpSetCamCoord": (48944, "camera_commands::CommandSetCamCoord(int, rage::scrVector const&)", ["i32", "i64"], []),
    "mpSetCamRot": (48945, "camera_commands::CommandSetCamRotation(int, rage::scrVector const&, int)", ["i32", "i64", "i32"], []),
    "mpSetCamFov": (48946, "camera_commands::CommandSetCamFov(int, float)", ["i32", "f32"], []),
    "mpCamFov": (49042, "camera_commands::CommandGetGameplayCamFov()", [], ["f32"]),
    # 第五参数控制 ForceStopRendering，入局流程固定 false，并先核对当前渲染相机。
    # 不导出 DestroyAllCams、StartPlayerSwitch 或全局流式场景接管。
    "mpRenderScriptCams": (48922, "camera_commands::CommandRenderScriptCams(bool, bool, int, bool, bool, int)", ["i32", "i32", "i32", "i32", "i32", "i32"], []),
    # 原云帽是全局 script override，不属于相机或 handler。仅公共原脚本 VM 已全部隔离、
    # 只读确认 manager scriptIndex==-1 后可临时加载；释放前必须再次核对 manager/index。
    # Unload(name) 只确认名称存在，并非当前 override==name；它清除 override 并恢复天气云帽。
    # 已审计布局：u64 manager* @28411080；+40 u64 items、+48 u16 count、
    # +1856 i32 weatherIndex、+1860 i32 scriptIndex；item stride512，+64为内联C字符串[64]。
    # 不直接写这些字段，不导出 UnloadAll、SetAlpha 或缺少成对取消接口的 Preload。
    "mpLoadCloudHat": (52831, "misc_commands::CommandLoadCloudHat(char const*, float)", ["i64", "f32"], []),
    "mpUnloadCloudHat": (52832, "misc_commands::CommandUnloadCloudHat(char const*, float)", ["i64", "f32"], []),
    "mpGetCloudHatAlpha": (52835, "misc_commands::CommandGetCloudHatAlpha()", [], ["f32"]),
    # 原角色长距离切换的下降 Hit_2 音效；指针指向 u32 hash，team=0 使用原默认音效集。
    # 原函数仅提交有限 batched cue；不启动天空循环、不分配持久 sound ID。
    "mpPlayLongSwitchSound": (22863, "audFrontendAudioEntity::TriggerLongSwitchSound(rage::atNonFinalHashString, eArcadeTeam)", ["i64", "i32"], []),
    "mpSetPlayerControl": (58654, "player_commands::CommandSetPlayerControl(int, bool, int)", ["i32", "i32", "i32"], []),
    "mpTaskStandStill": (60564, "task_commands::CommandTaskStandStill(int, int)", ["i32", "i32"], []),
    "mpTaskGoStraight": (60577, "task_commands::CommandTaskGoStraightToCoord(int, rage::scrVector const&, float, int, float, float)", ["i32", "i64", "f32", "i32", "f32", "f32"], []),
    "mpGetModel": (50040, "entity_commands::CommandGetEntityModel(int)", ["i32"], ["i32"]),
    "mpHeading": (50032, "entity_commands::CommandGetEntityHeading(int)", ["i32"], ["f32"]),
    "mpCreatePed": (57110, "ped_commands::CommandCreatePed(int, int, rage::scrVector const&, float, bool, bool)", ["i32", "i32", "i64", "f32", "i32", "i32"], ["i32"]),
    "mpSetCoords": (50131, "entity_commands::CommandSetEntityCoords(int, rage::scrVector const&, bool, bool, bool, bool)", ["i32", "i64", "i32", "i32", "i32", "i32"], []),
    "mpSetHeading": (50135, "entity_commands::CommandSetEntityHeading(int, float)", ["i32", "f32"], []),
    "mpSetCollision": (50128, "entity_commands::CommandSetEntityCollision(int, bool, bool)", ["i32", "i32", "i32"], []),
    "mpSetInvincible": (50137, "entity_commands::CommandSetEntityInvincible(int, bool)", ["i32", "i32"], []),
    # 活跃远端副本不由本地物理决定倒地；服务端死亡前重新开启 ragdoll。
    "mpSetCanRagdoll": (57471, "ped_commands::CommandSetPedCanRagdoll(int, bool)", ["i32", "i32"], []),
    "mpIsRagdoll": (57464, "ped_commands::CommandIsPedRagdoll(int)", ["i32"], ["i32"]),
    "mpBlockEvents": (57447, "ped_commands::CommandSetBlockingOfNonTemporaryEvents(int, bool)", ["i32", "i32"], []),
    "mpDeleteEntity": (50100, "entity_commands::CommandDeleteEntity(int&)", ["i64"], []),
    "mpDeletePed": (57115, "ped_commands::CommandDeletePed(int&)", ["i64"], []),
    "mpExists": (50006, "entity_commands::CommandDoesEntityExist(int)", ["i32"], ["i32"]),
    "mpSetCoordsNoOffset": (50133, "entity_commands::CommandSetEntityCoordsNoOffset(int, rage::scrVector const&, bool, bool, bool)", ["i32", "i64", "i32", "i32", "i32"], []),
    "mpFreeze": (50102, "entity_commands::CommandFreezeEntityPosition(int, bool)", ["i32", "i32"], []),
    "mpGetHealth": (50034, "entity_commands::CommandGetEntityHealth(int)", ["i32"], ["i32"]),
    "mpSetHealth": (50136, "entity_commands::CommandSetEntityHealth(int, int, int)", ["i32", "i32", "i32"], []),
    "mpIsDead": (50068, "entity_commands::CommandIsEntityDead(int, bool)", ["i32", "i32"], ["i32"]),
    "mpIsShooting": (57158, "ped_commands::CommandIsPedShooting(int)", ["i32"], ["i32"]),
    "mpSelectedWeapon": (62955, "weapon_commands::CommandGetSelectedPedWeapon(int)", ["i32"], ["i32"]),
    "mpGetCurrentPedWeapon": (62918, "weapon_commands::CommandGetCurrentPedWeapon(int, int&, bool)", ["i32", "i64", "i32"], ["i32"]),
    "mpGetAmmoInClip": (62942, "weapon_commands::CommandGetAmmoInClip(int, int, int&)", ["i32", "i32", "i64"], ["i32"]),
    "mpGetAmmo": (62929, "weapon_commands::CommandGetAmmoInPedWeapon(int, int)", ["i32", "i32"], ["i32"]),
    "mpControlJustPressed": (56846, "pad_commands::CommandIsControlJustPressed(int, int)", ["i32", "i32"], ["i32"]),
    "mpSetProofs": (50145, "entity_commands::CommandSetEntityProofs(int, bool, bool, bool, bool, bool, bool, bool, bool)", ["i32"] * 9, []),
    "mpPlayerWeaponDamage": (58802, "player_commands::CommandSetPlayerWeaponDamageModifier(int, float)", ["i32", "f32"], []),
    "mpPlayerMeleeDamage": (58805, "player_commands::CommandSetPlayerMeleeWeaponDamageModifier(int, float, bool)", ["i32", "f32", "i32"], []),
    "mpDriveToCoord": (60575, "task_commands::CommandTaskVehicleDriveToCoordLongRange(int, int, rage::scrVector const&, float, int, float)", ["i32", "i32", "i64", "f32", "i32", "f32"], []),
    "mpVisualExplosion": (50437, "fire_commands::CommandAddExplosion(rage::scrVector const&, int, float, bool, bool, float, bool)", ["i64", "i32", "f32", "i32", "i32", "f32", "i32"], []),
    "mpDrawSphere": (50518, "graphics_commands::CommandDrawMarkerSphere(rage::scrVector const&, float, int, int, int, float)", ["i64", "f32", "i32", "i32", "i32", "f32"], []),
    # Shared effects use ordinary model markers, not the fullscreen-glow sphere
    # above. Type 28 is PROP_MK_SPHERE in CMarkers::Init; scrVector uses 0/8/16.
    # CMarkers::Register has 128 slots: budget markers once per game frame.
    "mpDrawMarker": (50517, "graphics_commands::CommandDrawMarker(int, rage::scrVector const&, rage::scrVector const&, rage::scrVector const&, rage::scrVector const&, int, int, int, int, bool, bool, int, bool, char const*, char const*, bool)", ["i32", "i64", "i64", "i64", "i64", "i32", "i32", "i32", "i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32"], []),
    # Same global frame counter read by the original GET_FRAME_COUNT wrapper.
    "mpFrameCount": (91, "GetGameFrame()", [], ["i32"]),
    # 视觉弹起点沿真实武器对象的 gun_muzzle 获取；名字查询前须确认 BoneCount > 0。
    # 未就绪返回 0/-1/零向量；输出和 PedBoneCoords 的偏移都是 0/8/16 的 scrVector。
    "mpCurrentWeaponEntity": (62919, "weapon_commands::CommandGetCurrentPedWeaponEntityIndex(int, bool)", ["i32", "i32"], ["i32"]),
    "mpEntityBoneCount": (50191, "entity_commands::CommandGetEntityBoneCount(int)", ["i32"], ["i32"]),
    "mpEntityBoneIndexByName": (50098, "entity_commands::CommandGetEntityBoneIndexByName(int, char const*)", ["i32", "i64"], ["i32"]),
    "mpWorldPositionOfEntityBone": (50053, "entity_commands::CommandGetWorldPositionOfEntityBone(int, int)", ["i64", "i32", "i32"], []),
    "mpPedBoneCoords": (57514, "ped_commands::CommandGetPedBoneCoords(int, int, rage::scrVector const&)", ["i64", "i32", "i32", "i64"], []),
    # 此接口输出 rage::Vector3（f32 位于 0/4/8），不能按 scrVector 的 0/8/16 读取。
    "mpLastWeaponImpact": (62953, "weapon_commands::CommandGetPedLastWeaponImpactCoord(int, rage::Vector3&)", ["i32", "i64"], ["i32"]),
    "mpIsAiming": (58689, "player_commands::CommandIsPlayerFreeAiming(int)", ["i32"], ["i32"]),
    "mpIsReloading": (57122, "ped_commands::CommandIsPedReloading(int)", ["i32"], ["i32"]),
    "mpIsJumping": (57240, "ped_commands::CommandIsPedJumping(int)", ["i32"], ["i32"]),
    "mpIsDucking": (57259, "ped_commands::CommandIsPedDucking(int)", ["i32"], ["i32"]),
    "mpSetDucking": (57258, "ped_commands::CommandSetPedDucking(int, bool)", ["i32", "i32"], []),
    "mpIsSprinting": (60839, "task_commands::CommandPedIsSprinting(int)", ["i32"], ["i32"]),
    "mpGiveWeapon": (62910, "weapon_commands::CommandGiveWeaponToPed(int, int, int, bool, bool)", ["i32", "i32", "i32", "i32", "i32"], []),
    "mpSetCurrentWeapon": (62917, "weapon_commands::CommandSetCurrentPedWeapon(int, int, bool)", ["i32", "i32", "i32"], []),
    "mpTaskShootAtCoord": (60656, "task_commands::CommandTaskShootAtCoord(int, rage::scrVector const&, int, int)", ["i32", "i64", "i32", "i32"], []),
    "mpTaskAimGunAtCoord": (60655, "task_commands::CommandTaskAimGunAtCoord(int, rage::scrVector const&, int, bool, bool)", ["i32", "i64", "i32", "i32", "i32"], []),
    "mpTaskReloadWeapon": (60785, "task_commands::CommandTaskReloadWeapon(int, bool)", ["i32", "i32"], []),
    # 原 C++ ABI 是四参，脚本包装器不提供两参默认值；后两个布尔值选择跳跃任务 flags。
    "mpTaskJump": (60565, "task_commands::CommandTaskJump(int, bool, bool, bool)", ["i32", "i32", "i32", "i32"], []),
    "mpCamCoords": (49040, "camera_commands::CommandGetGameplayCamCoord()", ["i64"], []),
    "mpCamRot": (49041, "camera_commands::CommandGetGameplayCamRot(int)", ["i64", "i32"], []),
    "mpRequestModel": (60322, "streaming_commands::CommandRequestModel(int)", ["i32"], []),
    "mpHasModel": (60324, "streaming_commands::HasModelLoaded(int)", ["i32"], ["i32"]),
    "mpAddBlipForEntity": (51603, "hud_commands::AddBlipForEntity(int)", ["i32"], ["i32"]),
    # 句柄可能被脚本清理；先验证仍存在，再恢复地图/雷达显示与透明度。
    # 仅传入 AddBlip 返回的真实句柄；调用仍限于已就绪的游戏/脚本 tick。
    "mpDoesBlipExist": (51693, "hud_commands::CommandDoesBlipExist(int)", ["i32"], ["i32"]),
    "mpSetBlipDisplay": (51661, "hud_commands::CommandChangeBlipDisplay(int, int)", ["i32", "i32"], []),
    "mpSetBlipAlpha": (51625, "hud_commands::ChangeBlipAlpha(int, int)", ["i32", "i32"], []),
    "mpSetBlipColour": (51623, "hud_commands::ChangeBlipColour(int, int)", ["i32", "i32"], []),
    "mpSetBlipSprite": (51664, "hud_commands::CommandSetBlipSprite(int, int)", ["i32", "i32"], []),
    "mpSetBlipScale": (51659, "hud_commands::CommandChangeBlipScale(int, float)", ["i32", "f32"], []),
    "mpSetBlipAsShortRange": (51652, "hud_commands::CommandSetBlipAsShortRange(int, bool)", ["i32", "i32"], []),
    "mpRemoveBlip": (51667, "hud_commands::CommandRemoveBlip(int&)", ["i64"], []),
    "mpBeginSetBlipName": (51491, "hud_commands::CommandBeginTextCommandSetBlipName(char const*)", ["i64"], []),
    "mpAddTextPlayerSubstring": (51504, "hud_commands::CommandAddTextComponentSubStringPlayerName(char const*)", ["i64"], []),
    "mpEndSetBlipName": (51492, "hud_commands::CommandEndTextCommandSetBlipName(int)", ["i32"], []),
    # 通知沿用原生文字构造：Begin("STRING")、AddTextPlayerSubstring(正文)、EndTicker(blink, brief)。
    # 两个字符串均为当前 WASM 内存中 NUL 结尾的 UTF-8，三个调用须在同一有效脚本上下文完成。
    "mpBeginTheFeedPost": (51457, "hud_commands::CommandBeginTheFeedPost(char const*)", ["i64"], []),
    "mpEndTheFeedPostTicker": (51464, "hud_commands::CommandEndTheFeedPostTicker(bool, bool)", ["i32", "i32"], ["i32"]),
    # 仅覆盖已打开的原生暂停菜单表现，不伪造原网络 flag/session 或切换到原 MP 菜单。
    # Begin 返回 true 后同一脚本 tick 连续 Add/End；字符串为 NUL 结尾 UTF-8。
    "mpPauseMenuActive": (51840, "hud_commands::CommandIsPauseMenuActive()", [], ["i32"]),
    "mpDisplayHud": (51542, "hud_commands::CommandDisplayHud(bool)", ["i32"], []),
    "mpDisplayRadar": (51610, "hud_commands::CommandDisplayRadar(bool)", ["i32"], []),
    "mpIsRadarHidden": (51614, "hud_commands::CommandIsRadarHidden()", [], ["i32"]),
    "mpIsMinimapRendering": (51615, "hud_commands::CommandIsMiniMapRendering()", [], ["i32"]),
    "mpHudPreference": (51539, "hud_commands::CommandIsHudPreferenceSwitchedOn()", [], ["i32"]),
    "mpRadarPreference": (51540, "hud_commands::CommandIsRadarPreferenceSwitchedOn()", [], ["i32"]),
    "mpMinimapHideFog": (51755, "hud_commands::CommandSetMinimapHideFoW(bool)", ["i32"], []),
    "mpMinimapPrologue": (51761, "hud_commands::CommandSetMiniMapInPrologue(bool)", ["i32"], []),
    "mpUnlockMinimapAngle": (51765, "hud_commands::CommandUnlockMiniMapAngle()", [], []),
    "mpUnlockMinimapPosition": (51767, "hud_commands::CommandUnlockMiniMapPosition()", [], []),
    # This command exists only as a script wrapper. Its argument is Info*, not bool:
    # Info+16 points to the caller-owned argument array; first i32 is hidden.
    "mpMinimapBackgroundInfo": (52350, "hud_commands::SetupScriptCommands()::scrWrapped_SET_MINIMAP_BACKGROUND_HIDDEN::Call(rage::scrThread::Info&)", ["i64"], []),
    "mpFrontendReady": (51856, "hud_commands::CommandIsFrontendReadyForControl()", [], ["i32"]),
    "mpBeginPauseHeader": (50805, "graphics_commands::CommandBeginScaleformMovieMethodOnFrontendHeader(char const*)", ["i64"], ["i32"]),
    # MenuScreenId 是四字节返回结构，首 i64 指向本调用者分配的输出槽；不得传假 CMenuScreen*。
    # 先确认菜单就绪，再读取真实当前 pane 名，只给 XML 的 PauseMenu_Multiplayer 页写正文。
    "mpGetPausePanel": (36266, "CPauseMenu::GetCurrentActivePanel()", ["i64"], []),
    "mpPausePanelName": (35600, "MenuScreenId::GetParserName() const", ["i64"], ["i64"]),
    "mpBeginPauseContent": (50804, "graphics_commands::CommandBeginScaleformMovieMethodOnFrontend(char const*)", ["i64"], ["i32"]),
    "mpScaleformString": (50818, "graphics_commands::CommandScaleformMovieMethodAddParamLiteralString(char const*)", ["i64"], []),
    "mpScaleformBool": (50814, "graphics_commands::CommandScaleformMovieMethodAddParamBool(bool)", ["i32"], []),
    "mpScaleformInt": (50812, "graphics_commands::CommandScaleformMovieMethodAddParamInt(int)", ["i32"], []),
    "mpEndScaleform": (50806, "graphics_commands::CommandEndScaleformMovieMethod()", [], []),
    "mpSetPlayerModel": (58625, "player_commands::CommandChangePlayerModel(int, int)", ["i32", "i32"], []),
    "mpPlayerId": (58714, "player_commands::CommandPlayerId()", [], ["i32"]),
    "mpDefaultVariation": (57395, "ped_commands::CommandSetPedDefaultComponentVariation(int)", ["i32"], []),
    "mpGetDrawable": (57381, "ped_commands::CommandGetPedDrawableVariation(int, int)", ["i32", "i32"], ["i32"]),
    "mpGetTexture": (57384, "ped_commands::CommandGetPedTextureVariation(int, int)", ["i32", "i32"], ["i32"]),
    "mpGetPalette": (57387, "ped_commands::CommandGetPedPaletteVariation(int, int)", ["i32", "i32"], ["i32"]),
    "mpSetComponent": (57392, "ped_commands::CommandSetPedComponentVariation(int, int, int, int, int)", ["i32", "i32", "i32", "i32", "i32"], []),
    "mpRandomComponents": (57393, "ped_commands::CommandSetPedRandomComponentVariation(int, int)", ["i32", "i32"], []),
    "mpRandomProps": (57394, "ped_commands::CommandSetPedRandomProps(int)", ["i32"], []),
    "mpSetHeadOverlay": (57402, "ped_commands::CommandSetPedHeadOverlay(int, int, int, float)", ["i32", "i32", "i32", "f32"], []),
    "mpHeadOverlayCount": (57404, "ped_commands::CommandGetPedHeadOverlayNum(int)", ["i32"], ["i32"]),
    "mpSetOverlayTint": (57405, "ped_commands::CommandSetPedHeadOverlayTint(int, int, int, int, int)", ["i32", "i32", "i32", "i32", "i32"], []),
    "mpSetHairTint": (57406, "ped_commands::CommandSetPedHairTint(int, int, int)", ["i32", "i32", "i32"], []),
    "mpGetPropIndex": (57435, "ped_commands::CommandGetPedPropIndex(int, int)", ["i32", "i32"], ["i32"]),
    "mpGetPropTextureIndex": (57438, "ped_commands::CommandGetPropTextureIndex(int, int)", ["i32", "i32"], ["i32"]),
    "mpSetProp": (57436, "ped_commands::CommandSetPedPropIndex(int, int, int, int, bool)", ["i32", "i32", "i32", "i32", "i32"], []),
    "mpClearProp": (57439, "ped_commands::CommandClearPedProp(int, int)", ["i32", "i32"], []),
    "mpDrawableCount": (57383, "ped_commands::CommandGetNumberOfPedDrawableVariations(int, int)", ["i32", "i32"], ["i32"]),
    "mpTextureCount": (57385, "ped_commands::CommandGetNumberOfPedTextureVariations(int, int, int)", ["i32", "i32", "i32"], ["i32"]),
    # 标准单发子弹函数沿用脚本包装器的八个默认尾参数；远端视觉弹必须传 damage=0。
    "mpShootBullet": (52891, "misc_commands::CommandFireSingleBullet(rage::scrVector const&, rage::scrVector const&, int, bool, int, int, bool, bool, float)", ["i64", "i64", "i32", "i32", "i32", "i32", "i32", "i32", "f32"], []),
    "mpRevive": (57485, "ped_commands::CommandReviveInjuredPed(int)", ["i32"], []),
    "mpResurrect": (57486, "ped_commands::CommandResurrectPed(int)", ["i32"], []),
    "mpClearTasksImmediately": (60722, "task_commands::CommandClearPedTasksImmediately(int)", ["i32"], []),
    "mpRequestWeaponAsset": (62968, "weapon_commands::RequestWeaponAsset(int, int, int)", ["i32", "i32", "i32"], []),
    "mpHasWeaponAsset": (62969, "weapon_commands::HasWeaponAssetLoaded(int)", ["i32"], ["i32"]),
}


def export_map(entity_probe: bool = False):
    return {**ADDITIONAL_EXPORTS, **(ENTITY_EXPORTS if entity_probe else {})}


def unsigned_leb(value: int) -> bytes:
    if value < 0:
        raise ValueError("无符号 LEB 不能编码负数")
    result = bytearray()
    while True:
        byte, value = value & 127, value >> 7
        result.append(byte | (128 if value else 0))
        if not value:
            return bytes(result)


def signed_leb(value: int) -> bytes:
    result = bytearray()
    while True:
        byte, value = value & 127, value >> 7
        done = (value == 0 and not byte & 64) or (value == -1 and bool(byte & 64))
        result.append(byte if done else byte | 128)
        if done:
            return bytes(result)


def encoded_name(value: str) -> bytes:
    value_bytes = value.encode("utf-8")
    return unsigned_leb(len(value_bytes)) + value_bytes


def checked_public_wrapper(audit: WasmAudit):
    descriptor = audit.descriptor(PUBLIC_MODEL_WRAPPER)
    if descriptor["name"] != PUBLIC_MODEL_WRAPPER_NAME or descriptor["signature"] != {"parameters": ["i64"], "results": []}:
        raise ValueError("单机 SET_PLAYER_MODEL 包装器的函数名称或 ABI 不匹配")
    start, end = audit.bodies[PUBLIC_MODEL_WRAPPER]
    if audit.data[start:end] != EXPECTED_MODEL_WRAPPER:
        raise ValueError("单机 SET_PLAYER_MODEL 包装器的原始函数体不匹配，拒绝屏蔽")
    return start, end


def checked_frontend_tail(audit: WasmAudit):
    descriptor = audit.descriptor(FRONTEND_FUNCTION)
    start, end = audit.bodies[FRONTEND_FUNCTION]
    if (descriptor['name'] != 'CPauseMenu::Update()' or descriptor['signature'] != {'parameters': [], 'results': []}
            or hashlib.sha256(audit.data[start:end]).hexdigest() != FRONTEND_BODY_SHA256
            or audit.data[end - len(FRONTEND_TAIL):end] != FRONTEND_TAIL):
        raise ValueError('暂停菜单更新函数或正常尾部字节不同，拒绝插入前端回调')
    # 已完成原 Scaleform 更新且恢复栈指针之前，无对象指针作为回调参数。
    return end - len(FRONTEND_TAIL)


def checked_audit(path: Path, entity_probe: bool = False, public_client: bool = False) -> WasmAudit:
    if public_client and not entity_probe:
        raise ValueError("公共战局副本必须同时启用实体实验接口")
    audit = WasmAudit(path)
    digest = hashlib.sha256(audit.data).hexdigest()
    if digest != ORIGINAL_SHA256:
        raise ValueError(f"原引擎 SHA256 不匹配，拒绝修改：{digest}")
    for export, (index, expected_name, parameters, results) in export_map(entity_probe).items():
        descriptor = audit.descriptor(index)
        if descriptor["name"] != expected_name or descriptor["signature"] != {"parameters": parameters, "results": results}:
            raise ValueError(f"导出 {export} 对应函数或 ABI 不匹配")
    callback = audit.descriptor(CALLBACK_IMPORT)
    if callback["name"] != "wasm_module_int_js" or callback["signature"] != {"parameters": ["i64", "i32"], "results": ["i32"]}:
        raise ValueError("现有 JavaScript 回调导入不匹配")
    if audit.names.get(HOOK_FUNCTION) != "rage::scrThread::Run(int)":
        raise ValueError("目标脚本运行函数名称不匹配")
    decoded = audit.instructions(HOOK_FUNCTION)
    if not decoded["decode_complete"] or decoded["instruction_start"] != HOOK_INSTRUCTION_START:
        raise ValueError("目标函数未完整解码，或指令起点不同")
    hook_position = HOOK_INSTRUCTION_START + HOOK_INSTRUCTION_OFFSET
    body_start, _ = audit.bodies[HOOK_FUNCTION]
    if audit.data[body_start:hook_position] != EXPECTED_RUN_PREFIX:
        raise ValueError("脚本线程前置字节不同；无法确认已安装活动线程，拒绝插入回调")
    before = next((instruction for instruction in decoded["instructions"] if instruction["instruction_offset"] == 105), None)
    after = next((instruction for instruction in decoded["instructions"] if instruction["instruction_offset"] == 108), None)
    if not before or before["operation"] != "i64.store" or before.get("memory", {}).get("offset") != 0 or not after or after["operation"] != "block":
        raise ValueError("hook 前后的 TLS 写入和指令边界不匹配")
    if public_client:
        checked_public_wrapper(audit)
        checked_frontend_tail(audit)
        # 在已验证的外层block内跳过VM，仍落入原TLS/active-thread恢复尾部。
        gates = {op['instruction_offset']: op for op in decoded['instructions']}
        if (gates[108]['operation'] != 'block' or gates[32868]['operation'] != 'end'
                or gates[32869]['operation'] != 'local.get' or gates[32869].get('index') != 24
                or gates[32873]['operation'] != 'i64.store'):
            raise ValueError('脚本隔离跳转与TLS恢复边界不匹配')
    return audit


def build(audit: WasmAudit, entity_probe: bool = False, public_client: bool = False):
    if public_client and not entity_probe:
        raise ValueError("公共战局副本必须同时启用实体实验接口")
    if public_client:
        checked_public_wrapper(audit)
        frontend_position = checked_frontend_tail(audit)
    data = audit.data
    exports = export_map(entity_probe)
    hook_position = HOOK_INSTRUCTION_START + HOOK_INSTRUCTION_OFFSET
    # local.get 0；i32.const MAGIC；call 11；drop。沿用已有导入，不移动函数索引。
    hook_bytes = b"\x20\x00\x41" + signed_leb(MAGIC) + b"\x10" + unsigned_leb(CALLBACK_IMPORT) + b"\x1a"
    # 回调只返回是否冻结此轮已审计脚本，br_if 0跳到原block末尾，不中断资源清理。
    script_gate = b'\x20\x00\x41' + signed_leb(SCRIPT_GATE_MAGIC) + b'\x10' + unsigned_leb(CALLBACK_IMPORT) + b'\x0d\x00'
    if public_client:
        hook_position += 2  # 已核对的原block头后，一次插入桥回调与条件gate。
        hook_bytes += script_gate
    frontend_bytes = b'\x42\x00\x41' + signed_leb(FRONTEND_MAGIC) + b'\x10' + unsigned_leb(CALLBACK_IMPORT) + b'\x1a'
    source = Reader(data, 8)
    output = bytearray(data[:8])
    export_section_seen, code_section_seen, patched_bodies = False, False, 0
    unchanged_sections = []
    while source.pos < source.end:
        section_start = source.pos
        kind, size = source.byte(), source.leb()
        payload_start, payload_end = source.pos, source.pos + size
        payload = data[payload_start:payload_end]
        if kind == 7:
            export_section_seen = True
            reader = Reader(payload)
            count = reader.leb()
            entries = payload[reader.pos:]
            existing_names = []
            for _ in range(count):
                existing_names.append(reader.string())
                reader.byte()
                reader.leb()
            if reader.pos != reader.end or set(existing_names).intersection(exports):
                raise ValueError("原导出节有冲突或尾部数据")
            additions = b"".join(encoded_name(name) + b"\x00" + unsigned_leb(value[0]) for name, value in exports.items())
            payload = unsigned_leb(count + len(exports)) + entries + additions
        elif kind == 10:
            code_section_seen = True
            reader = Reader(data, payload_start, payload_end)
            count = reader.leb()
            result = bytearray(data[payload_start:reader.pos])
            for index in range(audit.import_count, audit.import_count + count):
                entry_start = reader.pos
                body_size = reader.leb()
                body_start, body_end = reader.pos, reader.pos + body_size
                if index == HOOK_FUNCTION:
                    if not body_start < hook_position < body_end:
                        raise ValueError("hook 没有落在预期函数体内")
                    body = data[body_start:hook_position] + hook_bytes + data[hook_position:body_end]
                    result.extend(unsigned_leb(len(body)) + body)
                    patched_bodies += 1
                elif public_client and index == PUBLIC_MODEL_WRAPPER:
                    # 脚本调用经包装器；JS 的 mpSetPlayerModel 直接调用 58625，仍可设置公共角色。
                    # void 包装器改为等长 nop；不更改函数索引、该包装器长度或另一个 CHANGE_PLAYER_PED 包装器。
                    body = b"\x00" + b"\x01" * (len(EXPECTED_MODEL_WRAPPER) - 2) + b"\x0b"
                    if body_size != len(body):
                        raise ValueError("单机角色包装器体长度不匹配")
                    result.extend(data[entry_start:body_start] + body)
                    patched_bodies += 1
                elif public_client and index == FRONTEND_FUNCTION:
                    body = data[body_start:frontend_position] + frontend_bytes + data[frontend_position:body_end]
                    result.extend(unsigned_leb(len(body)) + body)
                    patched_bodies += 1
                else:
                    result.extend(data[entry_start:body_end])
                reader.take(body_size)
            if reader.pos != reader.end:
                raise ValueError("代码节有未解析尾部数据")
            payload = bytes(result)
        else:
            unchanged_sections.append({"section_id": kind, "payload_bytes": size, "sha256": hashlib.sha256(payload).hexdigest()})
        if kind in (7, 10):
            output.extend(bytes((kind,)) + unsigned_leb(len(payload)) + payload)
        else:
            output.extend(data[section_start:payload_end])
        source.take(size)
    expected_patch_count = 3 if public_client else 1
    if not export_section_seen or not code_section_seen or patched_bodies != expected_patch_count:
        raise ValueError("预期导出节/代码节/目标函数体未全部匹配")
    evidence = {
        "purpose": ("公共战局引擎副本：增加实体接口、隔离单机脚本 SET_PLAYER_MODEL 包装器与原生暂停菜单前端回调；不伪造原网络会话。" if public_client else "非生产实体复制实验：增加本地角色创建/属性/坐标/销毁接口，尚未证明实际游戏操作成功。" if entity_probe else "非生产只读探针：读取本地玩家、坐标和活动脚本上下文；未加入创建角色或写入实体的接口。"),
        "entity_probe": entity_probe,
        "public_client": public_client,
        "original": {"path": str(audit.path.resolve()), "sha256": ORIGINAL_SHA256, "bytes": len(data)},
        "prototype": {"sha256": hashlib.sha256(output).hexdigest(), "bytes": len(output)},
        "hook": {"function_index": HOOK_FUNCTION, "function_name": audit.names[HOOK_FUNCTION],
                 "original_instruction_start": HOOK_INSTRUCTION_START, "instruction_offset": HOOK_INSTRUCTION_OFFSET + (2 if public_client else 0),
                 "original_file_offset": hook_position, "verified_prefix_sha256": hashlib.sha256(EXPECTED_RUN_PREFIX).hexdigest(),
                 "verified_prefix_bytes": len(EXPECTED_RUN_PREFIX), "callback_import": audit.descriptor(CALLBACK_IMPORT),
                 "magic_hex": hex(MAGIC), "magic_i32": MAGIC, "inserted_bytes_hex": hook_bytes.hex(),
                 "meaning": "活动线程 this 已写入 TLS；JS 必须识别 magic 后再使用指针，不能当作字符串读取。"},
        "additional_exports": [{"export_name": name, **audit.descriptor(value[0])} for name, value in exports.items()],
        "entity_probe_constraints": (["仅在活动脚本线程和有效 handler 上测试；不得当作已完成的同步功能。", "坐标向量为三个 f32，分别位于 scratch 指针的 0/8/16 字节偏移。", "模型需要在当前有效脚本上下文请求并确认 mpHasModel 已完成；同本地角色模型可直接复用。", "创建本地测试角色时 pedType=4、network=false、scriptHost=false。", "mpDeleteEntity/mpDeletePed 的参数为 i64 指向 int32 句柄，而不是句柄本身。", "测试角色归属于当前脚本上下文；清理/重生/掉线时必须先检查 mpExists。", "mpSetCoords 含角色高度补偿；直接同步世界坐标应验证并使用 mpSetCoordsNoOffset。", "mpCamCoords/mpCamRot 是结构体返回，首 i64 为结果缓冲区；不是返回 JS 坐标数组。", "原生通知按 mpBeginTheFeedPost(STRING)、mpAddTextPlayerSubstring(正文)、mpEndTheFeedPostTicker(blink, brief) 连续构造；两个 i64 字符串指针均指向 NUL 结尾 UTF-8，直到 End 返回前不可释放或覆写。", "mpEndTheFeedPostTicker 返回 int32 消息句柄，-1 表示当前文字构造或 feed 不可用；不使用会直接解引用全局对象的 Show/RemoveItem 包装器。"] if entity_probe else []),
        "unchanged_sections": unchanged_sections,
        "invariants": {"function_indices_unchanged": True, "imports_unchanged": True, "types_unchanged": True,
                       "data_and_elements_unchanged": True, "patched_function_bodies": patched_bodies},
        "runtime_status": "尚未在实际游戏中验证；编译成功也不代表脚本上下文、生命周期或多人同步可用。",
    }
    if public_client:
        evidence['script_gate'] = {'callback_magic': SCRIPT_GATE_MAGIC, 'branch_depth': 0,
            'insertion_instruction_offset': 110, 'resume_instruction_offset': 32869,
            'policy': '角色放置且完整世界就绪后按服务器session_policy白名单暂停原脚本VM；空名单暂停全部，桥回调和原TLS恢复保留，断线不恢复剧情。'}
        evidence['frontend_hook'] = {'function_index': FRONTEND_FUNCTION, 'function_name': 'CPauseMenu::Update()',
            'original_file_offset': frontend_position, 'original_body_sha256': FRONTEND_BODY_SHA256,
            'magic_i32': FRONTEND_MAGIC, 'inserted_bytes_hex': frontend_bytes.hex(),
            'scope': '正常前端更新尾部仅调用自有菜单标题/详情；0为无语义payload，绝不作为游戏对象指针，绝不操作实体或伪造脚本上下文。'}
        wrapper_start, _ = audit.bodies[PUBLIC_MODEL_WRAPPER]
        replacement = b"\x00" + b"\x01" * (len(EXPECTED_MODEL_WRAPPER) - 2) + b"\x0b"
        evidence["public_model_patch"] = {
            **audit.descriptor(PUBLIC_MODEL_WRAPPER),
            "original_body_offset": wrapper_start,
            "body_bytes": len(EXPECTED_MODEL_WRAPPER),
            "original_body_sha256": hashlib.sha256(EXPECTED_MODEL_WRAPPER).hexdigest(),
            "original_body_hex": EXPECTED_MODEL_WRAPPER.hex(),
            "replacement_body_hex": replacement.hex(),
            "scope": "仅屏蔽单机脚本 SET_PLAYER_MODEL；直接导出的 58625 原生函数、CHANGE_PLAYER_PED 和 C++ 重生/存档路径均保留。",
        }
    return bytes(output), evidence


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wasm", type=Path, default=DEFAULT_WASM, help="必须匹配已审计 SHA256 的原始引擎")
    parser.add_argument("--output", type=Path, help="独立输出路径；默认只读 native-probe.wasm，实体实验 native-replica.wasm，公共战局 native-public.wasm")
    parser.add_argument("--entity-probe", action="store_true", help="增加隔离实体复制实验导出；不改变默认只读探针")
    parser.add_argument("--public-client", action="store_true", help="仅公共战局屏蔽单机脚本角色切换；必须同时指定 --entity-probe")
    arguments = parser.parse_args(argv)
    if arguments.public_client and not arguments.entity_probe:
        parser.error("--public-client 必须与 --entity-probe 一起使用")
    output_name = "native-public.wasm" if arguments.public_client else "native-replica.wasm" if arguments.entity_probe else "native-probe.wasm"
    default_output = ROOT / "archive/cache" / output_name
    original = arguments.wasm.resolve()
    output = arguments.output or default_output
    protected_roots = tuple(path.parents[2] for path in (arguments.wasm.absolute(), original)
                            if path.parent.parent.name == "b")
    sources = (original, DEFAULT_WASM)
    try:
        output, evidence_path = validate_outputs(
            (output, output.with_suffix(".json")), sources=sources, protected_roots=protected_roots)
    except ValueError as error:
        parser.error(str(error))
    if output.suffix != ".wasm":
        parser.error("探针输出必须是独立的 .wasm 文件")
    audit = checked_audit(original, arguments.entity_probe, arguments.public_client)
    prototype, evidence = build(audit, arguments.entity_probe, arguments.public_client)
    evidence["prototype"]["path"] = str(output)
    atomic_write_bytes(output, prototype, sources=sources, protected_roots=protected_roots)
    atomic_write_text(evidence_path, json.dumps(evidence, ensure_ascii=False, indent=2) + "\n",
                      sources=sources, protected_roots=protected_roots)
    print(json.dumps({"探针": str(output), "证据": str(evidence_path), "新增导出": len(export_map(arguments.entity_probe)),
                      "hook": evidence["hook"]["original_file_offset"], "生产引擎未改动": True}, ensure_ascii=False))


if __name__ == "__main__":
    main()
