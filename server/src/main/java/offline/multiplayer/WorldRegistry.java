package offline.multiplayer;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * 统一世界的确定性登记、事务和所有权内核。没有 socket、native 句柄、NPC AI 或物理仿真。
 * Trusted 后缀的方法只供服务端已验证的规则调用，不能直接映射成客户端任意写入接口。
 * tick 使用调用方提供的单调服务端时间；默认每秒 1000 tick，便于接入单调毫秒时钟。
 */
public final class WorldRegistry {
    public enum Kind { PED, VEHICLE, OBJECT }
    public enum Change { CREATE, UPDATE, SEAT, OWNER, DISCONNECT, RESPAWN, DELETE }

    public static final class Rejection extends Exception {
        public final String code;
        Rejection(String code, String message) { super(message); this.code = code; }
    }

    public record Limits(int maxEntities, int historyEntries, int tombstoneEntries,
                         int ticksPerSecond, long defaultLeaseTicks) {
        public Limits {
            if (maxEntities < 1 || maxEntities > 100_000 || historyEntries < 1 || historyEntries > 100_000
                    || tombstoneEntries < 1 || tombstoneEntries > 100_000 || ticksPerSecond < 1
                    || ticksPerSecond > 10_000 || defaultLeaseTicks < 1 || defaultLeaseTicks > ticksPerSecond * 60L)
                throw new IllegalArgumentException("世界容量、时间单位或租约范围无效");
        }
        public static Limits defaults() { return new Limits(4096, 4096, 4096, 1000, 5000); }
    }

    public record Vector(double x, double y, double z) {
        public Vector { finite(x, 16000, "x"); finite(y, 16000, "y"); finite(z, 16000, "z"); }
        public List<Double> values() { return List.of(x, y, z); }
        public double length() { return Math.hypot(Math.hypot(x, y), z); }
        public double distance(Vector other) { return Math.hypot(Math.hypot(x-other.x, y-other.y), z-other.z); }
        public static Vector zero() { return new Vector(0, 0, 0); }
    }

    public record Rotation(double x, double y, double z, double w) {
        public Rotation {
            finite(x, 1.01, "旋转 x"); finite(y, 1.01, "旋转 y");
            finite(z, 1.01, "旋转 z"); finite(w, 1.01, "旋转 w");
            double norm = Math.sqrt(x*x+y*y+z*z+w*w);
            if (Math.abs(norm-1) > .01) throw new IllegalArgumentException("旋转必须是单位四元数");
            x /= norm; y /= norm; z /= norm; w /= norm;
        }
        public static Rotation heading(double degrees) {
            if (!Double.isFinite(degrees) || degrees < 0 || degrees > 360)
                throw new IllegalArgumentException("朝向必须在 0–360 度内");
            double half = Math.toRadians(degrees) / 2;
            return new Rotation(0, 0, Math.sin(half), Math.cos(half));
        }
        public double heading() {
            double degrees = Math.toDegrees(Math.atan2(2*(w*z+x*y), 1-2*(y*y+z*z)));
            return (degrees+360) % 360;
        }
        public List<Double> values() { return List.of(x, y, z, w); }
    }

    public record Transform(Vector position, Rotation rotation, Vector velocity, Vector angularVelocity) {
        public Transform {
            Objects.requireNonNull(position); Objects.requireNonNull(rotation);
            Objects.requireNonNull(velocity); Objects.requireNonNull(angularVelocity);
            if (velocity.length() > 300 || angularVelocity.length() > 30)
                throw new IllegalArgumentException("速度或角速度超出范围");
        }
        public static Transform at(Vector position, double heading) {
            return new Transform(position, Rotation.heading(heading), Vector.zero(), Vector.zero());
        }
    }

    public record Appearance(List<List<Integer>> components, List<List<Integer>> props,
                             List<List<Double>> overlays, List<Integer> hair) {
        public Appearance {
            components = integerRows(components, 12, 3, false);
            props = integerRows(props, 8, 2, true);
            if (overlays != null) {
                if (overlays.size() != 13) throw new IllegalArgumentException("妆容数量必须为 13");
                List<List<Double>> copy = new ArrayList<>();
                for (List<Double> row : overlays) {
                    if (row == null || row.size() != 5) throw new IllegalArgumentException("妆容参数必须为五个数值");
                    ranged(row.get(0), 0, 255, true); ranged(row.get(1), 0, 1, false);
                    ranged(row.get(2), 0, 2, true); ranged(row.get(3), 0, 63, true); ranged(row.get(4), 0, 63, true);
                    copy.add(List.copyOf(row));
                }
                overlays = List.copyOf(copy);
            }
            if (hair != null) {
                if (hair.size() != 2) throw new IllegalArgumentException("发色参数必须为两个数值");
                for (Integer value : hair) if (value == null || value < 0 || value > 63)
                    throw new IllegalArgumentException("发色参数无效");
                hair = List.copyOf(hair);
            }
        }
        public Map<String, Object> values() {
            Map<String, Object> value = map("components", components, "props", props);
            if (overlays != null) value.put("overlays", overlays);
            if (hair != null) value.put("hair", hair);
            return immutable(value);
        }
    }

    public record Actions(boolean aiming, boolean reloading, boolean jumping, boolean ducking, boolean sprinting) {
        public static Actions idle() { return new Actions(false, false, false, false, false); }
        public Map<String, Object> values() {
            return immutable(map("aiming", aiming, "reloading", reloading, "jumping", jumping,
                "ducking", ducking, "sprinting", sprinting));
        }
    }

