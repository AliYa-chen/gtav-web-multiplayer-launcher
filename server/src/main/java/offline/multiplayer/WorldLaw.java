package offline.multiplayer;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import offline.multiplayer.WorldRegistry.Entity;
import offline.multiplayer.WorldRegistry.Kind;
import offline.multiplayer.WorldRegistry.Vector;

/**
 * 服务端犯罪、通缉及有限警力的规则模块。实体、生命、座位和模拟租约仍只在
 * WorldRegistry 保存；这里仅保存通缉计时和调度关联。所有 reportAccepted 方法
 * 只能在 WorldService 已确认动作/伤害之后调用，不能映射为客户端自由写接口。
 * 本模块没有 GTA 地图导航、碰撞世界或警察 AI，不把候选模拟当作独立物理验证。
 */
public final class WorldLaw {
    public static final long COP_MODEL = 0x5e3da4a4L;
    public static final long POLICE_MODEL = 0x79fbb0c5L;
    public static final long POLICE_WEAPON = 0x1b06d571L;
    private static final long UNARMED = 0xa2719263L;
    private static final int MAX_RESPONSES = 8;
    private static final int RESPONSE_SIZE = 3;
    private static final long OFFER_TIMEOUT = 5_000;
    private static final long SHOT_CRIME_INTERVAL = 5_000;
    private static final long TASK_INTERVAL = 1_000;
    // 当前公共出生区的既有基线。其他区域未审计导航/落地点时不凭空派遣警力。
    private static final Vector PUBLIC_ORIGIN = new Vector(711.5, -1088.08, 22.41);
    private static final double DISPATCH_RADIUS = 220;
    private static final double OWNER_RADIUS = 300;

    public record Spawn(String role, Kind kind, long model, Vector position,
                        double heading, long weapon) {}
    public record DispatchDecision(String responseId, String action, String targetPlayerId,
                                   String targetEntityId, long targetGeneration, Vector targetPosition,
                                   String ownerId, List<Spawn> spawns, List<String> entityIds) {
        public DispatchDecision { spawns = List.copyOf(spawns); entityIds = List.copyOf(entityIds); }
    }
    public record ResponseInfo(String responseId, String role, String targetPlayerId,
                               String targetEntityId, long targetGeneration, Vector targetPosition,
                               String ownerId, String phase) {
        public Map<String,Object> values() {
            return immutable(map("response_id", responseId, "role", role,
                "target_player_id", targetPlayerId, "target_entity_id", targetEntityId,
                "target_generation", targetGeneration, "target_position", targetPosition.values(),
                "owner_id", ownerId, "phase", phase));
        }
    }
    private record Wanted(String playerId, long generation, int stars, long expiresAtTick,
                          long lastCrimeTick, long revision) {
        Map<String,Object> values() {
            return immutable(map("player_id", playerId, "generation", generation,
                "stars", stars, "expires_at_tick", expiresAtTick,
                "last_crime_tick", lastCrimeTick, "revision", revision));
        }
    }
    private static final class Response {
        final String id, playerId, targetEntityId;
        final long generation, offeredAt;
        final List<Spawn> spawns;
        List<String> entityIds = List.of();
        Vector targetPosition;
        String owner;
        String phase = "offered";
        long lastTask;
        Response(String id, Entity target, String owner, long now, List<Spawn> spawns) {
            this.id = id; playerId = target.playerId(); targetEntityId = target.entityId();
            generation = target.generation(); targetPosition = position(target);
            this.owner = owner; offeredAt = now; lastTask = now; this.spawns = List.copyOf(spawns);
        }
    }

    private final String worldEpoch;
    private final Map<String,Wanted> wanted = new LinkedHashMap<>();
    private final Map<String,Long> shotCrimes = new LinkedHashMap<>();
    private final Map<String,Response> responses = new LinkedHashMap<>();
    private long revision, nextResponse, lastTick;

