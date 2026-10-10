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
 * 共同世界的 NPC 决策层。只接收服务器已经接受的动作/伤害和 Registry 快照；
 * 客户端不能直接设置目标、人格或任务。道路驾驶目标由服务端道路图给出，
 * 步行路线来自已安装的局部导航网格，原生驾驶控制及任务动画由租约端引擎执行。
 * 视线使用静态遮挡与租约端几何候选；60 米声音事件仍是有界听觉近似。
 * 不复现 RAGE 的完整视野角、掩体、听觉传播、场景或整套行为树。
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
                          long victimGeneration, Vector origin, Vector sourcePosition, long expires, long observedAt) {}
    private record Hostile(Entity target, String reason, long expires, String responseId, Threat evidence) {}
    private record Sighting(Vector position, long observedAt) {}
    private record SquadKey(String responseId, String targetId, long targetGeneration,
                            String targetOwner, long targetOwnerEpoch) {}
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
    private final PedNavigation pedestrian;
    private final WorldPerception perception;
    private final Map<String,Threat> threats = new LinkedHashMap<>();
    private final Map<String,Decision> decisions = new LinkedHashMap<>();
    private final Map<String,Course> courses = new LinkedHashMap<>();
    private final Map<String,WalkCourse> walks=new LinkedHashMap<>();
    private final Map<SquadKey,Sighting> squadSightings = new LinkedHashMap<>();
    private long walkReplans,walkRecoveries,walkFailures;
    private static final class WalkCourse {
        long generation,ownerEpoch,plannedAt,lastProgress,retryAt,serial;
        String action,reason;
        Vector desired,lastPosition;
        PedNavigation.Route route;
        int nextPoint;
        boolean blockedPortal;
    }
    private long revision, lastTick;

    public WorldAi(String worldEpoch) {
        this(worldEpoch, RoadNetwork.empty());
    }

    public WorldAi(String worldEpoch, RoadNetwork roads) {
        this(worldEpoch,roads,PedNavigation.empty());
    }
    public WorldAi(String worldEpoch, RoadNetwork roads,PedNavigation pedestrian) {
        this(worldEpoch, roads, pedestrian, new WorldCollision(worldEpoch));
    }
    WorldAi(String worldEpoch, RoadNetwork roads, PedNavigation pedestrian, WorldCollision collision) {
        if (worldEpoch == null || !worldEpoch.matches("[A-Za-z0-9_-]{1,64}"))
            throw new IllegalArgumentException("世界 epoch 无效");
        this.worldEpoch = worldEpoch;
        this.roads = Objects.requireNonNull(roads);
        this.pedestrian=Objects.requireNonNull(pedestrian);
        this.perception=new WorldPerception(Objects.requireNonNull(collision));
    }

    public synchronized long revision() { return revision; }
    public synchronized Map<String,Object> perceptionStatus() { return perception.status(); }
    public synchronized Map<String,Object> pedestrianStatus(){
        Map<String,Object> value=new LinkedHashMap<>(pedestrian.status());
        value.put("replans",walkReplans);value.put("stuck_recoveries",walkRecoveries);value.put("failed_routes",walkFailures);
        return Collections.unmodifiableMap(value);
    }

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
            "road_network", roads.metadata(), "hearing_radius", HEARING_RADIUS,
            "perception", perception.status()));
    }

    /** 只能由服务器战斗规则接受动作后调用；拒绝纯动画、无武器和离体的声音。 */
    public synchronized boolean reportAcceptedShot(Entity actor, long weapon, Vector origin, long now) {
        advance(now);
        if (!activeActor(actor, now) || !armed(actor) || actor.components().ped().weapon() != weapon
            || origin == null || position(actor).distance(origin) > 6) return false;
        remember(new Threat(actor.entityId(), actor.generation(), null, 0, origin, position(actor),
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
            position(victim), position(attacker), now + THREAT_MEMORY_TICKS, now));
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
        walks.keySet().removeIf(id->!byId.containsKey(id));
        for (String id : new ArrayList<>(decisions.keySet())) {
            Entity entity = byId.get(id);
            if (entity == null || entity.kind() != Kind.PED || entity.playerId() != null) {
                decisions.remove(id); courses.remove(id); changed.add(id); revision++;
            }
        }
        // Stable order makes task revisions reproducible for equivalent world snapshots.
        List<Entity> npcs = byId.values().stream().filter(entity -> entity.kind() == Kind.PED
            && entity.playerId() == null).sorted(Comparator.comparing(Entity::entityId)).toList();
        Map<String,Hostile> hostiles = new LinkedHashMap<>();
        Map<String,WorldPerception.Contact> contacts = new LinkedHashMap<>();
        Set<SquadKey> activeSquads = new LinkedHashSet<>();
        // Gather observations before making any plans, so all officers in the same
        // response receive the same report regardless of entity iteration order.
        for (Entity npc : npcs) {
            if (!simulated(npc, players, eligibleOwners, now)) continue;
            Hostile hostile = hostile(npc, byId, law, now);
            if (hostile == null) continue;
            hostiles.put(npc.entityId(), hostile);
            WorldPerception.Contact contact = perception.observe(npc, hostile.target, now);
            contacts.put(npc.entityId(), contact);
            if (hostile.responseId != null) {
                SquadKey key = squad(hostile); activeSquads.add(key);
                Sighting previous = squadSightings.get(key);
                if (contact.visible() && (previous == null || contact.seenAt() > previous.observedAt))
                    squadSightings.put(key, new Sighting(contact.lastSeenPosition(), contact.seenAt()));
            }
        }
        // Reports already delivered to the response survive the original observer's
        // death or lease transfer, but never a new target identity or expired memory.
        squadSightings.entrySet().removeIf(entry -> !activeSquads.contains(entry.getKey())
            || now >= entry.getValue().observedAt + THREAT_MEMORY_TICKS);
        perception.retain(hostiles.keySet());
        for (Entity npc : npcs) {
            Hostile hostile = hostiles.get(npc.entityId());
            Plan plan = plan(npc, byId, players, eligibleOwners, law, now, hostile,
                contacts.get(npc.entityId()), hostile == null ? null : squadSightings.get(squad(hostile)));
            if(Set.of("wander","flee","pursue").contains(plan.action) && npc.components().attachment()==null)
                plan=walk(npc,plan,now);
            else walks.remove(npc.entityId());
            Decision old = decisions.get(npc.entityId());
            if (old == null || changed(old, plan, now)) {
                decisions.put(npc.entityId(), new Decision(++revision, now, plan));
                changed.add(npc.entityId());
            }
        }
        return List.copyOf(changed);
    }

    private static SquadKey squad(Hostile hostile) {
        Entity target = hostile.target;
        return new SquadKey(hostile.responseId, target.entityId(), target.generation(),
            target.ownerId(), target.ownerEpoch());
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
            && position(attacker).distance(position(victim)) <= COMBAT_RADIUS
            && perception.visible(attacker, victim, now);
    }

    private Hostile hostile(Entity npc, Map<String,Entity> byId, WorldLaw law, long now) {
        WorldLaw.ResponseInfo response = law == null ? null : law.responseForEntity(npc.entityId());
        if (response != null) {
            Entity target = byId.get(response.targetEntityId());
            if (!"active".equals(response.phase()) || !"officer".equals(response.role())
                || !activeActor(target, now) || target.generation() != response.targetGeneration()) return null;
            return new Hostile(target, "police_pursuit", 0, response.responseId(), evidenceFor(target, now));
        }
        Threat threat = threatFor(npc, byId, now);
        if (threat == null || !armed(npc) || npc.components().attachment() != null
            || !npc.entityId().equals(threat.victimId) || npc.generation() != threat.victimGeneration) return null;
        return new Hostile(byId.get(threat.sourceId), "self_defence", threat.expires, null, threat);
    }

    private Threat evidenceFor(Entity target, long now) {
        Threat latest = null;
        for (Threat threat : threats.values())
            if (threat.sourceId.equals(target.entityId()) && threat.sourceGeneration == target.generation()
                && threat.expires > now && (latest == null || threat.observedAt > latest.observedAt)) latest = threat;
        return latest;
    }

    private Plan plan(Entity npc, Map<String,Entity> byId, Map<String,Entity> players,
                      Set<String> eligible, WorldLaw law, long now, Hostile hostile,
                      WorldPerception.Contact contact, Sighting report) {
        if (!alive(npc)) { courses.remove(npc.entityId()); return idle(npc, "dead"); }
        if (!simulated(npc, players, eligible, now)) { courses.remove(npc.entityId()); return idle(npc, "no_active_lease"); }
        WorldLaw.ResponseInfo response = law == null ? null : law.responseForEntity(npc.entityId());
        if (response != null) {
            if (hostile == null) {
                courses.remove(npc.entityId());
                return idle(npc, "law_frozen");
            }
            return engage(npc, byId, hostile, contact, report, now);
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
            return engage(npc, byId, hostile, contact, null, now);
        }
        return targeted(npc, "flee", attacked ? "attacked" : "heard_danger", target,
            escapeDestination(npc, threat.origin), 3, null, threat.expires);
    }

    private Plan engage(Entity npc, Map<String,Entity> byId, Hostile hostile,
                        WorldPerception.Contact contact, Sighting report, long now) {
        if (npc.components().attachment() == null) courses.remove(npc.entityId());
        if (npc.components().attachment() != null && !canDrive(npc, byId, now)) {
            courses.remove(npc.entityId()); return idle(npc, "passenger");
        }
        Entity target = hostile.target;
        if (contact.visible() && npc.components().attachment() == null && armed(npc)
            && position(npc).distance(position(target)) <= COMBAT_RADIUS)
            return knownTarget(npc, "combat", hostile.reason, target, contact.lastSeenPosition(),
                contact.lastSeenPosition(), 0, null, hostile.expires);

        Sighting known = contact.lastSeenPosition() == null ? null
            : new Sighting(contact.lastSeenPosition(), contact.seenAt());
        boolean shared = report != null && (known == null || report.observedAt > known.observedAt);
        if (shared) known = report;
        Threat evidence = hostile.evidence;
        // A committed shot/damage supplies its historical source position, never
        // the attacker's subsequent transform while hidden behind geometry.
        if (evidence != null && (known == null || evidence.observedAt > known.observedAt)) {
            known = new Sighting(evidence.sourcePosition, evidence.observedAt); shared = false;
        }
        if (known == null || now >= known.observedAt + THREAT_MEMORY_TICKS) {
            courses.remove(npc.entityId()); return idle(npc, "target_not_visible");
        }
        long expires = expiry(hostile.expires, known.observedAt + THREAT_MEMORY_TICKS);
        String reason = contact.visible() ? hostile.reason : shared ? "squad_last_seen" : "last_known_position";
        if (position(npc).distance(known.position) <= 1.5) {
            courses.remove(npc.entityId());
            return knownTarget(npc, "idle", "last_seen_search", target, known.position, null, 0, null, expires);
        }
        if (npc.components().attachment() != null) {
            Plan route = drive(npc, byId.get(npc.components().attachment().entityId()), reason,
                target, known.position, 25, expires, now);
            return new Plan(route.generation, route.ownerEpoch, route.action, route.reason,
                route.targetId, route.targetGeneration, route.targetId == null ? null : known.position,
                route.destination, route.speed, route.vehicleId, route.expires);
        }
        return knownTarget(npc, "pursue", reason, target, known.position, known.position, 2.5, null, expires);
    }

    private static long expiry(long first, long second) { return first == 0 ? second : Math.min(first, second); }

    private static Plan knownTarget(Entity npc, String action, String reason, Entity target, Vector known,
                                    Vector destination, double speed, String vehicle, long expires) {
        return new Plan(npc.generation(), npc.ownerEpoch(), action, reason, target.entityId(), target.generation(),
            known, destination, speed, vehicle, expires);
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

    private Plan walk(Entity npc,Plan requested,long now){
        // Keep the explicitly limited legacy mode for clients/server tests without navigation data.
        if(pedestrian.polygonCount()==0)return requested;
        Vector current=position(npc);WalkCourse course=walks.get(npc.entityId());
        boolean identity=course==null || course.generation!=npc.generation() || course.ownerEpoch!=npc.ownerEpoch()
            || !requested.action.equals(course.action) || !requested.reason.equals(course.reason);
        if(identity){course=new WalkCourse();course.generation=npc.generation();course.ownerEpoch=npc.ownerEpoch();
            course.action=requested.action;course.reason=requested.reason;course.lastPosition=current;course.lastProgress=now;
            walks.put(npc.entityId(),course);}
        if(current.distance(course.lastPosition)>=.35){course.lastPosition=current;course.lastProgress=now;course.blockedPortal=false;}
        boolean stuck=course.route!=null && course.route.reached() && now-course.lastProgress>=3000;
        boolean newDestination=course.desired==null?requested.destination!=null:
            requested.destination==null || course.desired.distance(requested.destination)>3;
        if(identity || now>=course.retryAt && (course.route==null || !course.route.reached() || newDestination || stuck)){
            if(newDestination)course.blockedPortal=false;
            if(stuck){walkRecoveries++;course.serial++;course.blockedPortal=true;}
            course.desired=requested.destination;course.plannedAt=now;course.lastProgress=now;
            course.nextPoint=1;course.retryAt=now+1000;walkReplans++;
            PedNavigation.Point from=navPoint(current);
            if("wander".equals(requested.action))course.route=pedestrian.wander(from,
                Objects.hash(worldEpoch,npc.entityId(),npc.generation(),course.serial),30);
            else course.route=course.blockedPortal?pedestrian.detour(from,navPoint(requested.destination),4,12000):
                pedestrian.route(from,navPoint(requested.destination),4,12000);
            if(!course.route.reached())walkFailures++;
        }
        if(course.route==null || !course.route.reached())return idle(npc,"walk_navigation_unavailable");
        List<PedNavigation.Point> points=course.route.points();
        while(course.nextPoint<points.size() && navPoint(current).distance(points.get(course.nextPoint))<.3)course.nextPoint++;
        if(course.nextPoint>=points.size()){
            if("wander".equals(requested.action)){course.route=null;course.serial++;course.retryAt=now+500;}
            return idle(npc,"walk_destination_reached");
        }
        PedNavigation.Point previous=points.get(Math.max(0,course.nextPoint-1)),next=points.get(course.nextPoint);
        if(distanceToSegment(navPoint(current),previous,next)>2.5){course.route=null;course.retryAt=now+500;return idle(npc,"walk_replanning");}
        // Never skip a portal around a corner: one straight native task ends at this segment's next portal.
        double distance=navPoint(current).distance(next),fraction=distance>2?2/distance:1;
        Vector destination=new Vector(current.x()+(next.x()-current.x())*fraction,
            current.y()+(next.y()-current.y())*fraction,current.z()+(next.z()-current.z())*fraction);
        return new Plan(requested.generation,requested.ownerEpoch,requested.action,
            stuck?"walk_recovery":requested.reason,requested.targetId,requested.targetGeneration,
            requested.targetPosition,destination,requested.speed,requested.vehicleId,requested.expires);
    }
    private static PedNavigation.Point navPoint(Vector p){return new PedNavigation.Point(p.x(),p.y(),p.z());}
    private static double distanceToSegment(PedNavigation.Point p,PedNavigation.Point a,PedNavigation.Point b){
        double dx=b.x()-a.x(),dy=b.y()-a.y(),dz=b.z()-a.z(),length=dx*dx+dy*dy+dz*dz;
        double t=length<1e-9?0:Math.max(0,Math.min(1,((p.x()-a.x())*dx+(p.y()-a.y())*dy+(p.z()-a.z())*dz)/length));
        return p.distance(new PedNavigation.Point(a.x()+dx*t,a.y()+dy*t,a.z()+dz*t));
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
        // Walking portals may be less than three metres apart. Publish each new
        // short segment or the client can reach an obsolete waypoint and stop.
        if(Set.of("wander","flee","pursue").contains(next.action)
            && value.destination!=null && next.destination!=null
            && value.destination.distance(next.destination)>.2)return true;
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