    /** 客户端可提议的表现只允许这两个固定类型，没有血量、座位和生命周期字段。 */
    public sealed interface ClientView permits PedView, VehicleView {}
    public record PedView(Appearance appearance, Actions actions, long weapon, boolean shooting,
                          Vector aimTarget) implements ClientView {
        public PedView { unsigned(weapon); Objects.requireNonNull(actions); }
    }
    public record VehicleView(boolean engineOn, boolean lightsOn) implements ClientView {}
    public record Combat(int health, int maxHealth, int kills, int deaths, long respawnAtTick) {
        public Combat {
            if (maxHealth < 1 || maxHealth > 10000 || health < 0 || health > maxHealth || kills < 0 || deaths < 0
                    || respawnAtTick < 0 || (health > 0 && respawnAtTick != 0))
                throw new IllegalArgumentException("权威战斗状态无效");
        }
        public boolean alive() { return health > 0; }
    }
    public record Vehicle(double engineHealth, double bodyHealth, Map<String, String> seats, VehicleView view) {
        public Vehicle {
            ranged(engineHealth, -4000, 1000, false); ranged(bodyHealth, 0, 1000, false);
            Objects.requireNonNull(view);
            if (seats == null || !seats.containsKey("driver") || seats.size() > 17)
                throw new IllegalArgumentException("车辆座位表无效");
            Map<String, String> copy = new LinkedHashMap<>();
            Set<String> occupants = new LinkedHashSet<>();
            for (Map.Entry<String, String> seat : seats.entrySet()) {
                if (seat.getKey() == null || !seat.getKey().matches("driver|passenger:(?:[0-9]|1[0-5])"))
                    throw new IllegalArgumentException("座位名称无效");
                if (seat.getValue() != null && !occupants.add(identifier(seat.getValue(), "乘客实体")))
                    throw new IllegalArgumentException("同一实体不能占两个座位");
                copy.put(seat.getKey(), seat.getValue());
            }
            seats = immutable(copy);
        }
        public static Vehicle empty(int passengers) {
            if (passengers < 0 || passengers > 16) throw new IllegalArgumentException("乘客座位数量无效");
            Map<String, String> seats = new LinkedHashMap<>(); seats.put("driver", null);
            for (int index=0; index<passengers; index++) seats.put("passenger:"+index, null);
            return new Vehicle(1000, 1000, seats, new VehicleView(false, false));
        }
    }
    public record ObjectState(boolean dynamic) {}
    public record Attachment(String entityId, String seat) {
        public Attachment {
            identifier(entityId, "载具实体");
            if (seat == null || !seat.matches("driver|passenger:(?:[0-9]|1[0-5])"))
                throw new IllegalArgumentException("挂接座位无效");
        }
    }
    public record Components(Transform transform, PedView ped, Vehicle vehicle, ObjectState object,
                             Combat combat, Attachment attachment) {
        public Components { Objects.requireNonNull(transform); }
        public static Components ped(Transform transform, PedView view, Combat combat) {
            return new Components(transform, Objects.requireNonNull(view), null, null, combat, null);
        }
        public static Components vehicle(Transform transform, Vehicle vehicle) {
            return new Components(transform, null, Objects.requireNonNull(vehicle), null, null, null);
        }
        public static Components object(Transform transform, boolean dynamic) {
            return new Components(transform, null, null, new ObjectState(dynamic), null, null);
        }
    }

    public record Entity(String entityId, Kind kind, long model, String playerId, long revision,
                         long generation, String ownerId, long ownerEpoch, long leaseUntilTick,
                         long lastInputSequence, Components components) {}
    public record Tombstone(String entityId, Kind kind, long revision, long generation, long worldRevision) {}
    public record Commit(String worldEpoch, long worldRevision, long worldTick, String eventId,
                         Change change, List<Entity> entities, List<Tombstone> deleted) {
        public Commit { entities=List.copyOf(entities); deleted=List.copyOf(deleted); }
    }
    public record Snapshot(String worldEpoch, long cutRevision, long worldTick, List<Entity> entities,
                           List<Tombstone> tombstones) {
        public Snapshot { entities=List.copyOf(entities); tombstones=List.copyOf(tombstones); }
    }
    public record Delta(boolean snapshotRequired, long cutRevision, List<Commit> commits) {
        public Delta { commits=List.copyOf(commits); }
    }
    public record Proposal(String worldEpoch, String entityId, long ownerEpoch, long inputSequence,
                           long basedOnRevision, Transform transform, ClientView view) {}

    private final String worldEpoch;
    private final Limits limits;
    private final Map<Kind, Set<Long>> modelCatalog;
    private final Set<Long> weaponCatalog;
    private final Map<String, Entity> entities = new LinkedHashMap<>();
    private final Map<String, String> playerEntities = new LinkedHashMap<>();
    private final Map<String,Long> generationStarts=new LinkedHashMap<>();
    private final Map<String, Tombstone> tombstones = new LinkedHashMap<>();
    private final Map<String, MotionBudget> motion = new LinkedHashMap<>();
    private final ArrayDeque<Commit> history = new ArrayDeque<>();
    private long nextEntityId, worldRevision, worldTick;
    private record MotionBudget(long tick, double credit) {}

