package offline.multiplayer;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
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
 * 共享环境人口的生命周期规则。只观察服务器已确认的实体和玩家位置，不持有 Registry，
 * 不执行创建/删除，也不把客户端的血量、距离或“废弃”声明当成事实。
 * 调用方先提交返回的删除，再提交创建，成功后 register 新实体；失败的操作下次可重试。
 */
public final class WorldPopulation {
    public static final long CORPSE_MIN_TICKS = 30_000;
    public static final long CORPSE_MAX_TICKS = 120_000;
    public static final long VEHICLE_MIN_TICKS = 60_000;
    public static final long VEHICLE_MAX_TICKS = 180_000;
    public static final long REFILL_DELAY_TICKS = 15_000;
    public static final double RETIRE_DISTANCE = 40;
    public static final double SPAWN_EXCLUSION_DISTANCE = 20;
    public static final double SPAWN_ACTIVE_DISTANCE = 400;
    public static final int MAX_MUTATIONS_PER_TICK = 4;
    private static final int MAX_SLOTS = 4096;

    public enum Type {
        WALKER(1), TRAFFIC(2);
        private final int entityCost;
        Type(int entityCost) { this.entityCost = entityCost; }
        public int entityCost() { return entityCost; }
    }

    public record Slot(String cell, int index, Type type, Vector anchor) {
        public Slot {
            if (cell == null || !cell.matches("[A-Za-z0-9_:-]{1,64}") || index < 0 || index >= MAX_SLOTS)
                throw new IllegalArgumentException("人口槽位无效");
            Objects.requireNonNull(type); Objects.requireNonNull(anchor);
        }
        public String key() { return cell + "/" + type.name().toLowerCase(java.util.Locale.ROOT) + "/" + index; }
    }

    public record Removal(String slotKey, String entityId, long generation, long revision, String reason) {}
    public record Spawn(Slot slot, int entityCost) {
        public String slotKey() { return slot.key(); }
    }
    public record Plan(List<Removal> removals, List<Spawn> spawns) {
        public Plan { removals = List.copyOf(removals); spawns = List.copyOf(spawns); }
        public int mutationCost() {
            return removals.size() + spawns.stream().mapToInt(Spawn::entityCost).sum();
        }
    }

    private record Identity(String id, long generation) {}
    private static final class Entry {
        Slot slot;
        List<String> ids;
        long emptySince = -1, orphanSince = -1;
        Entry(Slot slot, List<String> ids) { this.slot = slot; this.ids = ids; }
    }
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private final Map<Identity, Long> deadSince = new LinkedHashMap<>();
    private final Map<Identity, Long> abandonedSince = new LinkedHashMap<>();
    private long lastTick;

    /** 同一实体只能占一个人口槽位。空 ids 用于登记尚未创建的槽位。 */
    public synchronized void register(Slot slot, List<String> entityIds) {
        Objects.requireNonNull(slot); Objects.requireNonNull(entityIds);
        List<String> ids = List.copyOf(entityIds);
        if (ids.size() > slot.type.entityCost || new HashSet<>(ids).size() != ids.size()
            || ids.stream().anyMatch(id -> !id.matches("[A-Za-z0-9_:-]{1,160}")))
            throw new IllegalArgumentException("人口实体列表无效");
        Entry old = entries.get(slot.key());
        if (old == null && entries.size() >= MAX_SLOTS) throw new IllegalStateException("人口槽位已满");
        for (Entry other : entries.values()) {
            if (other == old) continue;
            for (String id : ids) if (other.ids.contains(id))
                throw new IllegalArgumentException("实体已登记在其他人口槽位");
        }
        if (old != null && old.ids.equals(ids)) { old.slot = slot; return; }
        entries.put(slot.key(), new Entry(slot, ids));
    }

    /** 只忘记规则状态；该格实体是否删除由调用方另行提交权威事务。 */
    public synchronized void forgetCell(String cell) {
        Objects.requireNonNull(cell);
        entries.entrySet().removeIf(item -> item.getValue().slot.cell.equals(cell));
        pruneObservations();
    }

