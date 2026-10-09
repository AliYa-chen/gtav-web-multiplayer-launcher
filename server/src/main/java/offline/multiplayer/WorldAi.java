package offline.multiplayer;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import offline.multiplayer.WorldRegistry.Entity;
import offline.multiplayer.WorldRegistry.Kind;
import offline.multiplayer.WorldRegistry.Vector;

/**
 * 共同世界的 NPC 决策层。只接收服务器已经接受的动作/伤害和 Registry 快照；
 * 客户端不能直接设置目标、人格或任务。道路驾驶目标由服务端道路图给出，
 * 避障、原生驾驶控制及任务动画仍由租约端引擎执行；没有步行导航网格。
 * 没有地图碰撞/视线数据，所以 60 米事件感知只是本地 DEFAULT_PERCEPTION 听觉半径的
 * 有界近似，不能据此声称复现了 RAGE 的视觉、场景或整套行为树。
 */
public final class WorldAi {
    public static final double HEARING_RADIUS = 60;
    public static final double COMBAT_RADIUS = 40;
    public static final long THREAT_MEMORY_TICKS = 10_000;
    private static final long UNARMED = 0xa2719263L;
    private static final int MAX_THREATS = 128;
    private static final long REPLAN_INTERVAL = 500;
    private static final long EXPIRY_REFRESH_INTERVAL = 2_000;
    private static final double ROAD_SNAP_DISTANCE = 40;
    private static final double ROAD_LOOKAHEAD = 12;

    private record Threat(String sourceId, long sourceGeneration, String victimId,
                          long victimGeneration, Vector origin, long expires, long observedAt) {}
    private record Plan(long generation, long ownerEpoch, String action, String reason,
                        String targetId, long targetGeneration, Vector targetPosition,
                        Vector destination, double speed, String vehicleId, long expires) {}
    private record Course(long generation, long ownerEpoch, String vehicleId, long vehicleGeneration,
                          String reason, Vector desired, long plannedAt, RoadNetwork.Route route) {}
    private record RoadProgress(Vector waypoint, double remaining, double offRoadDistance) {}
    private record Decision(long revision, long decidedAt, Plan plan) {
        Map<String,Object> values(String entityId) {
            return immutable(map("revision", revision, "entity_id", entityId,
                "generation", plan.generation, "owner_epoch", plan.ownerEpoch,
                "action", plan.action, "reason", plan.reason,
                "target_entity_id", plan.targetId, "target_generation", plan.targetId == null ? null : plan.targetGeneration,
                "target_position", plan.targetPosition == null ? null : plan.targetPosition.values(),
                "destination", plan.destination == null ? null : plan.destination.values(),
                "speed", plan.speed, "vehicle_entity_id", plan.vehicleId,
                "expires_at_tick", plan.expires));
        }
    }

    private final String worldEpoch;
    private final RoadNetwork roads;
    private final Map<String,Threat> threats = new LinkedHashMap<>();
    private final Map<String,Decision> decisions = new LinkedHashMap<>();
    private final Map<String,Course> courses = new LinkedHashMap<>();
    private long revision, lastTick;

    public WorldAi(String worldEpoch) {
        this(worldEpoch, RoadNetwork.empty());
    }

    public WorldAi(String worldEpoch, RoadNetwork roads) {
        if (worldEpoch == null || !worldEpoch.matches("[A-Za-z0-9_-]{1,64}"))
            throw new IllegalArgumentException("世界 epoch 无效");
        this.worldEpoch = worldEpoch;
        this.roads = Objects.requireNonNull(roads);
    }

    public synchronized long revision() { return revision; }

    public synchronized Map<String,Object> taskForEntity(String entityId) {
        Decision decision = decisions.get(entityId);
        return decision == null ? null : decision.values(entityId);
    }

    public synchronized Map<String,Object> snapshot() {
        List<Map<String,Object>> tasks = new ArrayList<>();
        decisions.forEach((id, value) -> tasks.add(value.values(id)));
        return immutable(map("world_epoch", worldEpoch, "revision", revision,
            "tasks", List.copyOf(tasks), "decision_authority", "server",
            "navigation_authority", "server_road_graph", "task_execution_authority", "leased_engine",
            "road_network", roads.metadata(), "hearing_radius", HEARING_RADIUS));
    }