    public WorldRegistry(String worldEpoch, Map<Kind, Set<Long>> modelCatalog, Set<Long> weaponCatalog) {
        this(worldEpoch, modelCatalog, weaponCatalog, Limits.defaults());
    }
    public WorldRegistry(String worldEpoch, Map<Kind, Set<Long>> modelCatalog, Set<Long> weaponCatalog, Limits limits) {
        if (worldEpoch == null || !worldEpoch.matches("[A-Za-z0-9_-]{1,64}"))
            throw new IllegalArgumentException("世界 epoch 无效");
        this.worldEpoch=worldEpoch; this.limits=Objects.requireNonNull(limits);
        Map<Kind, Set<Long>> models = new EnumMap<>(Kind.class);
        for (Kind kind : Kind.values()) {
            Set<Long> values = Set.copyOf(modelCatalog.getOrDefault(kind, Set.of()));
            values.forEach(WorldRegistry::unsigned); models.put(kind, values);
        }
        this.modelCatalog=Collections.unmodifiableMap(models);
        this.weaponCatalog=Set.copyOf(weaponCatalog); this.weaponCatalog.forEach(WorldRegistry::unsigned);
    }

    public String worldEpoch() { return worldEpoch; }
    public synchronized Entity entity(String id) { return entities.get(id); }
    public synchronized Entity playerEntity(String playerId) { return entities.get(playerEntities.get(playerId)); }
    public synchronized long generationStartRevision(String id)throws Rejection{
        require(id);return generationStarts.getOrDefault(id,1L);
    }
    public synchronized Snapshot snapshot() {
        return new Snapshot(worldEpoch, worldRevision, worldTick, new ArrayList<>(entities.values()),
            new ArrayList<>(tombstones.values()));
    }
    public synchronized Delta changesSince(String epoch, long afterRevision) {
        if (!worldEpoch.equals(epoch) || afterRevision < 0 || afterRevision > worldRevision
                || (!history.isEmpty() && afterRevision < history.peekFirst().worldRevision-1))
            return new Delta(true, worldRevision, List.of());
        return new Delta(false, worldRevision, history.stream().filter(commit -> commit.worldRevision>afterRevision).toList());
    }

    public synchronized Commit createTrusted(Kind kind, long model, String playerId, Components components,
                                              String ownerId, long leaseUntilTick, long nowTick) throws Rejection {
        tick(nowTick); validate(kind, model, components);
        return create(kind,model,playerId,components,ownerId,leaseUntilTick,nowTick);
    }

    private Commit create(Kind kind,long model,String playerId,Components components,
                          String ownerId,long leaseUntilTick,long nowTick) throws Rejection {
        if (entities.size() >= limits.maxEntities) throw reject("world_full", "世界实体数达到上限");
        if (playerId != null) {
            identifier(playerId, "玩家身份");
            if (kind != Kind.PED || playerEntities.containsKey(playerId)) throw reject("duplicate_player", "玩家已有角色实体");
        }
        lease(ownerId, leaseUntilTick, nowTick);
        if (components.attachment != null || (components.vehicle != null && components.vehicle.seats.values().stream().anyMatch(Objects::nonNull)))
            throw reject("invalid_component", "新实体不能绕过座位事务挂接其它实体");
        String id="w:"+worldEpoch+":"+(++nextEntityId);
        Entity entity = new Entity(id, kind, model, playerId, 1, 1, ownerId, 1, leaseUntilTick, -1, components);
        entities.put(id, entity); motion.put(id, new MotionBudget(nowTick, 2));
        generationStarts.put(id,1L);
        if (playerId != null) playerEntities.put(playerId, id);
        return commit(Change.CREATE, List.of(entity), List.of());
    }

    /**
     * 投影现有 CombatWorld 已接受的玩家状态；不能直接接收原始客户端消息。
     * 保留旧协议的有效 uint 模型/武器，仅检验结构，不用新实体白名单改变旧协议结果。
     * 每次可信投影续租；断线撤销后再次确认玩家输入时重授新 epoch，旧所有者包无法写入。
     */
    public synchronized Commit projectPlayerTrusted(String playerId, long model, Transform transform,
                                                     PedView view, Combat combat, long nowTick) throws Rejection {
        tick(nowTick); Entity old=playerEntity(playerId);
        identifier(playerId,"玩家身份"); Components initial=Components.ped(transform,view,combat);
        validateShape(Kind.PED,model,initial);
        if (old == null) return create(Kind.PED, model, playerId, initial,playerId,nowTick+limits.defaultLeaseTicks,nowTick);
        if(old.components.attachment!=null && combat.alive())
            transform=require(old.components.attachment.entityId).components.transform;
        Components value=new Components(transform, view, null, null, combat, old.components.attachment);
        boolean resumedLease=!playerId.equals(old.ownerId) || old.leaseUntilTick<=nowTick;
        boolean respawned=old.components.combat!=null && !old.components.combat.alive() && combat!=null && combat.alive();
        Map<String,Entity> updates=new LinkedHashMap<>();
        if (respawned && old.components.attachment!=null) {
            detach(old,updates,nowTick);
            value=new Components(transform,view,null,null,combat,null);
        }
        if (respawned) value=new Components(transform,new PedView(view.appearance,Actions.idle(),view.weapon,false,null),
            null,null,combat,null);
        Entity updated=new Entity(old.entityId, old.kind, model, old.playerId, old.revision+1,
            old.generation+(respawned?1:0),playerId,old.ownerEpoch+(resumedLease||respawned?1:0),
            nowTick+limits.defaultLeaseTicks,resumedLease||respawned?-1:old.lastInputSequence,value);
        updates.put(old.entityId,updated); updates.forEach(entities::put);
        if(respawned)generationStarts.put(old.entityId,updated.revision);
        motion.put(old.entityId, new MotionBudget(nowTick, 2));
        return commit(respawned?Change.RESPAWN:Change.UPDATE,new ArrayList<>(updates.values()),List.of());
    }