    public synchronized List<Slot> slots() {
        return entries.values().stream().map(entry -> entry.slot).toList();
    }

    /**
     * claimedVehicleIds 来自服务端确认的玩家接管记录，不是模拟 ownerId：环境车辆同样租给玩家模拟。
     * activePlayers 只能包含服务端确认、仍在公共战局中的玩家位置。
     * 删除上限仍保护玩家座位与玩家已接管车辆；空槽仅在有附近玩家且不贴脸生成时补充。
     */
    public synchronized Plan tick(long now, Collection<Entity> entities, Collection<Vector> activePlayers,
                                  Set<String> claimedVehicleIds, int maxEntities) {
        if (now < lastTick || now < 0) throw new IllegalArgumentException("人口时钟不得倒退");
        if (maxEntities < 1 || maxEntities > 100_000) throw new IllegalArgumentException("实体预算无效");
        lastTick = now;
        Objects.requireNonNull(entities); Objects.requireNonNull(activePlayers); Objects.requireNonNull(claimedVehicleIds);
        List<Vector> players = List.copyOf(activePlayers);
        Map<String, Entity> byId = new LinkedHashMap<>();
        for (Entity entity : entities) {
            Objects.requireNonNull(entity);
            if (byId.put(entity.entityId(), entity) != null) throw new IllegalArgumentException("重复世界实体");
        }
        Set<Identity> dead = new HashSet<>(), abandoned = new HashSet<>();
        List<Removal> candidates = new ArrayList<>();
        List<Entry> refill = new ArrayList<>();
        Set<String> removalIds = new LinkedHashSet<>();
        for (Entry entry : entries.values()) {
            List<Entity> members = entry.ids.stream().map(byId::get).filter(Objects::nonNull).toList();
            if (members.isEmpty()) {
                if (entry.emptySince < 0) entry.emptySince = now;
                entry.orphanSince = -1;
                double nearest = nearest(entry.slot.anchor, players);
                if (elapsed(now, entry.emptySince, REFILL_DELAY_TICKS)
                    && nearest >= SPAWN_EXCLUSION_DISTANCE && nearest <= SPAWN_ACTIVE_DISTANCE) refill.add(entry);
                continue;
            }
            entry.emptySince = -1;
            boolean vehicleExists = members.stream().anyMatch(entity -> entity.kind() == Kind.VEHICLE);
            if (entry.slot.type == Type.TRAFFIC && !vehicleExists) {
                if (entry.orphanSince < 0) entry.orphanSince = now;
            } else entry.orphanSince = -1;
            for (Entity entity : members) {
                if (entity.playerId() != null) continue;
                Identity identity = new Identity(entity.entityId(), entity.generation());
                if (entity.kind() == Kind.PED && entity.components().combat() != null
                    && !entity.components().combat().alive()) {
                    dead.add(identity);
                    long since = deadSince.computeIfAbsent(identity, ignored -> now);
                    if (retire(now, since, CORPSE_MIN_TICKS, CORPSE_MAX_TICKS, entity, players))
                        remove(candidates, removalIds, entry, entity, "dead_npc");
                } else if (entity.kind() == Kind.VEHICLE && entry.slot.type == Type.TRAFFIC) {
                    if (protectedVehicle(entity, byId, claimedVehicleIds) || !abandonedVehicle(entity, byId)) continue;
                    abandoned.add(identity);
                    long since = abandonedSince.computeIfAbsent(identity, ignored -> now);
                    if (retire(now, since, VEHICLE_MIN_TICKS, VEHICLE_MAX_TICKS, entity, players))
                        remove(candidates, removalIds, entry, entity, "abandoned_vehicle");
                } else if (entity.kind() == Kind.PED && entry.orphanSince >= 0
                    && !protectedAttachment(entity, byId, claimedVehicleIds)
                    && retire(now, entry.orphanSince, VEHICLE_MIN_TICKS, VEHICLE_MAX_TICKS, entity, players)) {
                    // 被毁车辆已删除后保留司机一段时间；不能让孤立存活司机永久占满交通槽位。
                    remove(candidates, removalIds, entry, entity, "orphaned_traffic_npc");
                }
            }
        }
        deadSince.keySet().retainAll(dead);
        abandonedSince.keySet().retainAll(abandoned);
        List<Removal> removals = candidates.stream().limit(MAX_MUTATIONS_PER_TICK).toList();
        int availableMutations = MAX_MUTATIONS_PER_TICK - removals.size();
        int availableEntities = Math.max(0, maxEntities - byId.size() + removals.size());
        List<Spawn> spawns = new ArrayList<>();
        for (Entry entry : refill) {
            int cost = entry.slot.type.entityCost;
            if (cost > availableMutations || cost > availableEntities) continue;
            spawns.add(new Spawn(entry.slot, cost));
            availableMutations -= cost; availableEntities -= cost;
        }
        return new Plan(removals, spawns);
    }

