package offline.multiplayer;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 不依赖网络或游戏资源的公共战局权威状态。
 * 原型使用玩家胶囊检测射击；尚未读取地形、墙体或载具碰撞，因此不能判断障碍物遮挡。
 * 调用方负责连接鉴权、消息限流和事件分发，不接受客户端声明的命中、击杀或目标生命值。
 */
public final class CombatWorld {
    public static final int INITIAL_HEALTH = 200;
    public static final long RESPAWN_DELAY_MILLIS = 4_000;
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    private static final long MAX_UNSIGNED_INT = 4_294_967_295L;
    private static final double MAX_SPEED = 14.0;
    private static final double MAX_RAY_LENGTH = 300.0;
    private static final List<String> ACTION_FIELDS = List.of("aiming", "reloading", "jumping", "ducking", "sprinting");
    private final LinkedHashMap<String, Player> players = new LinkedHashMap<>();
    private long joins;

    public record Outcome(boolean accepted, List<Map<String, Object>> events) {}

    public static final class Rejection extends Exception {
        public final String code;
        Rejection(String code, String message) { super(message); this.code = code; }
    }

    private static final class Player {
        final String id;
        final List<Double> spawn;
        boolean connected = true;
        int health = INITIAL_HEALTH;
        int kills;
        int deaths;
        long revision = 1;
        long respawnAt;
        long stateSequence = -1;
        long shotSequence = -1;
        long stateAt;
        double movementCredit = 2;
        long shotAt = Long.MIN_VALUE;
        Map<String, Object> state;
        Player(String id, List<Double> spawn) { this.id = id; this.spawn = spawn; }
    }

    /** 同一玩家恢复连接时保留原来的出生点、序号和战斗状态。 */
    public synchronized Map<String, Object> join(String id) {
        Player player = players.get(id);
        if (player == null) {
            long index = joins++;
            player = new Player(id, List.of(711.5 + (index % 8) * 2,
                -1088.1 + ((index / 8) % 16) * 2, 22.4));
            players.put(id, player);
        }
        player.connected = true;
        return profile(player);
    }

    public synchronized void setConnected(String id, boolean connected) {
        Player player = players.get(id);
        if (player != null) player.connected = connected;
    }

    public synchronized void remove(String id) { players.remove(id); }

    public synchronized Map<String, Object> profile(String id) {
        Player player = players.get(id);
        if (player == null) return null;
        return profile(player);
    }

    private Map<String, Object> profile(Player player) {
        return object("last_state_seq", player.stateSequence, "last_shot_seq", player.shotSequence,
            "spawn", player.spawn, "health", player.health, "alive", player.health > 0,
            "kills", player.kills, "deaths", player.deaths, "revision", player.revision);
    }

    public synchronized int statePlayers() {
        return (int) players.values().stream().filter(player -> player.state != null && player.connected).count();
    }

    public synchronized Map<String, Object> combatState() {
        List<Object> values = new ArrayList<>();
        for (Player player : players.values()) values.add(object("id", player.id,
            "connected", player.connected, "health", player.health, "alive", player.health > 0,
            "kills", player.kills, "deaths", player.deaths, "respawn_at", player.respawnAt,
            "spawn", player.spawn, "revision", player.revision));
        return object("type", "combat_state", "room_id", "PUBLIC", "players", values);
    }

    public synchronized Map<String, Object> worldState() {
        List<Object> values = new ArrayList<>();
        for (Player player : players.values()) {
            if (player.connected && player.state != null)
                values.add(object("player_id", player.id, "state", new LinkedHashMap<>(player.state)));
        }
        return object("type", "world_state", "room_id", "PUBLIC", "states", values);
    }