    public WorldLaw(String worldEpoch) {
        if (worldEpoch == null || !worldEpoch.matches("[A-Za-z0-9_-]{1,64}"))
            throw new IllegalArgumentException("世界 epoch 无效");
        this.worldEpoch = worldEpoch;
    }

    public synchronized long revision() { return revision; }

    /** 枪械输入已被战斗规则接受；不能用客户端自称“开枪”直接提高通缉。 */
    public synchronized boolean reportAcceptedShot(Entity actor, long acceptedWeapon,
                                                    Vector acceptedOrigin, long now) {
        advance(now);
        if (!activePlayer(actor, now) || acceptedOrigin == null || acceptedWeapon <= 0
            || acceptedWeapon == UNARMED || acceptedWeapon != actor.components().ped().weapon()
            || position(actor).distance(acceptedOrigin) > 6) return false;
        long last = shotCrimes.getOrDefault(actor.playerId(), Long.MIN_VALUE);
        if (last != Long.MIN_VALUE && now - last < SHOT_CRIME_INTERVAL) return false;
        if (!crime(actor, 1, now)) return false;
        shotCrimes.put(actor.playerId(), now);
        return true;
    }

    /** 仅记录已原子提交的伤害，避免把视觉命中或观测到的旧血量重复裁决。 */
    public synchronized boolean reportAcceptedDamage(Entity attacker, Entity victim,
                                                      int actualDamage, long now) {
        advance(now);
        if (!activePlayer(attacker, now) || victim == null || victim.kind() != Kind.PED
            || victim.components().combat() == null || victim.entityId().equals(attacker.entityId())
            || actualDamage <= 0 || actualDamage > victim.components().combat().maxHealth()
            || position(attacker).distance(position(victim)) > 1_200) return false;
        boolean officer = victim.model() == COP_MODEL && responseForEntity(victim.entityId()) != null;
        boolean killed = !victim.components().combat().alive();
        return crime(attacker, officer ? (killed ? 4 : 3) : (killed ? 3 : 2), now);
    }

    /**
     * 逮捕只接受当前代次、有服务端通缉且三米内确有本次共享响应警员的候选。
     * 调用方还必须核对报告者身份、活动租约、序号及报告自身实体；本方法不扣血。
     */
    public synchronized boolean reportArrestCandidate(Entity player, long generation,
                                                       Collection<Entity> responseOfficers, long now) {
        advance(now);
        if (!activePlayer(player, now) || generation != player.generation()
            || player.components().attachment() != null || player.components().transform().velocity().length() > 2)
            return false;
        Wanted record = wanted.get(player.playerId());
        if (record == null || record.generation != generation || record.stars == 0) return false;
        if (responseOfficers == null) return false;
        for (Entity officer : responseOfficers) {
            if (officer == null || officer.kind() != Kind.PED || officer.playerId() != null
                || officer.model() != COP_MODEL || officer.components().combat() == null
                || !officer.components().combat().alive() || officer.components().attachment() != null
                || officer.ownerId() == null || officer.leaseUntilTick() <= now
                || officer.lastInputSequence() < 0) continue;
            ResponseInfo response = responseForEntity(officer.entityId());
            if (response == null || !"officer".equals(response.role)
                || !player.entityId().equals(response.targetEntityId)
                || generation != response.targetGeneration || !"active".equals(response.phase)) continue;
            if (position(player).distance(position(officer)) <= 3) return true;
        }
        return false;
    }

    /** 仅服务器批准重部署并增加代次后清空通缉；旧客户端不得清除新代次的状态。 */
    public synchronized boolean clearAfterRedeploy(String playerId, long generation, long now) {
        advance(now);
        if (playerId == null || generation < 1) return false;
        Wanted previous = wanted.get(playerId);
        if (previous != null && generation <= previous.generation) return false;
        wanted.put(playerId, new Wanted(playerId, generation, 0, 0, 0, ++revision));
        shotCrimes.remove(playerId);
        return true;
    }