    /** 只能由服务器战斗规则接受动作后调用；拒绝纯动画、无武器和离体的声音。 */
    public synchronized boolean reportAcceptedShot(Entity actor, long weapon, Vector origin, long now) {
        advance(now);
        if (!activeActor(actor, now) || !armed(actor) || actor.components().ped().weapon() != weapon
            || origin == null || position(actor).distance(origin) > 6) return false;
        remember(new Threat(actor.entityId(), actor.generation(), null, 0, origin,
            now + THREAT_MEMORY_TICKS, now));
        return true;
    }

    /** 调用前必须已原子提交伤害；生命值报告和视觉命中不属于此接口的输入。 */
    public synchronized boolean reportAcceptedDamage(Entity attacker, Entity victim, int damage, long now) {
        advance(now);
        if (!activeActor(attacker, now) || victim == null || victim.kind() != Kind.PED
            || victim.components().combat() == null || attacker.entityId().equals(victim.entityId())
            || damage <= 0 || damage > victim.components().combat().maxHealth()
            || position(attacker).distance(position(victim)) > 1_200) return false;
        remember(new Threat(attacker.entityId(), attacker.generation(), victim.entityId(), victim.generation(),
            position(victim), now + THREAT_MEMORY_TICKS, now));
        return true;
    }

    /**
     * 返回发生任务变化的实体 ID。调用方可 touchTrusted 同步这些元数据；
     * 不修改血量、身份、座位、所有权或 Registry 版本，也不把任务当作模拟租约。
     */
    public synchronized List<String> tick(long now, Collection<Entity> entities,
                                          Set<String> eligibleOwners, WorldLaw law) {
        advance(now); Objects.requireNonNull(entities); Objects.requireNonNull(eligibleOwners);
        Map<String,Entity> byId = new LinkedHashMap<>(), players = new LinkedHashMap<>();
        for (Entity entity : entities) {
            byId.put(entity.entityId(), entity);
            if (entity.playerId() != null) players.put(entity.playerId(), entity);
        }
        threats.entrySet().removeIf(entry -> {
            Threat value = entry.getValue(); Entity source = byId.get(value.sourceId);
            return now >= value.expires || source == null || source.generation() != value.sourceGeneration;
        });
        List<String> changed = new ArrayList<>();
        for (String id : new ArrayList<>(decisions.keySet())) {
            Entity entity = byId.get(id);
            if (entity == null || entity.kind() != Kind.PED || entity.playerId() != null) {
                decisions.remove(id); courses.remove(id); changed.add(id); revision++;
            }
        }
        // Stable order makes task revisions reproducible for equivalent world snapshots.
        List<Entity> npcs = byId.values().stream().filter(entity -> entity.kind() == Kind.PED
            && entity.playerId() == null).sorted(Comparator.comparing(Entity::entityId)).toList();
        for (Entity npc : npcs) {
            Plan plan = plan(npc, byId, players, eligibleOwners, law, now);
            Decision old = decisions.get(npc.entityId());
            if (old == null || changed(old, plan, now)) {
                decisions.put(npc.entityId(), new Decision(++revision, now, plan));
                changed.add(npc.entityId());
            }
        }
        return List.copyOf(changed);
    }

    /** 当前任务只授权这个目标；仍须由 WorldService 检查序号、射速、武器规则及损伤事务。 */
    public synchronized boolean authorizesShot(Entity attacker, Entity victim, long now) {
        advance(now);
        if (!activeActor(attacker, now) || attacker.playerId() != null || !armed(attacker)
            || attacker.lastInputSequence() < 0 || attacker.components().attachment() != null
            || !activeActor(victim, now) || attacker.entityId().equals(victim.entityId())) return false;
        Decision decision = decisions.get(attacker.entityId());
        if (decision == null) return false;
        Plan task = decision.plan;
        return "combat".equals(task.action) && task.generation == attacker.generation()
            && task.ownerEpoch == attacker.ownerEpoch() && Objects.equals(task.targetId, victim.entityId())
            && task.targetGeneration == victim.generation() && (task.expires == 0 || now < task.expires)
            && position(attacker).distance(position(victim)) <= COMBAT_RADIUS;
    }