    public synchronized Commit propose(String actorId, Proposal proposal, long nowTick) throws Rejection {
        tick(nowTick); Objects.requireNonNull(proposal);
        if (!worldEpoch.equals(proposal.worldEpoch)) throw reject("wrong_world", "输入属于另一世界");
        Entity old=require(proposal.entityId); owner(old, actorId, proposal.ownerEpoch, nowTick);
        if (proposal.inputSequence < 0 || proposal.inputSequence > 9_007_199_254_740_991L
                || proposal.inputSequence <= old.lastInputSequence) throw reject("stale_input", "输入序号必须递增");
        if (proposal.basedOnRevision < 0 || proposal.basedOnRevision > old.revision)
            throw reject("invalid_revision", "输入基线版本无效");
        Transform transform=Objects.requireNonNull(proposal.transform);
        if (old.components.attachment != null) throw reject("attached_entity", "已入座的角色不能独立提交移动");
        if (old.components.combat != null && !old.components.combat.alive())
            throw reject("dead_entity", "死亡实体不能提交动态状态");
        if (old.kind == Kind.OBJECT && !old.components.object.dynamic)
            throw reject("static_entity", "静态物件不能由客户端移动");
        double speed=old.kind==Kind.PED ? 14 : old.kind==Kind.VEHICLE ? 150 : 100;
        MotionBudget previous=motion.get(old.entityId);
        double elapsed=Math.min(2, (nowTick-previous.tick)/(double)limits.ticksPerSecond);
        double credit=Math.min(speed*2+2, previous.credit+speed*elapsed);
        double travel=old.components.transform.position.distance(transform.position);
        if (travel > credit || transform.velocity.length() > speed)
            throw reject("invalid_movement", "实体移动超过所有者速度预算");
        PedView ped=old.components.ped; Vehicle vehicle=old.components.vehicle;
        if (proposal.view != null) {
            if (old.kind==Kind.PED && proposal.view instanceof PedView value) ped=value;
            else if (old.kind==Kind.VEHICLE && proposal.view instanceof VehicleView value)
                vehicle=new Vehicle(vehicle.engineHealth, vehicle.bodyHealth, vehicle.seats, value);
            else throw reject("invalid_component", "表现组件与实体类型不符");
        }
        Components value=new Components(transform, ped, vehicle, old.components.object, old.components.combat, old.components.attachment);
        validate(old.kind, old.model, value);
        Entity updated=new Entity(old.entityId, old.kind, old.model, old.playerId, old.revision+1, old.generation,
            old.ownerId, old.ownerEpoch, old.leaseUntilTick, proposal.inputSequence, value);
        entities.put(old.entityId, updated); motion.put(old.entityId, new MotionBudget(nowTick, credit-travel));
        List<Entity> updates=new ArrayList<>();updates.add(updated);
        if(old.kind==Kind.VEHICLE)for(String occupant:value.vehicle.seats.values())if(occupant!=null){
            Entity passenger=require(occupant);Components c=passenger.components;
            Entity moved=updated(passenger,new Components(transform,c.ped,c.vehicle,c.object,c.combat,c.attachment));
            entities.put(occupant,moved);updates.add(moved);
        }
        return commit(Change.UPDATE, updates, List.of());
    }

    /** 有界批次全部验证成功才可提交；不可变实体允许在锁内暂存并回滚，最终只有一个世界事务。 */
    public synchronized Commit proposeBatch(String actorId,List<Proposal> proposals,long nowTick)throws Rejection{
        return proposeBatch(actorId,proposals,nowTick,Set.of());
    }
    /** 调用方仅传入已完成引擎ready的NPC依赖，客户端消息不能选择续期名单。 */
    public synchronized Commit proposeBatch(String actorId,List<Proposal> proposals,long nowTick,Set<String> activeDependents)throws Rejection{
        if(proposals==null || proposals.isEmpty() || proposals.size()>24)throw reject("invalid_batch","更新批次必须包含1–24个实体");
        Set<String> ids=new LinkedHashSet<>();for(Proposal proposal:proposals)
            if(proposal==null || !ids.add(proposal.entityId))throw reject("invalid_batch","更新批次不能包含重复实体");
        if(activeDependents==null || activeDependents.size()>24)throw reject("invalid_batch","活动依赖数量无效");
        for(String id:activeDependents){Entity dependent=require(id);
            if(dependent.kind!=Kind.PED || dependent.playerId!=null || dependent.components.attachment==null
                || !ids.contains(dependent.components.attachment.entityId) || !actorId.equals(dependent.ownerId)
                || dependent.leaseUntilTick<=nowTick)throw reject("stale_owner","依赖实体不属于本次有效载具租约");}
        Map<String,Entity> before=new LinkedHashMap<>(entities);Map<String,MotionBudget> previousMotion=new LinkedHashMap<>(motion);
        ArrayDeque<Commit> previousHistory=new ArrayDeque<>(history);long previousRevision=worldRevision,previousTick=worldTick;
        try{
            for(Proposal proposal:proposals)propose(actorId,proposal,nowTick);
            for(Proposal proposal:proposals){Entity value=entities.get(proposal.entityId);
                entities.put(value.entityId,new Entity(value.entityId,value.kind,value.model,value.playerId,value.revision,value.generation,
                    value.ownerId,value.ownerEpoch,nowTick+limits.defaultLeaseTicks,value.lastInputSequence,value.components));}
            for(String id:activeDependents){Entity value=entities.get(id);
                entities.put(id,new Entity(value.entityId,value.kind,value.model,value.playerId,value.revision,value.generation,
                    value.ownerId,value.ownerEpoch,nowTick+limits.defaultLeaseTicks,value.lastInputSequence,value.components));}
            List<Entity> changed=new ArrayList<>();for(Entity value:entities.values())
                if(!value.equals(before.get(value.entityId)))changed.add(value);
            history.clear();history.addAll(previousHistory);worldRevision=previousRevision;
            return commit(Change.UPDATE,changed,List.of());
        }catch(Rejection|RuntimeException error){
            entities.clear();entities.putAll(before);motion.clear();motion.putAll(previousMotion);
            history.clear();history.addAll(previousHistory);worldRevision=previousRevision;worldTick=previousTick;
            throw error;
        }
    }