    public synchronized void removePlayer(String playerId) {
        if (wanted.remove(playerId) != null) revision++;
        shotCrimes.remove(playerId);
        // 已创建的共享响应必须由 tick 发出 retire 后统一删除，不能遗留无归属警力。
    }

    public synchronized Map<String,Object> wanted(String playerId) {
        Wanted value = wanted.get(playerId);
        return value == null ? immutable(map("player_id", playerId, "generation", 0,
            "stars", 0, "expires_at_tick", 0, "last_crime_tick", 0, "revision", revision)) : value.values();
    }

    public synchronized Map<String,Object> snapshot() {
        List<Map<String,Object>> players = new ArrayList<>();
        for (Wanted value : wanted.values()) players.add(value.values());
        List<Map<String,Object>> dispatches = new ArrayList<>();
        for (Response response : responses.values()) dispatches.add(immutable(map(
            "response_id", response.id, "target_player_id", response.playerId,
            "target_entity_id", response.targetEntityId, "target_generation", response.generation,
            "target_position", response.targetPosition.values(), "owner_id", response.owner,
            "phase", response.phase, "entity_ids", response.entityIds)));
        return immutable(map("revision", revision, "world_epoch", worldEpoch,
            "players", List.copyOf(players), "dispatches", List.copyOf(dispatches),
            "experimental", true, "dispatch_mode", "shared_public_spawn_zone",
            "dispatch_origin", PUBLIC_ORIGIN.values(), "dispatch_radius", DISPATCH_RADIUS,
            "max_responses", MAX_RESPONSES, "max_response_entities", MAX_RESPONSES * RESPONSE_SIZE));
    }

    /**
     * 产生调度意图，调用方负责创建/删掉 Registry 实体、统一挂接、邀约及授予租约。
     * availableSlots 必须来自当前 Registry 容量；同批次派遣还会扣除待创建预算。
     */
    public synchronized List<DispatchDecision> tick(long now, Collection<Entity> entities,
                                                    Set<String> eligibleOwners, int availableSlots) {
        advance(now); Objects.requireNonNull(entities); Objects.requireNonNull(eligibleOwners);
        Map<String,Entity> byId = new LinkedHashMap<>(), players = new LinkedHashMap<>();
        for (Entity entity : entities) {
            byId.put(entity.entityId(), entity);
            if (entity.playerId() != null) players.put(entity.playerId(), entity);
        }
        decay(now);
        List<DispatchDecision> decisions = new ArrayList<>();
        for (Response response : new ArrayList<>(responses.values())) {
            Entity target = players.get(response.playerId); Wanted status = wanted.get(response.playerId);
            boolean invalidTarget = target == null || !alive(target) || status == null || status.stars == 0
                || status.generation != response.generation || target.generation() != response.generation
                || !target.entityId().equals(response.targetEntityId);
            if (invalidTarget) {
                if (response.entityIds.isEmpty()) { responses.remove(response.id); revision++; }
                else if (!"retiring".equals(response.phase)) {
                    response.phase = "retiring"; revision++;
                    decisions.add(decision(response, "retire", List.of()));
                }
                continue;
            }
            if ("retiring".equals(response.phase)) continue;
            if (response.entityIds.isEmpty()) {
                if (now - response.offeredAt >= OFFER_TIMEOUT) { responses.remove(response.id); revision++; }
                continue;
            }
            if (response.entityIds.stream().allMatch(id -> !byId.containsKey(id))) {
                responses.remove(response.id); revision++; continue;
            }
            Vector targetPosition = position(target);
            Entity groupAnchor = response.entityIds.stream().map(byId::get).filter(Objects::nonNull).findFirst().orElse(null);
            String owner = eligibleOwner(groupAnchor == null ? PUBLIC_ORIGIN : position(groupAnchor), players,
                eligibleOwners, now, response.owner);
            boolean frozen = owner == null || target.ownerId() == null || target.leaseUntilTick() <= now
                || targetPosition.distance(PUBLIC_ORIGIN) > DISPATCH_RADIUS;
            String phase = frozen ? "frozen" : "active";
            boolean changed = !Objects.equals(owner, response.owner) || !phase.equals(response.phase);
            if (changed || now - response.lastTask >= TASK_INTERVAL) {
                response.owner = owner; response.phase = phase; response.targetPosition = targetPosition;
                response.lastTask = now; revision++;
                decisions.add(decision(response, frozen ? "freeze" : "pursue", List.of()));
            }
        }
        int reserved = (int) responses.values().stream().filter(value -> value.entityIds.isEmpty()).count() * RESPONSE_SIZE;
        int remaining = Math.max(0, availableSlots - reserved);
        for (Entity player : players.values()) {
            Wanted status = wanted.get(player.playerId());
            if (status == null || status.stars == 0 || status.generation != player.generation()
                || !activePlayer(player, now) || position(player).distance(PUBLIC_ORIGIN) > DISPATCH_RADIUS
                || responses.size() >= MAX_RESPONSES || remaining < RESPONSE_SIZE
                || responses.values().stream().anyMatch(value -> value.playerId.equals(player.playerId()))) continue;
            String owner = eligibleOwner(PUBLIC_ORIGIN, players, eligibleOwners, now, null);
            if (owner == null) continue;
            List<Spawn> spawns = availablePublicSpawns(byId.values());
            if (spawns.isEmpty()) continue;
            Response response = new Response("law:" + worldEpoch + ":" + (++nextResponse), player, owner, now, spawns);
            responses.put(response.id, response); remaining -= RESPONSE_SIZE; revision++;
            decisions.add(decision(response, "spawn", spawns));
        }
        return List.copyOf(decisions);
    }