    private Plan plan(Entity npc, Map<String,Entity> byId, Map<String,Entity> players,
                      Set<String> eligible, WorldLaw law, long now) {
        if (!alive(npc)) { courses.remove(npc.entityId()); return idle(npc, "dead"); }
        if (!simulated(npc, players, eligible, now)) { courses.remove(npc.entityId()); return idle(npc, "no_active_lease"); }
        WorldLaw.ResponseInfo response = law == null ? null : law.responseForEntity(npc.entityId());
        if (response != null) {
            Entity target = byId.get(response.targetEntityId());
            if (!"active".equals(response.phase()) || !"officer".equals(response.role())
                || !activeActor(target, now) || target.generation() != response.targetGeneration()) {
                courses.remove(npc.entityId());
                return idle(npc, "law_frozen");
            }
            if (npc.components().attachment() != null) {
                if (!canDrive(npc, byId, now)) { courses.remove(npc.entityId()); return idle(npc, "passenger"); }
                return drive(npc, byId.get(npc.components().attachment().entityId()),
                    "police_pursuit", target, position(target), 25, 0, now);
            }
            courses.remove(npc.entityId());
            boolean inRange = position(npc).distance(position(target)) <= COMBAT_RADIUS && armed(npc);
            return targeted(npc, inRange ? "combat" : "pursue", "police_pursuit", target,
                position(target), inRange ? 0 : 2.5, null, 0);
        }
        Threat threat = threatFor(npc, byId, now);
        if (npc.components().attachment() != null) {
            if (!canDrive(npc, byId, now)) { courses.remove(npc.entityId()); return idle(npc, "passenger"); }
            Entity target = threat == null ? null : byId.get(threat.sourceId);
            return drive(npc, byId.get(npc.components().attachment().entityId()),
                threat == null ? "ambient_traffic" : "danger_escape", target,
                threat == null ? null : escapeDestination(npc, threat.origin), threat == null ? 12 : 22,
                threat == null ? 0 : threat.expires, now);
        }
        courses.remove(npc.entityId());
        if (threat == null) return targeted(npc, "wander", "ambient", null, null, 1, null, 0);
        Entity target = byId.get(threat.sourceId);
        boolean attacked = npc.entityId().equals(threat.victimId) && npc.generation() == threat.victimGeneration;
        if (attacked && armed(npc)) {
            boolean inRange = position(npc).distance(position(target)) <= COMBAT_RADIUS;
            return targeted(npc, inRange ? "combat" : "pursue", "self_defence", target,
                position(target), inRange ? 0 : 2.5, null, threat.expires);
        }
        return targeted(npc, "flee", attacked ? "attacked" : "heard_danger", target,
            escapeDestination(npc, threat.origin), 3, null, threat.expires);
    }

    private Plan drive(Entity npc, Entity vehicle, String reason, Entity target, Vector desired,
                       double speed, long expires, long now) {
        Vector current = position(vehicle);
        Course course = courses.get(npc.entityId());
        boolean identityChanged = course == null || course.generation != npc.generation()
            || course.ownerEpoch != npc.ownerEpoch() || !Objects.equals(course.vehicleId, vehicle.entityId())
            || course.vehicleGeneration != vehicle.generation() || !course.reason.equals(reason);
        RoadProgress progress = identityChanged ? null : progress(current, course.route);
        boolean retry = !identityChanged && now - course.plannedAt >= REPLAN_INTERVAL;
        boolean movedGoal = !identityChanged && moved(course.desired, desired);
        boolean finishedAmbient = desired == null && progress != null && progress.remaining <= 4;
        if (identityChanged || finishedAmbient || retry && (movedGoal || progress == null
            || progress.offRoadDistance > ROAD_SNAP_DISTANCE)) {
            RoadNetwork.Point start = point(current);
            RoadNetwork.Route route = desired == null
                ? roads.cruise(start, vehicle.components().transform().rotation().heading(), ROAD_SNAP_DISTANCE,
                    60, Objects.hash(worldEpoch, npc.entityId(), vehicle.generation()))
                : roads.route(start, point(desired), ROAD_SNAP_DISTANCE, 20_000);
            course = new Course(npc.generation(), npc.ownerEpoch(), vehicle.entityId(), vehicle.generation(),
                reason, desired, now, route);
            courses.put(npc.entityId(), course);
            progress = progress(current, route);
        }
        if (progress == null || progress.offRoadDistance > ROAD_SNAP_DISTANCE)
            return idle(npc, "road_unavailable");
        if (progress.remaining <= 1) return idle(npc, "road_destination_reached");
        return targeted(npc, "drive", reason, target, progress.waypoint, speed, vehicle.entityId(), expires);
    }