    public synchronized Commit setCombatTrusted(String id, Combat combat, long expectedRevision, long nowTick) throws Rejection {
        tick(nowTick); Entity old=require(id); revision(old, expectedRevision);
        if (old.components.combat==null) throw reject("invalid_component", "实体没有战斗组件");
        Components c=old.components;
        Entity updated=updated(old, new Components(c.transform, c.ped, c.vehicle, c.object, Objects.requireNonNull(combat), c.attachment));
        entities.put(id, updated); return commit(Change.UPDATE, List.of(updated), List.of());
    }

    /** 多实体战斗结果一次提交；规则模块先计算伤害和计分，不能分批产生半次击杀。 */
    public synchronized Commit setCombatBatchTrusted(Map<String,Combat> values,long nowTick) throws Rejection {
        tick(nowTick); Map<String,Entity> updates=new LinkedHashMap<>();
        for (Map.Entry<String,Combat> item:values.entrySet()) {
            Entity entity=require(item.getKey());
            if (entity.components.combat==null || item.getValue()==null)
                throw reject("invalid_component","实体没有有效战斗组件");
        }
        for (Map.Entry<String,Combat> item:values.entrySet()) {
            Entity entity=updates.getOrDefault(item.getKey(),entities.get(item.getKey()));
            if (!item.getValue().alive() && entity.components.attachment!=null) {
                detach(entity,updates,nowTick);entity=updates.get(entity.entityId);
            }
            Components c=entity.components;
            updates.put(entity.entityId,updated(entity,new Components(c.transform,c.ped,c.vehicle,c.object,item.getValue(),c.attachment)));
        }
        updates.forEach(entities::put);return commit(Change.UPDATE,new ArrayList<>(updates.values()),List.of());
    }

    public synchronized Commit setVehicleHealthTrusted(String id,double engineHealth,double bodyHealth,
                                                        long expectedRevision,long nowTick) throws Rejection {
        tick(nowTick); Entity old=require(id); revision(old,expectedRevision);
        if (old.kind!=Kind.VEHICLE) throw reject("invalid_component","只有车辆有引擎和车身生命值");
        Components c=old.components; Vehicle vehicle=c.vehicle;
        Entity updated=updated(old,new Components(c.transform,null,
            new Vehicle(engineHealth,bodyHealth,vehicle.seats,vehicle.view),null,c.combat,null));
        entities.put(id,updated); return commit(Change.UPDATE,List.of(updated),List.of());
    }

    public synchronized Commit respawnTrusted(String id, Transform transform, Combat combat,
                                               long expectedRevision, long nowTick) throws Rejection {
        tick(nowTick); Entity old=require(id); revision(old, expectedRevision);
        if (old.components.combat==null || !combat.alive()) throw reject("invalid_component", "重生需要存活战斗组件");
        Map<String,Entity> updates=new LinkedHashMap<>();
        if (old.components.attachment!=null) detach(old,updates,nowTick);
        PedView ped=old.components.ped;
        if (ped!=null) ped=new PedView(ped.appearance, Actions.idle(), ped.weapon, false, null);
        Components c=new Components(transform, ped, old.components.vehicle, old.components.object, combat, null);
        if(old.playerId!=null)validateShape(old.kind,old.model,c);else validate(old.kind,old.model,c);
        Entity updated=new Entity(id, old.kind, old.model, old.playerId, old.revision+1, old.generation+1,
            old.ownerId, old.ownerEpoch+1, old.leaseUntilTick, -1, c);
        updates.put(id,updated); updates.forEach(entities::put); motion.put(id,new MotionBudget(nowTick,2));
        generationStarts.put(id,updated.revision);
        return commit(Change.RESPAWN,new ArrayList<>(updates.values()),List.of());
    }

    public synchronized Commit grantOwnerTrusted(String id, String ownerId, long expectedRevision,
                                                  long leaseUntilTick, long nowTick) throws Rejection {
        tick(nowTick); Entity old=require(id); revision(old, expectedRevision); lease(ownerId, leaseUntilTick, nowTick);
        if (ownerId==null) throw reject("invalid_owner", "迁移目标不能为空");
        Entity updated=owned(old, ownerId, leaseUntilTick);
        entities.put(id, updated); motion.put(id, new MotionBudget(nowTick, 2));
        return commit(Change.OWNER, List.of(updated), List.of());
    }