    /** 创建成功后绑定真实共享实体，顺序必须与 DispatchDecision.spawns 一致。 */
    public synchronized boolean dispatchCommitted(String responseId, List<String> entityIds, long now) {
        advance(now); Response response = responses.get(responseId);
        if (response == null || !response.entityIds.isEmpty() || !"offered".equals(response.phase)
            || now - response.offeredAt >= OFFER_TIMEOUT || entityIds == null || entityIds.size() != RESPONSE_SIZE
            || entityIds.stream().anyMatch(id -> id == null || id.isBlank())
            || new LinkedHashSet<>(entityIds).size() != RESPONSE_SIZE) return false;
        for (Response other : responses.values())
            if (other.entityIds.stream().anyMatch(entityIds::contains)) return false;
        response.entityIds = List.copyOf(entityIds); response.phase = "active"; revision++;
        return true;
    }

    /** 创建失败需回滚已创建实体后调用；retire 删除提交成功后也调用此方法。 */
    public synchronized void dispatchFailed(String responseId) {
        if (responses.remove(responseId) != null) revision++;
    }

    public synchronized ResponseInfo responseForEntity(String entityId) {
        for (Response response : responses.values()) {
            int index = response.entityIds.indexOf(entityId);
            if (index >= 0) return new ResponseInfo(response.id, response.spawns.get(index).role,
                response.playerId, response.targetEntityId, response.generation, response.targetPosition,
                response.owner, response.phase);
        }
        return null;
    }

    private boolean crime(Entity actor, int minimumStars, long now) {
        Wanted old = wanted.get(actor.playerId());
        if (old != null && old.generation > actor.generation()) return false;
        int previous = old != null && old.generation == actor.generation() ? old.stars : 0;
        int stars = Math.min(5, Math.max(minimumStars, previous));
        wanted.put(actor.playerId(), new Wanted(actor.playerId(), actor.generation(), stars,
            now + (stars <= 2 ? 45_000 : 90_000), now, ++revision));
        return true;
    }

    private void decay(long now) {
        for (Wanted value : new ArrayList<>(wanted.values())) if (value.stars > 0 && now >= value.expiresAtTick) {
            int stars = value.stars - 1;
            wanted.put(value.playerId, new Wanted(value.playerId, value.generation, stars,
                stars == 0 ? 0 : now + 30_000, value.lastCrimeTick, ++revision));
        }
    }