    /** 接收已限制外观长度的状态；生命值始终由服务端覆盖。 */
    public synchronized Outcome updateState(String id, Map<String, Object> input, long now) throws Rejection {
        Player player = require(id);
        long sequence = integer(input.get("seq"), 0, MAX_SAFE_INTEGER, "状态序号");
        if (sequence <= player.stateSequence) throw reject("stale_seq", "角色状态序号必须严格递增");
        List<Double> position = coordinates(input.get("position"), "角色坐标");
        double heading = number(input.get("heading"), 0, 360, "角色朝向");
        long model = integer(input.get("model"), 0, MAX_UNSIGNED_INT, "角色模型");
        integer(input.get("health"), 0, 1000, "本地角色生命值");
        long weapon = integer(input.get("weapon"), 0, MAX_UNSIGNED_INT, "角色武器");
        if (!(input.get("shooting") instanceof Boolean)) throw reject("invalid_message", "射击状态必须为布尔值");
        Map<String, Object> actions = input.containsKey("actions") ? actions(input.get("actions")) : null;
        List<Double> aimTarget = input.containsKey("aim_target") ? coordinates(input.get("aim_target"), "瞄准坐标") : null;
        List<Double> previous = player.state == null ? player.spawn : position(player);
        double elapsed = Math.max(0, Math.min(2, (now - player.stateAt) / 1_000.0));
        double travelled = distance(previous, position);
        // 宽容量是累计预算，不能让每个网络包反复获得额外两米而绕过速度上限。
        double credit = Math.min(30, player.movementCredit + MAX_SPEED * elapsed);
        double allowance = player.state == null ? 40 : credit;
        if (player.health > 0 && travelled > allowance) {
            // 消费无效坐标的序号，防止旧数据在纠正之后再次改变状态。
            player.stateSequence = sequence;
            return new Outcome(false, List.of(object("type", "correction", "player_id", player.id,
                "position", previous, "heading", player.state == null ? 90 : player.state.get("heading"),
                "revision", player.revision, "state_seq", sequence, "reason", "invalid_movement")));
        }
        if (player.health == 0) position = previous;
        player.movementCredit = player.state == null ? 2 : Math.max(0, credit - (player.health > 0 ? travelled : 0));
        Map<String, Object> state = object("seq", sequence, "position", position, "heading", heading,
            "model", model, "health", player.health, "alive", player.health > 0,
            "weapon", weapon, "shooting", player.health > 0 && (Boolean) input.get("shooting"));
        if (input.containsKey("appearance")) state.put("appearance", copy(input.get("appearance")));
        if (actions != null) state.put("actions", actions);
        if (aimTarget != null) state.put("aim_target", aimTarget);
        player.stateSequence = sequence;
        player.stateAt = now;
        player.state = state;
        return new Outcome(true, List.of(stateEvent(player, now)));
    }

    public synchronized List<Map<String, Object>> shoot(String id, Map<String, Object> input, long now) throws Rejection {
        Player shooter = require(id);
        long sequence = integer(input.get("seq"), 0, MAX_SAFE_INTEGER, "射击序号");
        if (sequence <= shooter.shotSequence) throw reject("stale_seq", "射击事件序号必须严格递增");
        List<Double> origin = coordinates(input.get("origin"), "射击起点");
        List<Double> target = coordinates(input.get("target"), "射击目标点");
        long weapon = integer(input.get("weapon"), 0, MAX_UNSIGNED_INT, "射击武器");
        if (!shooter.connected || shooter.health <= 0 || shooter.state == null || now - shooter.stateAt > 2_000)
            throw reject("invalid_shot", "射击需要存活角色及最近两秒内的有效位置");
        if (weapon != ((Number) shooter.state.get("weapon")).longValue())
            throw reject("invalid_shot", "射击武器与角色当前武器不一致");
        if (distance(position(shooter), origin) > 6)
            throw reject("invalid_shot", "射击起点距离角色过远");
        double range = distance(origin, target);
        if (range <= 0.001 || range > MAX_RAY_LENGTH)
            throw reject("invalid_shot", "射击射线必须在 0–300 米范围内");
        Weapon rule = weapon(weapon);
        if (rule == null) throw reject("unsupported_weapon", String.format(
            "暂不支持武器 0x%08x 的战局伤害，请使用普通枪械", weapon));
        if (shooter.shotAt != Long.MIN_VALUE && now - shooter.shotAt < rule.cooldown)
            throw reject("rate_limited", "该武器射击间隔过短");
        shooter.shotSequence = sequence;
        shooter.shotAt = now;
        List<Map<String, Object>> events = new ArrayList<>();
        events.add(object("type", "shot_event", "room_id", "PUBLIC", "player_id", id,
            "event", object("seq", sequence, "origin", origin, "target", target, "weapon", weapon),
            "time", Instant.ofEpochMilli(now).toString()));
        double[] direction = new double[3];
        for (int index = 0; index < 3; index++) direction[index] = (target.get(index) - origin.get(index)) / range;
        Player victim = null;
        double nearest = range + 1;
        for (Player candidate : players.values()) {
            if (candidate == shooter || !candidate.connected || candidate.health <= 0 || candidate.state == null) continue;
            double hit = capsule(origin, direction, range, position(candidate));
            if (hit >= 0 && hit < nearest) { victim = candidate; nearest = hit; }
        }
        if (victim == null) return events;
        int damage = Math.min(victim.health, rule.damage);
        victim.health -= damage;
        victim.revision++;
        setHealth(victim);
        events.add(object("type", "damage", "victim_id", victim.id, "attacker_id", shooter.id,
            "health", victim.health, "damage", damage, "shot_seq", sequence, "revision", victim.revision));
        events.add(stateEvent(victim, now));
        if (victim.health == 0) {
            victim.deaths++;
            victim.respawnAt = now + RESPAWN_DELAY_MILLIS;
            shooter.kills++;
            shooter.revision++;
            events.add(object("type", "death", "player_id", victim.id, "killer_id", shooter.id,
                "kills", shooter.kills, "deaths", victim.deaths, "respawn_at", victim.respawnAt,
                "revision", victim.revision));
        }
        events.add(combatState());
        return events;
    }