    /** 同一租约续期不改变 fencing epoch 和输入序号。 */
    public synchronized Commit renewLeaseTrusted(String id, long ownerEpoch, long leaseUntilTick, long nowTick) throws Rejection {
        tick(nowTick); Entity old=require(id);
        if (old.ownerId==null || old.ownerEpoch!=ownerEpoch || old.leaseUntilTick<=nowTick)
            throw reject("stale_owner", "租约已撤销或过期");
        lease(old.ownerId, leaseUntilTick, nowTick);
        if (leaseUntilTick < old.leaseUntilTick) throw reject("invalid_lease", "续期不能缩短租约");
        Entity updated=new Entity(id, old.kind, old.model, old.playerId, old.revision+1, old.generation,
            old.ownerId, old.ownerEpoch, leaseUntilTick, old.lastInputSequence, old.components);
        entities.put(id, updated); return commit(Change.OWNER, List.of(updated), List.of());
    }

    public synchronized Commit enterSeat(String actorId, String pedId, long pedOwnerEpoch, String vehicleId,
                                          String seat, long vehicleRevision, long nowTick) throws Rejection {
        tick(nowTick); Entity ped=require(pedId); Entity vehicle=require(vehicleId);
        owner(ped, actorId, pedOwnerEpoch, nowTick);baseline(vehicle,vehicleRevision);
        if (ped.kind!=Kind.PED || vehicle.kind!=Kind.VEHICLE || !actorId.equals(ped.playerId))
            throw reject("invalid_seat", "只能请求自己的玩家角色进入车辆");
        if (ped.components.combat!=null && !ped.components.combat.alive()) throw reject("dead_entity", "死亡角色不能入座");
        if (ped.components.attachment!=null || !vehicle.components.vehicle.seats.containsKey(seat))
            throw reject("seat_unavailable", "座位不存在、被占用或角色已入座");
        Entity evicted=null;String occupant=vehicle.components.vehicle.seats.get(seat);
        if(occupant!=null){
            Entity current=require(occupant);
            if(!"driver".equals(seat) || current.kind!=Kind.PED || current.playerId!=null)
                throw reject("seat_unavailable","已有玩家或其它乘客占用座位");
            Components c=current.components;Vector position=vehicle.components.transform.position;
            Transform exit=new Transform(new Vector(Math.min(16000,position.x+1),Math.min(16000,position.y+1),position.z),
                vehicle.components.transform.rotation,Vector.zero(),Vector.zero());
            evicted=updated(current,new Components(exit,c.ped,null,null,c.combat,null));
        }
        if (ped.components.transform.position.distance(vehicle.components.transform.position)>6)
            throw reject("too_far", "角色距离车辆过远");
        Map<String,String> seats=new LinkedHashMap<>(vehicle.components.vehicle.seats); seats.put(seat,pedId);
        Vehicle oldVehicle=vehicle.components.vehicle;
        Components vc=new Components(vehicle.components.transform,null,new Vehicle(oldVehicle.engineHealth,
            oldVehicle.bodyHealth,seats,oldVehicle.view),null,vehicle.components.combat,null);
        Entity updatedVehicle=updated(vehicle,vc);
        if ("driver".equals(seat)) updatedVehicle=ownedAtRevision(updatedVehicle,actorId,nowTick+limits.defaultLeaseTicks);
        Components pc=ped.components;
        Entity updatedPed=updated(ped,new Components(pc.transform,pc.ped,null,null,pc.combat,new Attachment(vehicleId,seat)));
        entities.put(vehicleId,updatedVehicle); entities.put(pedId,updatedPed);
        if(evicted!=null)entities.put(evicted.entityId,evicted);
        motion.put(vehicleId,new MotionBudget(nowTick,2));
        return commit(Change.SEAT,evicted==null?List.of(updatedVehicle,updatedPed):List.of(updatedVehicle,updatedPed,evicted),List.of());
    }

    public synchronized Commit leaveSeat(String actorId, String pedId, long pedOwnerEpoch, long nowTick) throws Rejection {
        tick(nowTick); Entity ped=require(pedId); owner(ped,actorId,pedOwnerEpoch,nowTick);
        if (!actorId.equals(ped.playerId) || ped.components.attachment==null)
            throw reject("invalid_seat", "玩家角色未入座");
        Map<String,Entity> updates=new LinkedHashMap<>(); detach(ped,updates,nowTick);
        updates.forEach(entities::put); return commit(Change.SEAT,new ArrayList<>(updates.values()),List.of());
    }

    /** 人口规则给NPC分配座位，不向客户端暴露直接占座写接口。 */
    public synchronized Commit assignNpcSeatTrusted(String pedId,String vehicleId,String seat,long nowTick)throws Rejection{
        tick(nowTick);Entity ped=require(pedId),vehicle=require(vehicleId);
        if(ped.kind!=Kind.PED || ped.playerId!=null || vehicle.kind!=Kind.VEHICLE || ped.components.attachment!=null
            || !vehicle.components.vehicle.seats.containsKey(seat) || vehicle.components.vehicle.seats.get(seat)!=null)
            throw reject("invalid_seat","NPC座位分配无效");
        Map<String,String> seats=new LinkedHashMap<>(vehicle.components.vehicle.seats);seats.put(seat,pedId);
        Vehicle v=vehicle.components.vehicle;
        Entity car=updated(vehicle,new Components(vehicle.components.transform,null,new Vehicle(v.engineHealth,v.bodyHealth,seats,v.view),null,vehicle.components.combat,null));
        Components c=ped.components;
        Entity passenger=updated(ped,new Components(vehicle.components.transform,c.ped,null,null,c.combat,new Attachment(vehicleId,seat)));
        entities.put(vehicleId,car);entities.put(pedId,passenger);return commit(Change.SEAT,List.of(car,passenger),List.of());
    }