    /** Select an ahead point along the accepted road polyline, never along the player-to-driver chord. */
    private static RoadProgress progress(Vector current, RoadNetwork.Route route) {
        if (!route.reached() || route.points().size() < 2) return null;
        List<RoadNetwork.Point> points = route.points();
        RoadNetwork.Point at = point(current), projection = null;
        double best = Double.POSITIVE_INFINITY;
        int segment = -1;
        for (int i = 0; i + 1 < points.size(); i++) {
            RoadNetwork.Point a = points.get(i), b = points.get(i + 1);
            double dx = b.x() - a.x(), dy = b.y() - a.y(), dz = b.z() - a.z();
            double lengthSquared = dx * dx + dy * dy + dz * dz;
            if (lengthSquared < .000001) continue;
            double fraction = Math.max(0, Math.min(1, ((at.x() - a.x()) * dx + (at.y() - a.y()) * dy
                + (at.z() - a.z()) * dz) / lengthSquared));
            RoadNetwork.Point candidate = new RoadNetwork.Point(a.x() + dx * fraction,
                a.y() + dy * fraction, a.z() + dz * fraction);
            double distance = candidate.distance(at);
            if (distance < best) { best = distance; projection = candidate; segment = i; }
        }
        if (segment < 0) return null;
        double remaining = projection.distance(points.get(segment + 1));
        for (int i = segment + 1; i + 1 < points.size(); i++) remaining += points.get(i).distance(points.get(i + 1));
        double ahead = Math.min(ROAD_LOOKAHEAD, remaining);
        RoadNetwork.Point from = projection, waypoint = points.get(points.size() - 1);
        for (int i = segment + 1; i < points.size(); i++) {
            RoadNetwork.Point to = points.get(i); double length = from.distance(to);
            if (length >= ahead && length > .000001) {
                double fraction = ahead / length;
                waypoint = new RoadNetwork.Point(from.x() + (to.x() - from.x()) * fraction,
                    from.y() + (to.y() - from.y()) * fraction, from.z() + (to.z() - from.z()) * fraction);
                break;
            }
            ahead -= length; from = to;
        }
        return new RoadProgress(new Vector(waypoint.x(), waypoint.y(), waypoint.z()), remaining, best);
    }

    private static RoadNetwork.Point point(Vector value) { return new RoadNetwork.Point(value.x(), value.y(), value.z()); }

    private Threat threatFor(Entity npc, Map<String,Entity> byId, long now) {
        Threat best = null; int bestPriority = -1; double bestDistance = Double.MAX_VALUE;
        for (Threat value : threats.values()) {
            Entity source = byId.get(value.sourceId);
            if (source == null || source.entityId().equals(npc.entityId()) || !activeActor(source, now)
                || source.generation() != value.sourceGeneration || now >= value.expires) continue;
            boolean attacked = npc.entityId().equals(value.victimId) && npc.generation() == value.victimGeneration;
            double distance = position(npc).distance(value.origin);
            if (!attacked && distance > HEARING_RADIUS) continue;
            int priority = attacked ? 3 : value.victimId != null ? 2 : 1;
            if (priority > bestPriority || priority == bestPriority && (best == null
                || value.observedAt > best.observedAt || value.observedAt == best.observedAt && distance < bestDistance)) {
                best = value; bestPriority = priority; bestDistance = distance;
            }
        }
        return best;
    }

    private static Plan targeted(Entity npc, String action, String reason, Entity target,
                                 Vector destination, double speed, String vehicle, long expires) {
        return new Plan(npc.generation(), npc.ownerEpoch(), action, reason,
            target == null ? null : target.entityId(), target == null ? 0 : target.generation(),
            target == null ? null : position(target), destination, speed, vehicle, expires);
    }