    /** 到期重生；断线会保留分数，重生不会产生新的角色身份。 */
    public synchronized List<Map<String, Object>> maintain(long now) {
        List<Map<String, Object>> events = new ArrayList<>();
        for (Player player : players.values()) {
            if (player.health > 0 || player.respawnAt == 0 || now < player.respawnAt) continue;
            player.health = INITIAL_HEALTH;
            player.respawnAt = 0;
            player.revision++;
            player.movementCredit = 2;
            if (player.state != null) {
                player.state = new LinkedHashMap<>(player.state);
                player.state.put("position", player.spawn);
                player.state.put("heading", 90.0);
                player.state.put("shooting", false);
                if (player.state.containsKey("actions")) {
                    Map<String, Object> idle = new LinkedHashMap<>();
                    for (String action : ACTION_FIELDS) idle.put(action, false);
                    player.state.put("actions", idle);
                }
                player.state.remove("aim_target");
                setHealth(player);
                // 这是服务端重生，客户端下一帧可在出生点重新提供位置。
                player.stateAt = now;
            }
            events.add(object("type", "respawn", "player_id", player.id, "position", player.spawn,
                "heading", 90, "health", player.health, "revision", player.revision));
            if (player.state != null && player.connected) events.add(stateEvent(player, now));
        }
        if (!events.isEmpty()) events.add(combatState());
        return events;
    }

    private Player require(String id) throws Rejection {
        Player player = players.get(id);
        if (player == null) throw reject("not_in_room", "请先加入公共战局");
        return player;
    }

    private static void setHealth(Player player) {
        if (player.state == null) return;
        player.state = new LinkedHashMap<>(player.state);
        player.state.put("health", player.health);
        player.state.put("alive", player.health > 0);
        if (player.health == 0) player.state.put("shooting", false);
    }

    private static Map<String, Object> stateEvent(Player player, long now) {
        return object("type", "player_state", "room_id", "PUBLIC", "player_id", player.id,
            "state", new LinkedHashMap<>(player.state), "time", Instant.ofEpochMilli(now).toString());
    }

    @SuppressWarnings("unchecked")
    private static List<Double> position(Player player) { return (List<Double>) player.state.get("position"); }

    private record Weapon(int damage, long cooldown) {}
    private static Weapon weapon(long hash) {
        if (hash == 0x1b06d571L || hash == 0x5ef9fec4L || hash == 0x22d8fe39L || hash == 0x99aeeb3bL
                || hash == 0xbfd21232L) return new Weapon(25, 200);
        if (hash == 0x83bf0278L || hash == 0xbfefff6dL || hash == 0xaf113f99L || hash == 0x624fe830L
                || hash == 0x2be6766bL || hash == 0x13532244L || hash == 0xefe7e2dfL || hash == 0x9d07f764L
                || hash == 0x7fd62962L) return new Weapon(35, 100);
        if (hash == 0x1d073a89L || hash == 0x7846a318L || hash == 0x9d61e50fL || hash == 0xe284c527L)
            return new Weapon(50, 800);
        if (hash == 0x05fc3c11L || hash == 0x0c472fe2L || hash == 0xc734385aL) return new Weapon(100, 1_000);
        // 本项目 MINIGUN 是普通即时命中武器，原枪射击间隔为 20ms。
        // 每条客户端射击消息仍只有一条射线，不按原生更高射速补算多发伤害。
        if (hash == 0x42bf8a85L) return new Weapon(25, 20);
        return null;
    }