    /** 断线立即撤销仿真所有权并释放该玩家座位；实体保留，不冒充服务器继续仿真。 */
    public synchronized Commit disconnectOwnerTrusted(String actorId,long nowTick) throws Rejection {
        tick(nowTick); identifier(actorId,"玩家身份"); Map<String,Entity> updates=new LinkedHashMap<>();
        for (Entity entity:entities.values()) {
            if (actorId.equals(entity.ownerId)) updates.put(entity.entityId,owned(entity,null,0));
        }
        Entity player=playerEntity(actorId);
        if (player!=null && player.components.attachment!=null) detach(updates.getOrDefault(player.entityId,player),updates,nowTick);
        updates.forEach(entities::put);
        for (String id:updates.keySet()) motion.put(id,new MotionBudget(nowTick,2));
        return commit(Change.DISCONNECT,new ArrayList<>(updates.values()),List.of());
    }

    public synchronized Commit expireLeasesTrusted(long nowTick) throws Rejection {
        tick(nowTick); List<Entity> updates=new ArrayList<>();
        for (Entity entity:entities.values()) {
            if (entity.ownerId!=null && entity.leaseUntilTick<=nowTick) updates.add(owned(entity,null,0));
        }
        for (Entity update:updates) { entities.put(update.entityId,update); motion.put(update.entityId,new MotionBudget(nowTick,2)); }
        return commit(Change.OWNER,updates,List.of());
    }

    public synchronized Commit deleteTrusted(String id,long expectedRevision,long nowTick) throws Rejection {
        tick(nowTick); Entity old=require(id); revision(old,expectedRevision); Map<String,Entity> updates=new LinkedHashMap<>();
        if (old.components.attachment!=null) detach(old,updates,nowTick);
        if (old.kind==Kind.VEHICLE) {
            for (String pedId:old.components.vehicle.seats.values()) {
                if (pedId==null) continue;
                Entity ped=require(pedId); Components c=ped.components;
                updates.put(pedId,updated(ped,new Components(c.transform,c.ped,c.vehicle,c.object,c.combat,null)));
            }
        }
        updates.remove(id); updates.forEach(entities::put);
        entities.remove(id); motion.remove(id);
        generationStarts.remove(id);
        if (old.playerId!=null) playerEntities.remove(old.playerId);
        Tombstone deleted=new Tombstone(id,old.kind,old.revision+1,old.generation,worldRevision+1);
        tombstones.put(id,deleted);
        while (tombstones.size()>limits.tombstoneEntries) tombstones.remove(tombstones.keySet().iterator().next());
        return commit(Change.DELETE,new ArrayList<>(updates.values()),List.of(deleted));
    }

    /** 现有玩家消息的只读投影，不包含本机句柄，也不反向接受客户端战斗字段。 */
    public synchronized Map<String,Object> playerStateProjection(String playerId) {
        Entity entity=playerEntity(playerId); if (entity==null) return null;
        PedView ped=entity.components.ped; Combat combat=entity.components.combat; Transform transform=entity.components.transform;
        Map<String,Object> state=map("position",transform.position.values(),"heading",transform.rotation.heading(),
            "model",entity.model,"weapon",ped.weapon,"shooting",(combat==null || combat.alive()) && ped.shooting,
            "actions",ped.actions.values());
        if (combat!=null) { state.put("health",combat.health); state.put("alive",combat.alive()); }
        if (ped.appearance!=null) state.put("appearance",ped.appearance.values());
        if (ped.aimTarget!=null) state.put("aim_target",ped.aimTarget.values());
        return immutable(state);
    }