    private static Plan idle(Entity npc, String reason) {
        return targeted(npc, "idle", reason, null, null, 0, null, 0);
    }

    private static boolean changed(Decision old, Plan next, long now) {
        Plan value = old.plan;
        if (value.generation != next.generation || value.ownerEpoch != next.ownerEpoch
            || !value.action.equals(next.action) || !value.reason.equals(next.reason)
            || !Objects.equals(value.targetId, next.targetId) || value.targetGeneration != next.targetGeneration
            || !Objects.equals(value.vehicleId, next.vehicleId) || value.speed != next.speed
            || (value.expires == 0) != (next.expires == 0)) return true;
        if (next.expires != 0 && next.expires - value.expires >= EXPIRY_REFRESH_INTERVAL) return true;
        if (next.expires > value.expires && value.expires <= now + 1_000) return true;
        return now - old.decidedAt >= REPLAN_INTERVAL
            && (moved(value.targetPosition, next.targetPosition) || moved(value.destination, next.destination));
    }

    private static boolean moved(Vector left, Vector right) {
        return left == null || right == null ? left != right : left.distance(right) >= 3;
    }

    private static Vector escapeDestination(Entity npc, Vector danger) {
        Vector point = position(npc); double dx = point.x() - danger.x(), dy = point.y() - danger.y();
        double distance = Math.hypot(dx, dy);
        if (distance < .1) {
            // Coincident impact and ped position must not divide by zero or choose per-client randomness.
            double angle = Math.toRadians(Math.floorMod(npc.entityId().hashCode(), 360));
            dx = Math.cos(angle); dy = Math.sin(angle); distance = 1;
        }
        return new Vector(clamp(point.x() + dx / distance * 25),
            clamp(point.y() + dy / distance * 25), point.z());
    }

    private static double clamp(double value) { return Math.max(-16000, Math.min(16000, value)); }

    private static boolean canDrive(Entity npc, Map<String,Entity> byId, long now) {
        var attachment = npc.components().attachment();
        if (attachment == null || !"driver".equals(attachment.seat())) return false;
        Entity vehicle = byId.get(attachment.entityId());
        return vehicle != null && vehicle.kind() == Kind.VEHICLE && vehicle.components().vehicle() != null
            && npc.entityId().equals(vehicle.components().vehicle().seats().get("driver"))
            && Objects.equals(npc.ownerId(), vehicle.ownerId()) && vehicle.leaseUntilTick() > now;
    }

    private static boolean simulated(Entity npc, Map<String,Entity> players, Set<String> eligible, long now) {
        Entity owner = players.get(npc.ownerId());
        return activeActor(npc, now) && eligible.contains(npc.ownerId()) && activeActor(owner, now)
            && owner.playerId().equals(npc.ownerId());
    }

    private static boolean armed(Entity entity) {
        return entity != null && entity.components().ped() != null
            && entity.components().ped().weapon() > 0 && entity.components().ped().weapon() != UNARMED;
    }

    private static boolean alive(Entity entity) {
        return entity != null && entity.kind() == Kind.PED && entity.components().ped() != null
            && entity.components().combat() != null && entity.components().combat().alive();
    }

    private static boolean activeActor(Entity entity, long now) {
        return alive(entity) && entity.ownerId() != null && entity.leaseUntilTick() > now
            && (entity.playerId() == null || entity.playerId().equals(entity.ownerId()));
    }

    private void remember(Threat threat) {
        String key = threat.sourceId + ":" + (threat.victimId == null ? "shot" : threat.victimId);
        threats.remove(key); threats.put(key, threat);
        while (threats.size() > MAX_THREATS) threats.remove(threats.keySet().iterator().next());
    }

    private void advance(long now) {
        if (now < lastTick || now < 0) throw new IllegalArgumentException("AI 规则需要单调服务端 tick");
        lastTick = now;
    }

    private static Vector position(Entity entity) { return entity.components().transform().position(); }
    private static Map<String,Object> map(Object... entries) {
        Map<String,Object> result = new LinkedHashMap<>();
        for (int index = 0; index < entries.length; index += 2) result.put((String) entries[index], entries[index + 1]);
        return result;
    }
    private static Map<String,Object> immutable(Map<String,Object> value) { return Collections.unmodifiableMap(value); }
}
