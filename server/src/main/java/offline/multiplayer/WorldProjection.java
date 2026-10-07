package offline.multiplayer;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * 将现有服务端已确认的玩家结果投影到统一实体内核。
 * 不读取原始客户端请求，不构造 native 句柄，不把投影当成已完成 NPC/车辆仿真。
 */
final class WorldProjection {
    private final WorldRegistry world = new WorldRegistry(UUID.randomUUID().toString(), Map.of(), Set.of());
    private final Map<String, Map<String, Object>> states = new HashMap<>();
    private final Map<String, Map<String, Object>> lives = new HashMap<>();
    private final long startedAt = System.nanoTime();

    long tick() { return (System.nanoTime() - startedAt) / 1_000_000; }

    @SuppressWarnings("unchecked")
    void acceptTrusted(Map<String, Object> event) {
        String type = (String) event.get("type");
        try {
            if ("player_state".equals(type)) {
                String id = (String) event.get("player_id");
                states.put(id, (Map<String, Object>) event.get("state"));
                project(id);
            } else if ("combat_state".equals(type)) {
                Set<String> present = new java.util.HashSet<>();
                for (Object item : (List<?>) event.get("players")) {
                    Map<String, Object> life = (Map<String, Object>) item;
                    String id = (String) life.get("id"); present.add(id);
                    lives.put(id, life);
                    if (Boolean.TRUE.equals(life.get("connected"))) project(id);
                    else {
                        world.disconnectOwnerTrusted(id, tick());
                        WorldRegistry.Entity entity = world.playerEntity(id);
                        if (entity != null) world.setCombatTrusted(entity.entityId(), combat(life), entity.revision(), tick());
                    }
                }
                for (String id : new ArrayList<>(lives.keySet())) if (!present.contains(id)) remove(id);
            }
        } catch (WorldRegistry.Rejection | IllegalArgumentException error) {
            // 投影问题应明确记录，不影响已经确认的玩家协议和连接。
            System.err.println("统一世界投影未完成：" + error.getMessage());
        }
    }

    private void project(String id) throws WorldRegistry.Rejection {
        Map<String, Object> state = states.get(id), life = lives.get(id);
        if (state == null || life == null || !Boolean.TRUE.equals(life.get("connected"))) return;
        WorldRegistry.Actions actions = WorldRegistry.Actions.idle();
        if (state.get("actions") instanceof Map<?, ?> value) actions = new WorldRegistry.Actions(
            Boolean.TRUE.equals(value.get("aiming")), Boolean.TRUE.equals(value.get("reloading")),
            Boolean.TRUE.equals(value.get("jumping")), Boolean.TRUE.equals(value.get("ducking")),
            Boolean.TRUE.equals(value.get("sprinting")));
        WorldRegistry.PedView view = new WorldRegistry.PedView(appearance(state.get("appearance")), actions,
            number(state.get("weapon")).longValue(), Boolean.TRUE.equals(state.get("shooting")),
            state.get("aim_target") == null ? null : vector(state.get("aim_target")));
        WorldRegistry.Transform transform = WorldRegistry.Transform.at(vector(state.get("position")),
            number(state.get("heading")).doubleValue());
        world.projectPlayerTrusted(id, number(state.get("model")).longValue(), transform, view, combat(life), tick());
    }

    void remove(String id) throws WorldRegistry.Rejection {
        world.disconnectOwnerTrusted(id, tick());
        WorldRegistry.Entity entity = world.playerEntity(id);
        if (entity != null) world.deleteTrusted(entity.entityId(), entity.revision(), tick());
        states.remove(id); lives.remove(id);
    }

    void expireLeases() {
        try { world.expireLeasesTrusted(tick()); }
        catch (WorldRegistry.Rejection error) { System.err.println("统一世界租约检查失败：" + error.getMessage()); }
    }