    private static Map<String, Object> actions(Object input) throws Rejection {
        if (!(input instanceof Map<?, ?> values) || values.size() != ACTION_FIELDS.size()
                || !values.keySet().containsAll(ACTION_FIELDS))
            throw reject("invalid_message", "行为状态必须包含完整且固定的五个布尔字段");
        Map<String, Object> result = new LinkedHashMap<>();
        for (String action : ACTION_FIELDS) {
            if (!(values.get(action) instanceof Boolean value))
                throw reject("invalid_message", "行为状态 " + action + " 必须为布尔值");
            result.put(action, value);
        }
        return result;
    }

    /** 有限射线与竖直胶囊相交，返回最近距离；不推测游戏地图的墙体遮挡。 */
    private static double capsule(List<Double> origin, double[] d, double range, List<Double> feet) {
        double radius = .45;
        double low = feet.get(2) + .25;
        double high = feet.get(2) + 1.65;
        double ox = origin.get(0) - feet.get(0);
        double oy = origin.get(1) - feet.get(1);
        double a = d[0] * d[0] + d[1] * d[1];
        double b = 2 * (ox * d[0] + oy * d[1]);
        double c = ox * ox + oy * oy - radius * radius;
        double nearest = Double.POSITIVE_INFINITY;
        if (a > 1e-12) {
            double discriminant = b * b - 4 * a * c;
            if (discriminant >= 0) {
                double root = Math.sqrt(discriminant);
                for (double t : new double[] {(-b - root) / (2 * a), (-b + root) / (2 * a)}) {
                    double z = origin.get(2) + t * d[2];
                    if (t >= 0 && t <= range && z >= low && z <= high) nearest = Math.min(nearest, t);
                }
            }
        }
        for (double center : new double[] {low, high}) {
            double oz = origin.get(2) - center;
            double projected = ox * d[0] + oy * d[1] + oz * d[2];
            double discriminant = projected * projected - (ox * ox + oy * oy + oz * oz - radius * radius);
            if (discriminant >= 0) {
                double root = Math.sqrt(discriminant);
                for (double t : new double[] {-projected - root, -projected + root})
                    if (t >= 0 && t <= range) nearest = Math.min(nearest, t);
            }
        }
        if (ox * ox + oy * oy <= radius * radius && origin.get(2) >= low && origin.get(2) <= high) nearest = 0;
        return Double.isFinite(nearest) ? nearest : -1;
    }

    private static double distance(List<Double> left, List<Double> right) {
        return Math.hypot(Math.hypot(left.get(0) - right.get(0), left.get(1) - right.get(1)), left.get(2) - right.get(2));
    }

    private static List<Double> coordinates(Object input, String name) throws Rejection {
        if (!(input instanceof List<?> values) || values.size() != 3)
            throw reject("invalid_message", name + "必须包含三个坐标");
        List<Double> result = new ArrayList<>(3);
        for (Object value : values) result.add(number(value, -16_000, 16_000, name));
        return List.copyOf(result);
    }

    private static long integer(Object input, long min, long max, String name) throws Rejection {
        if (input instanceof Number value) {
            try {
                BigDecimal decimal = value instanceof BigDecimal big ? big : new BigDecimal(value.toString());
                long result = decimal.longValueExact();
                if (result >= min && result <= max) return result;
            } catch (ArithmeticException | NumberFormatException ignored) {}
        }
        throw reject("invalid_message", name + "必须是有效整数");
    }

    private static double number(Object input, double min, double max, String name) throws Rejection {
        if (input instanceof Number value) {
            double result = value.doubleValue();
            if (Double.isFinite(result) && result >= min && result <= max) return result;
        }
        throw reject("invalid_message", name + "必须是有效有限数值");
    }

    private static Object copy(Object input) {
        if (input instanceof Map<?, ?> map) {
            Map<String, Object> result = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) result.put((String) entry.getKey(), copy(entry.getValue()));
            return result;
        }
        if (input instanceof List<?> list) {
            List<Object> result = new ArrayList<>(list.size());
            for (Object value : list) result.add(copy(value));
            return result;
        }
        return input;
    }

    private static Rejection reject(String code, String message) { return new Rejection(code, message); }

    private static Map<String, Object> object(Object... pairs) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (int index = 0; index < pairs.length; index += 2) result.put((String) pairs[index], pairs[index + 1]);
        return result;
    }
}