    private void advance(long now) {
        if (now < lastTick || now < 0) throw new IllegalArgumentException("犯罪规则需要单调服务端 tick");
        lastTick = now;
    }

    private static String eligibleOwner(Vector anchor, Map<String,Entity> players, Set<String> eligible,
                                        long now, String current) {
        // 与300/400米订阅滞回一致，仍有效的当前模拟者优先，避免每秒抢夺租约。
        Entity existing = players.get(current);
        if (existing != null && eligible.contains(current) && activePlayer(existing, now)
            && position(existing).distance(anchor) <= 400) return current;
        return players.values().stream().filter(player -> eligible.contains(player.playerId()) && activePlayer(player, now)
            && position(player).distance(anchor) <= OWNER_RADIUS)
            .min(Comparator.<Entity>comparingDouble(player -> position(player).distance(anchor))
                .thenComparing(Entity::playerId)).map(Entity::playerId).orElse(null);
    }

    private List<Spawn> availablePublicSpawns(Collection<Entity> entities) {
        // 固定出生区内的停车排布；只检查已登记对象，地面/静态碰撞仍由ready端确认。
        // 不让每个目标的警车叠在公共车辆或上一组响应的同一个坐标上。
        for (int offset = 0; offset < 16; offset++) {
            int slot = (int) ((nextResponse + offset) % 16);
            Vector candidate = new Vector(715.5 + (slot / 4) * 7, -1088.1 + (1 + slot % 4) * 4, 22.4);
            boolean occupied = false;
            for (Entity entity : entities) {
                Vector point = position(entity);
                if (entity.kind() == Kind.VEHICLE && parkingOverlap(point, candidate)
                    || entity.kind() == Kind.PED && entity.components().attachment() == null
                        && point.distance(candidate) < 2) { occupied = true; break; }
            }
            if (!occupied) for (Response response : responses.values())
                if (parkingOverlap(response.spawns.get(0).position(), candidate)) { occupied = true; break; }
            if (!occupied) return publicSpawns(candidate);
        }
        return List.of();
    }

    private static boolean parkingOverlap(Vector left, Vector right) {
        return Math.abs(left.x() - right.x()) < 6 && Math.abs(left.y() - right.y()) < 3
            && Math.abs(left.z() - right.z()) < 3;
    }

    private static List<Spawn> publicSpawns(Vector anchor) {
        return List.of(
            new Spawn("vehicle", Kind.VEHICLE, POLICE_MODEL, anchor, 90, 0),
            new Spawn("officer", Kind.PED, COP_MODEL, anchor, 90, POLICE_WEAPON),
            new Spawn("officer", Kind.PED, COP_MODEL, anchor, 90, POLICE_WEAPON));
    }

    private static DispatchDecision decision(Response response, String action, List<Spawn> spawns) {
        return new DispatchDecision(response.id, action, response.playerId, response.targetEntityId,
            response.generation, response.targetPosition, response.owner, spawns, response.entityIds);
    }
    private static Vector position(Entity entity) { return entity.components().transform().position(); }
    private static boolean alive(Entity entity) {
        return entity != null && entity.kind() == Kind.PED && entity.components().combat() != null
            && entity.components().combat().alive();
    }
    private static boolean activePlayer(Entity entity, long now) {
        return alive(entity) && entity.playerId() != null && entity.playerId().equals(entity.ownerId())
            && entity.leaseUntilTick() > now && entity.components().ped() != null;
    }
    private static Map<String,Object> map(Object... values) {
        Map<String,Object> result = new LinkedHashMap<>();
        for (int index = 0; index < values.length; index += 2) result.put((String) values[index], values[index + 1]);
        return result;
    }
    private static Map<String,Object> immutable(Map<String,Object> value) {
        return Collections.unmodifiableMap(value);
    }
}