    private static void remove(List<Removal> removals, Set<String> ids, Entry entry, Entity entity, String reason) {
        if (ids.add(entity.entityId())) removals.add(new Removal(entry.slot.key(), entity.entityId(),
            entity.generation(), entity.revision(), reason));
    }

    private static boolean protectedVehicle(Entity vehicle, Map<String, Entity> byId, Set<String> claimed) {
        if (claimed.contains(vehicle.entityId())) return true;
        for (String occupant : vehicle.components().vehicle().seats().values()) {
            Entity passenger = byId.get(occupant);
            if (passenger != null && passenger.playerId() != null) return true;
        }
        // 同时检查反向关系，遇到不完整快照也宁可保留玩家正在使用的车辆。
        for (Entity entity : byId.values()) if (entity.playerId() != null && entity.components().attachment() != null
            && vehicle.entityId().equals(entity.components().attachment().entityId())) return true;
        return false;
    }

    private static boolean protectedAttachment(Entity npc, Map<String, Entity> byId, Set<String> claimed) {
        if (npc.components().attachment() == null) return false;
        Entity vehicle = byId.get(npc.components().attachment().entityId());
        return vehicle != null && vehicle.kind() == Kind.VEHICLE && protectedVehicle(vehicle, byId, claimed);
    }

    private static boolean abandonedVehicle(Entity vehicle, Map<String, Entity> byId) {
        WorldRegistry.Vehicle state = vehicle.components().vehicle();
        if (state.engineHealth() <= 0 || state.bodyHealth() <= 0) return true;
        Entity driver = byId.get(state.seats().get("driver"));
        return driver == null || driver.kind() != Kind.PED || driver.components().combat() == null
            || !driver.components().combat().alive() || driver.components().attachment() == null
            || !vehicle.entityId().equals(driver.components().attachment().entityId())
            || !"driver".equals(driver.components().attachment().seat());
    }

    private static boolean retire(long now, long since, long minimum, long maximum,
                                  Entity entity, List<Vector> players) {
        return elapsed(now, since, maximum) || elapsed(now, since, minimum)
            && nearest(entity.components().transform().position(), players) > RETIRE_DISTANCE;
    }

    private static boolean elapsed(long now, long since, long duration) { return now - since >= duration; }
    private static double nearest(Vector position, List<Vector> players) {
        double nearest = Double.POSITIVE_INFINITY;
        for (Vector player : players) nearest = Math.min(nearest, position.distance(player));
        return nearest;
    }

    private void pruneObservations() {
        Set<String> ids = new HashSet<>(); entries.values().forEach(entry -> ids.addAll(entry.ids));
        deadSince.keySet().removeIf(identity -> !ids.contains(identity.id));
        abandonedSince.keySet().removeIf(identity -> !ids.contains(identity.id));
    }
}