    Map<String, Object> snapshot() {
        WorldRegistry.Snapshot snapshot = world.snapshot();
        List<Object> entities = new ArrayList<>(), deleted = new ArrayList<>();
        for (WorldRegistry.Entity entity : snapshot.entities()) {
            Map<String, Object> value = entity(entity);
            Map<String, Object> life = lives.get(entity.playerId());
            if (life != null) value.put("combat_revision", life.get("revision"));
            entities.add(value);
        }
        for (WorldRegistry.Tombstone item : snapshot.tombstones()) deleted.add(map("entity_id", item.entityId(),
            "revision", item.revision(), "generation", item.generation(), "world_revision", item.worldRevision()));
        return map("schema_version", 2, "world_epoch", snapshot.worldEpoch(), "cut_revision", snapshot.cutRevision(),
            "world_tick", snapshot.worldTick(), "entities", entities, "tombstones", deleted,
            "source", "server_verified_player_projection", "shared_population", false,
            "native_clone_transport", false);
    }

    private static Map<String, Object> entity(WorldRegistry.Entity entity) {
        WorldRegistry.Components values = entity.components();
        Map<String, Object> components = map("transform", map("position", values.transform().position().values(),
            "rotation", values.transform().rotation().values(), "velocity", values.transform().velocity().values(),
            "angular_velocity", values.transform().angularVelocity().values()));
        if (values.ped() != null) {
            WorldRegistry.PedView ped = values.ped();
            Map<String, Object> view = map("weapon", ped.weapon(), "shooting", ped.shooting(), "actions", ped.actions().values());
            if (ped.aimTarget() != null) view.put("aim_target", ped.aimTarget().values());
            components.put("ped", view);
            if (ped.appearance() != null) components.put("appearance", ped.appearance().values());
        }
        if (values.combat() != null) components.put("combat", map("health", values.combat().health(),
            "alive", values.combat().alive(), "max_health", values.combat().maxHealth(),
            "kills", values.combat().kills(), "deaths", values.combat().deaths(), "respawn_at_tick", values.combat().respawnAtTick()));
        return map("entity_id", entity.entityId(), "kind", entity.kind().name().toLowerCase(java.util.Locale.ROOT),
            "player_id", entity.playerId(), "model", entity.model(), "revision", entity.revision(),
            "generation", entity.generation(), "owner_id", entity.ownerId(), "owner_epoch", entity.ownerEpoch(),
            "lease_until_tick", entity.leaseUntilTick(), "components", components);
    }

    private WorldRegistry.Combat combat(Map<String, Object> life) {
        int health = number(life.get("health")).intValue();
        long respawn = health > 0 ? 0 : tick() + Math.max(0,
            number(life.getOrDefault("respawn_at", 0)).longValue() - System.currentTimeMillis());
        return new WorldRegistry.Combat(health, 200, number(life.getOrDefault("kills", 0)).intValue(),
            number(life.getOrDefault("deaths", 0)).intValue(), respawn);
    }

    private static WorldRegistry.Vector vector(Object input) {
        List<?> values = (List<?>) input;
        return new WorldRegistry.Vector(number(values.get(0)).doubleValue(), number(values.get(1)).doubleValue(), number(values.get(2)).doubleValue());
    }
    private static WorldRegistry.Appearance appearance(Object input) {
        if (!(input instanceof Map<?, ?> value)) return null;
        List<List<Double>> overlays = null;
        List<Integer> hair = null;
        if (value.get("overlays") instanceof List<?> rows) {
            overlays = new ArrayList<>();
            for (Object row : rows) overlays.add(((List<?>) row).stream().map(item -> number(item).doubleValue()).toList());
        }
        if (value.get("hair") instanceof List<?> values) hair = values.stream().map(item -> number(item).intValue()).toList();
        return new WorldRegistry.Appearance(rows(value.get("components")), rows(value.get("props")), overlays, hair);
    }
    private static List<List<Integer>> rows(Object value) {
        List<List<Integer>> result = new ArrayList<>();
        for (Object row : (List<?>) value) result.add(((List<?>) row).stream().map(item -> number(item).intValue()).toList());
        return result;
    }
    private static Number number(Object value) { return (Number) value; }
    private static Map<String, Object> map(Object... values) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int index = 0; index < values.length; index += 2) map.put((String) values[index], values[index + 1]);
        return map;
    }
}
