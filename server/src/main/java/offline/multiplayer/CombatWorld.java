package offline.multiplayer;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
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
    private static final Map<Long, Weapon> WEAPONS = weaponCatalog();
    private final LinkedHashMap<String, Player> players = new LinkedHashMap<>();
    private long joins;
    private final WorldRegistry world;

    public CombatWorld(WorldRegistry world) { this.world = world; }

    public record Outcome(boolean accepted, List<Map<String, Object>> events) {}

    public static final class Rejection extends Exception {
        public final String code;
        public final long retryAfterMillis;
        Rejection(String code, String message) { this(code, message, 0); }
        Rejection(String code, String message, long retryAfterMillis) {
            super(message); this.code = code; this.retryAfterMillis = retryAfterMillis;
        }
    }

    private static final class Player {
        final String id;
        final List<Double> spawn;
        boolean connected = true;
        long stateSequence = -1;
        long shotSequence = -1;
        long stateAt;
        double movementCredit = 2;
        long shotAt = Long.MIN_VALUE;
        boolean hasState, hasActions, hasAppearance;
        Player(String id, List<Double> spawn) { this.id = id; this.spawn = spawn; }
    }

    /** 同一玩家恢复连接时保留原来的出生点、序号和战斗状态。 */
    public synchronized Map<String, Object> join(String id, long now) {
        Player player = players.get(id);
        if (player == null) {
            long index = joins++;
            player = new Player(id, List.of(711.5 + (index % 8) * 2,
                -1088.1 + ((index / 8) % 16) * 2, 22.4));
            players.put(id, player);
            try { world.projectPlayerTrusted(id,0x705e61f2L,WorldRegistry.Transform.at(vector(player.spawn),90),
                new WorldRegistry.PedView(null,WorldRegistry.Actions.idle(),0,false,null),
                new WorldRegistry.Combat(INITIAL_HEALTH,INITIAL_HEALTH,0,0,0),now); }
            catch (WorldRegistry.Rejection rejection) { throw new IllegalStateException(rejection); }
        }
        player.connected = true;
        return profile(player);
    }

    public synchronized void setConnected(String id, boolean connected) {
        Player player = players.get(id);
        if (player != null) player.connected = connected;
    }

    public synchronized void remove(String id) {
        players.remove(id);
    }

    public synchronized Map<String, Object> profile(String id) {
        Player player = players.get(id);
        if (player == null) return null;
        return profile(player);
    }

    private Map<String, Object> profile(Player player) {
        WorldRegistry.Entity entity=world.playerEntity(player.id);WorldRegistry.Combat life=entity.components().combat();
        return object("last_state_seq", player.stateSequence, "last_shot_seq", player.shotSequence,
            "spawn", player.spawn, "health", life.health(), "alive", life.alive(),
            "kills",life.kills(),"deaths",life.deaths(),"revision",entity.revision());
    }

    public synchronized int statePlayers() {
        return (int) players.values().stream().filter(player -> player.hasState && player.connected).count();
    }

    public synchronized Map<String, Object> combatState() {
        List<Object> values=new ArrayList<>();
        for (Player player:players.values()) {
            WorldRegistry.Entity entity=world.playerEntity(player.id);WorldRegistry.Combat life=entity.components().combat();
            values.add(object("id",player.id,"connected",player.connected,"health",life.health(),"alive",life.alive(),
                "kills",life.kills(),"deaths",life.deaths(),"respawn_at",life.respawnAtTick(),"spawn",player.spawn,"revision",entity.revision()));
        }
        return object("type","combat_state","room_id","PUBLIC","players",values);
    }

    public synchronized Map<String,Object> worldState() {
        List<Object> values=new ArrayList<>();
        for(Player player:players.values())if(player.connected && player.hasState)
            values.add(object("player_id",player.id,"state",state(player)));
        return object("type","world_state","room_id","PUBLIC","states",values);
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
        List<Double> previous = player.hasState ? position(player) : player.spawn;
        WorldRegistry.Entity entity=world.playerEntity(id);WorldRegistry.Combat life=entity.components().combat();
        // 已附座玩家的位置来自车辆确认事务；不应用步行速度预算去否定车辆运动。
        if(entity.components().attachment()!=null)position=previous;
        double elapsed = Math.max(0, Math.min(2, (now - player.stateAt) / 1_000.0));
        double travelled = distance(previous, position);
        // 宽容量是累计预算，不能让每个网络包反复获得额外两米而绕过速度上限。
        double credit = Math.min(30, player.movementCredit + MAX_SPEED * elapsed);
        double allowance = !player.hasState ? 40 : credit;
        if (life.alive() && travelled > allowance) {
            // 消费无效坐标的序号，防止旧数据在纠正之后再次改变状态。
            player.stateSequence = sequence;
            return new Outcome(false, List.of(object("type", "correction", "player_id", player.id,
                "position", previous, "heading",!player.hasState ? 90 : entity.components().transform().rotation().heading(),
                "revision", entity.revision(), "state_seq", sequence, "reason", "invalid_movement")));
        }
        if (!life.alive()) position = previous;
        player.movementCredit = !player.hasState ? 2 : Math.max(0, credit - (life.alive() ? travelled : 0));
        WorldRegistry.Actions behavior=actions==null?WorldRegistry.Actions.idle():new WorldRegistry.Actions(
            (Boolean)actions.get("aiming"),(Boolean)actions.get("reloading"),(Boolean)actions.get("jumping"),
            (Boolean)actions.get("ducking"),(Boolean)actions.get("sprinting"));
        WorldRegistry.PedView view=new WorldRegistry.PedView(appearance(input.get("appearance")),behavior,weapon,
            life.alive() && (Boolean)input.get("shooting"),aimTarget==null?null:vector(aimTarget));
        try { world.projectPlayerTrusted(id,model,WorldRegistry.Transform.at(vector(position),heading),view,life,now); }
        catch(WorldRegistry.Rejection rejection){throw reject(rejection.code,rejection.getMessage());}
        player.stateSequence=sequence;player.stateAt=now;player.hasState=true;
        player.hasActions=actions!=null;player.hasAppearance=input.containsKey("appearance");
        return new Outcome(true,List.of(stateEvent(player,now)));
    }

    public synchronized List<Map<String, Object>> shoot(String id, Map<String, Object> input, long now) throws Rejection {
        Player shooter = require(id);
        WorldRegistry.Entity shootingEntity=world.playerEntity(id);WorldRegistry.Combat shootingLife=shootingEntity.components().combat();
        long sequence = integer(input.get("seq"), 0, MAX_SAFE_INTEGER, "射击序号");
        if (sequence <= shooter.shotSequence) throw reject("stale_seq", "射击事件序号必须严格递增");
        List<Double> origin = coordinates(input.get("origin"), "射击起点");
        List<Double> target = coordinates(input.get("target"), "射击目标点");
        long weapon = integer(input.get("weapon"), 0, MAX_UNSIGNED_INT, "射击武器");
        if (!shooter.connected || !shootingLife.alive() || !shooter.hasState || now - shooter.stateAt > 2_000)
            throw reject("invalid_shot", "射击需要存活角色及最近两秒内的有效位置");
        if (weapon != shootingEntity.components().ped().weapon())
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
            throw new Rejection("rate_limited", "该武器射击间隔过短", rule.cooldown - (now - shooter.shotAt));
        shooter.shotSequence = sequence;
        shooter.shotAt = now;
        List<Map<String, Object>> events = new ArrayList<>();
        events.add(object("type", "shot_event", "room_id", "PUBLIC", "player_id", id,
            "event", object("seq", sequence, "origin", origin, "target", target, "weapon", weapon),
            "time", Instant.ofEpochMilli(now).toString()));
        double[] direction = new double[3];
        for (int index = 0; index < 3; index++) direction[index] = (target.get(index) - origin.get(index)) / range;
        WorldRegistry.Entity victimEntity=null;double nearest=range+1;
        for(WorldRegistry.Entity candidate:world.snapshot().entities()){
            if(candidate.kind()!=WorldRegistry.Kind.PED || candidate.entityId().equals(shootingEntity.entityId())
                || candidate.components().combat()==null || !candidate.components().combat().alive())continue;
            if(candidate.playerId()!=null){Player participant=players.get(candidate.playerId());
                if(participant==null || !participant.connected || !participant.hasState)continue;
            }else if(candidate.ownerId()==null)continue;
            double hit=capsule(origin,direction,range,candidate.components().transform().position().values());
            if(hit>=0 && hit<nearest){victimEntity=candidate;nearest=hit;}
        }
        if(victimEntity==null)return events;
        WorldRegistry.Combat victimLife=victimEntity.components().combat();
        int damage=Math.min(victimLife.health(),rule.damage),health=victimLife.health()-damage;
        boolean killed=health==0;boolean playerVictim=victimEntity.playerId()!=null;
        Map<String,WorldRegistry.Combat> changes=new LinkedHashMap<>();
        changes.put(victimEntity.entityId(),new WorldRegistry.Combat(health,INITIAL_HEALTH,victimLife.kills(),
            victimLife.deaths()+(killed?1:0),killed&&playerVictim?now+RESPAWN_DELAY_MILLIS:0));
        if(killed)changes.put(shootingEntity.entityId(),new WorldRegistry.Combat(shootingLife.health(),INITIAL_HEALTH,
            shootingLife.kills()+1,shootingLife.deaths(),shootingLife.respawnAtTick()));
        try{world.setCombatBatchTrusted(changes,now);}catch(WorldRegistry.Rejection rejection){throw reject(rejection.code,rejection.getMessage());}
        victimEntity=world.entity(victimEntity.entityId());WorldRegistry.Combat updated=victimEntity.components().combat();
        String victimId=playerVictim?victimEntity.playerId():victimEntity.entityId();
        events.add(object("type","damage","victim_id",victimId,"attacker_id",id,"health",health,
            "damage",damage,"shot_seq",sequence,"revision",victimEntity.revision()));
        if(playerVictim)events.add(stateEvent(players.get(victimId),now));
        if(killed)events.add(object("type","death","player_id",victimId,"killer_id",id,
            "kills",shootingLife.kills()+1,"deaths",updated.deaths(),"respawn_at",updated.respawnAtTick(),"revision",victimEntity.revision()));
        events.add(combatState());return events;
    }

    /** 到期重生；断线会保留分数，重生不会产生新的角色身份。 */
    public synchronized List<Map<String,Object>> maintain(long now) {
        List<Map<String,Object>> events=new ArrayList<>();
        for(Player player:players.values()){
            WorldRegistry.Entity entity=world.playerEntity(player.id);WorldRegistry.Combat life=entity.components().combat();
            if(life.alive() || life.respawnAtTick()==0 || now<life.respawnAtTick())continue;
            try{world.respawnTrusted(entity.entityId(),WorldRegistry.Transform.at(vector(player.spawn),90),
                new WorldRegistry.Combat(INITIAL_HEALTH,INITIAL_HEALTH,life.kills(),life.deaths(),0),entity.revision(),now);}
            catch(WorldRegistry.Rejection rejection){throw new IllegalStateException(rejection);}
            entity=world.playerEntity(player.id);player.movementCredit=2;player.stateAt=now;
            events.add(object("type","respawn","player_id",player.id,"position",player.spawn,"heading",90,
                "health",INITIAL_HEALTH,"revision",entity.revision()));
            if(player.hasState && player.connected)events.add(stateEvent(player,now));
        }
        if(!events.isEmpty())events.add(combatState());return events;
    }

    private Player require(String id)throws Rejection{
        Player player=players.get(id);if(player==null)throw reject("not_in_room","请先加入公共战局");return player;
    }
    private Map<String,Object> state(Player player){
        Map<String,Object> state=new LinkedHashMap<>(world.playerStateProjection(player.id));state.put("seq",player.stateSequence);
        if(!player.hasActions)state.remove("actions");if(!player.hasAppearance)state.remove("appearance");return state;
    }
    private Map<String,Object> stateEvent(Player player,long now){
        return object("type","player_state","room_id","PUBLIC","player_id",player.id,"state",state(player),"time",Instant.ofEpochMilli(now).toString());
    }
    private List<Double> position(Player player){return world.playerEntity(player.id).components().transform().position().values();}
    private static WorldRegistry.Vector vector(List<Double> values){return new WorldRegistry.Vector(values.get(0),values.get(1),values.get(2));}
    private static WorldRegistry.Appearance appearance(Object input){
        if(!(input instanceof Map<?,?> value))return null;
        List<List<Integer>> components=intRows(value.get("components")),props=intRows(value.get("props"));
        List<List<Double>> overlays=null;List<Integer> hair=null;
        if(value.get("overlays")instanceof List<?> rows){overlays=new ArrayList<>();for(Object row:rows)
            overlays.add(((List<?>)row).stream().map(item->((Number)item).doubleValue()).toList());}
        if(value.get("hair")instanceof List<?> values)hair=values.stream().map(item->((Number)item).intValue()).toList();
        return new WorldRegistry.Appearance(components,props,overlays,hair);
    }
    private static List<List<Integer>> intRows(Object input){List<List<Integer>> rows=new ArrayList<>();
        for(Object row:(List<?>)input)rows.add(((List<?>)row).stream().map(value->((Number)value).intValue()).toList());return rows;}

    private record Weapon(int damage, long cooldown) {}
    private static Weapon weapon(long hash) { return WEAPONS.get(hash); }

    private static Map<Long, Weapon> weaponCatalog() {
        Map<Long, Weapon> rules = new LinkedHashMap<>();
        addWeapons(rules, new Weapon(25, 200), 0x1b06d571L, 0x5ef9fec4L, 0x22d8fe39L, 0x99aeeb3bL, 0xbfd21232L);
        addWeapons(rules, new Weapon(35, 100), 0x83bf0278L, 0xbfefff6dL, 0xaf113f99L, 0x624fe830L,
            0x2be6766bL, 0x13532244L, 0xefe7e2dfL, 0x9d07f764L, 0x7fd62962L);
        addWeapons(rules, new Weapon(50, 800), 0x1d073a89L, 0x7846a318L, 0x9d61e50fL, 0xe284c527L);
        addWeapons(rules, new Weapon(100, 1_000), 0x05fc3c11L, 0x0c472fe2L, 0xc734385aL);
        // 本项目 MINIGUN 是普通即时命中武器，原枪射击间隔为 20ms。
        // 每条客户端射击消息仍只有一条射线，不按原生更高射速补算多发伤害。
        addWeapons(rules, new Weapon(25, 20), 0x42bf8a85L);
        return Collections.unmodifiableMap(rules);
    }

    private static void addWeapons(Map<Long, Weapon> rules, Weapon rule, long... hashes) {
        for (long hash : hashes) rules.put(hash, rule);
    }

    /** 返回只读公开规则；权威射击判定与 welcome 使用同一内部目录。 */
    public static List<Map<String, Object>> weaponRules() {
        List<Map<String, Object>> result = new ArrayList<>();
        for (Map.Entry<Long, Weapon> entry : WEAPONS.entrySet()) {
            result.add(Collections.unmodifiableMap(object("weapon", entry.getKey(),
                "cooldown_ms", entry.getValue().cooldown, "damage", entry.getValue().damage)));
        }
        return List.copyOf(result);
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