    private void detach(Entity ped,Map<String,Entity> updates,long nowTick) throws Rejection {
        Attachment attachment=ped.components.attachment;
        Entity vehicle=updates.getOrDefault(attachment.entityId,require(attachment.entityId));
        Map<String,String> seats=new LinkedHashMap<>(vehicle.components.vehicle.seats); seats.put(attachment.seat,null);
        Vehicle v=vehicle.components.vehicle;
        Entity updatedVehicle=updated(vehicle,new Components(vehicle.components.transform,null,
            new Vehicle(v.engineHealth,v.bodyHealth,seats,v.view),null,vehicle.components.combat,null));
        if ("driver".equals(attachment.seat) && updatedVehicle.ownerId!=null)
            updatedVehicle=ownedAtRevision(updatedVehicle,null,0);
        updates.put(vehicle.entityId,updatedVehicle);
        Components c=ped.components;
        updates.put(ped.entityId,updated(ped,new Components(c.transform,c.ped,null,null,c.combat,null)));
        motion.put(vehicle.entityId,new MotionBudget(nowTick,2));
    }
    private void validate(Kind kind,long model,Components components) throws Rejection {
        validateShape(kind,model,components);
        if (!modelCatalog.get(kind).contains(model)) throw reject("unsupported_model","模型不在该实体类型白名单");
        if (components.ped!=null && !weaponCatalog.contains(components.ped.weapon))
            throw reject("unsupported_weapon","角色武器不在表现白名单");
    }
    private void validateShape(Kind kind,long model,Components components) throws Rejection {
        Objects.requireNonNull(kind); Objects.requireNonNull(components); unsigned(model);
        boolean valid=kind==Kind.PED ? components.ped!=null && components.vehicle==null && components.object==null
            : kind==Kind.VEHICLE ? components.vehicle!=null && components.ped==null && components.object==null && components.attachment==null
            : components.object!=null && components.ped==null && components.vehicle==null && components.attachment==null;
        if (!valid) throw reject("invalid_component","组件与实体类型不符");
    }
    private void lease(String ownerId,long until,long now) throws Rejection {
        if (ownerId==null) { if (until!=0) throw reject("invalid_lease","无所有者时租约必须为零"); return; }
        identifier(ownerId,"所有者身份");
        if (until<=now || until>9_007_199_254_740_991L || until-now>limits.ticksPerSecond*60L)
            throw reject("invalid_lease","租约期限无效");
    }
    private void owner(Entity entity,String actorId,long epoch,long now) throws Rejection {
        if (entity.ownerId==null || !entity.ownerId.equals(actorId) || entity.ownerEpoch!=epoch || entity.leaseUntilTick<=now)
            throw reject("stale_owner","实体租约无效、过期或不属于此玩家");
    }
    private Entity require(String id) throws Rejection {
        Entity entity=entities.get(id); if (entity==null) throw reject("unknown_entity","实体不存在或已删除"); return entity;
    }
    private void revision(Entity entity,long expected) throws Rejection {
        if (entity.revision!=expected) throw reject("stale_revision","实体版本已变化");
    }
    private void baseline(Entity entity,long expected)throws Rejection{
        if(expected<(entity.generation==1?0:generationStarts.getOrDefault(entity.entityId,1L)))throw reject("stale_generation","输入基线属于旧生命周期");
        if(expected>entity.revision)throw reject("invalid_revision","输入基线超出当前版本");
    }
    private void tick(long value) throws Rejection {
        if (value<worldTick || value<0 || value>9_007_199_254_740_991L) throw reject("invalid_tick","服务端时间必须单调递增");
        worldTick=value;
    }
    private Commit commit(Change change,List<Entity> updates,List<Tombstone> deleted) {
        if (updates.isEmpty() && deleted.isEmpty())
            return new Commit(worldEpoch,worldRevision,worldTick,"w:"+worldEpoch+":event:"+worldRevision,change,List.of(),List.of());
        long revision=++worldRevision;
        Commit result=new Commit(worldEpoch,revision,worldTick,"w:"+worldEpoch+":event:"+revision,change,updates,deleted);
        history.add(result); while (history.size()>limits.historyEntries) history.removeFirst(); return result;
    }
    private static Entity updated(Entity old,Components components) {
        return new Entity(old.entityId,old.kind,old.model,old.playerId,old.revision+1,old.generation,
            old.ownerId,old.ownerEpoch,old.leaseUntilTick,old.lastInputSequence,components);
    }
    private static Entity owned(Entity old,String owner,long until) { return ownedAtRevision(updated(old,old.components),owner,until); }
    private static Entity ownedAtRevision(Entity old,String owner,long until) {
        return new Entity(old.entityId,old.kind,old.model,old.playerId,old.revision,old.generation,
            owner,old.ownerEpoch+1,until,-1,old.components);
    }
    private static void finite(double value,double magnitude,String name) {
        if (!Double.isFinite(value) || Math.abs(value)>magnitude) throw new IllegalArgumentException(name+" 无效或超出范围");
    }
    private static void ranged(Double value,double min,double max,boolean integer) {
        if (value==null || !Double.isFinite(value) || value<min || value>max || (integer && Math.rint(value)!=value))
            throw new IllegalArgumentException("组件数值无效");
    }
    private static void unsigned(long value) {
        if (value<0 || value>0xffffffffL) throw new IllegalArgumentException("哈希必须为无符号 32 位整数");
    }
    private static String identifier(String value,String label) {
        if (value==null || value.isBlank() || value.length()>128 || value.chars().anyMatch(c->c<32 || c==127))
            throw new IllegalArgumentException(label+"无效"); return value;
    }
    private static List<List<Integer>> integerRows(List<List<Integer>> rows,int count,int width,boolean props) {
        if (rows==null || rows.size()!=count) throw new IllegalArgumentException("外观组件数量无效");
        List<List<Integer>> copy=new ArrayList<>();
        for (List<Integer> row:rows) {
            if (row==null || row.size()!=width) throw new IllegalArgumentException("外观参数数量无效");
            for (int i=0;i<width;i++) {
                Integer value=row.get(i); int min=props?-1:0; int max=i==0?1024:i==1?255:3;
                if (value==null || value<min || value>max || (props && row.get(0)>=0 && i==1 && value<0))
                    throw new IllegalArgumentException("外观参数无效");
            }
            copy.add(List.copyOf(row));
        }
        return List.copyOf(copy);
    }
    private static Rejection reject(String code,String message) { return new Rejection(code,message); }
    private static Map<String,Object> map(Object... values) {
        Map<String,Object> result=new LinkedHashMap<>();
        for (int i=0;i<values.length;i+=2) result.put((String)values[i],values[i+1]); return result;
    }
    private static <K,V> Map<K,V> immutable(Map<K,V> value) { return Collections.unmodifiableMap(new LinkedHashMap<>(value)); }
}
