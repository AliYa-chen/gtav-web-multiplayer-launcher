package offline.multiplayer;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.HashMap;

/**
 * 不依赖网络或游戏资源的公共战局权威状态。
 * 胶囊计算角色命中，静态三角形和授权原生查询验证遮挡；载具精确动态碰撞仍待接入。
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
    private final LinkedHashMap<String, Projectile> projectiles = new LinkedHashMap<>();
    private final List<Hazard> hazards = new ArrayList<>();
    private long projectileSequence;
    private long joins;
    private final WorldRegistry world;
    private final WorldCollision collision;
    private final List<PendingDamage> pendingDamage=new ArrayList<>();
    private record DamageRay(String target,long generation,int amount,WorldCollision.Segment segment) {}
    private record PendingDamage(String query,String attacker,long generation,String actor,long sequence,long weapon,List<DamageRay> rays) {}

    public CombatWorld(WorldRegistry world) { this(world,null); }
    CombatWorld(WorldRegistry world,WorldCollision collision) { this.world = world;this.collision=collision; }

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
        final Deque<QueuedShot> pendingShots=new ArrayDeque<>();
        Player(String id, List<Double> spawn) { this.id = id; this.spawn = spawn; }
    }
    private record QueuedShot(long sequence,long generation,WeaponCatalog.Rule rule,List<Double> sourcePosition,
                              List<Double> origin,List<Double> target,long scheduledAt) {}

    /** 服务器有限飞行弧线：确认的瞄准终点是简化落点，并非地形碰撞结果。 */
    private static final class Projectile {
        final String id, attackerId, attackerEntity;
        final long attackerGeneration, shotSequence, createdAt, flightMillis;
        final WeaponCatalog.Rule rule;
        final List<Double> origin, terminal;
        List<Double> position;
        String hitEntity;
        long hitGeneration;
        long checkedAt;
        boolean landed;
        String query;
        long queryEnd,validatedUntil,impactAt;
        WorldCollision.Hit impact;
        boolean physical;
        long motionAt;
        List<Double> motionOrigin,velocity;
        int bounces;
        long detonateAt;
        boolean remoteRequested;
        Projectile(String id, WorldRegistry.Entity attacker, long sequence, WeaponCatalog.Rule rule,
                   List<Double> origin, List<Double> terminal, long now) {
            this.id=id; attackerId=attacker.playerId(); attackerEntity=attacker.entityId();
            attackerGeneration=attacker.generation(); shotSequence=sequence; this.rule=rule;
            this.origin=origin; this.terminal=terminal; position=origin; createdAt=checkedAt=now;
            flightMillis=Math.max(25,Math.round(distance(origin,terminal)/Math.max(1,rule.speed())*1000));
            motionAt=now;motionOrigin=origin;double[] direction=direction(origin,terminal);
            velocity=List.of(direction[0]*rule.speed(),direction[1]*rule.speed(),direction[2]*rule.speed());
            validatedUntil=now;
        }
        List<Double> at(long tick) {
            if(physical){double seconds=Math.max(0,tick-motionAt)/1000.0;return List.of(
                motionOrigin.get(0)+velocity.get(0)*seconds,motionOrigin.get(1)+velocity.get(1)*seconds,
                motionOrigin.get(2)+velocity.get(2)*seconds-.5*9.81*rule.gravity()*seconds*seconds);}
            double t=Math.max(0,Math.min(1,(tick-createdAt)/(double)flightMillis));
            double arc=rule.gravity()*9.81*Math.pow(flightMillis/1000.0,2)/8;
            return List.of(origin.get(0)+(terminal.get(0)-origin.get(0))*t,
                origin.get(1)+(terminal.get(1)-origin.get(1))*t,
                origin.get(2)+(terminal.get(2)-origin.get(2))*t+4*arc*t*(1-t));
        }
    }
    private static final class Hazard {
        final Projectile source;
        final List<Double> position;
        final long expiresAt;
        long nextAt;
        Hazard(Projectile source,long now) {
            this.source=source; position=source.position;
            expiresAt=now+source.rule.effectDurationMillis(); nextAt=now+source.rule.effectIntervalMillis();
        }
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
        if (player != null) { player.connected = connected; if(!connected)player.pendingShots.clear(); }
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
        List<Map<String,Object>> events=new ArrayList<>();events.add(stateEvent(player,now));
        if(player.pendingShots.stream().anyMatch(shot->shot.rule.hash()!=weapon))cancelShots(player,"weapon_changed",events);
        return new Outcome(true,events);
    }

    public synchronized List<Map<String, Object>> shoot(String id, Map<String, Object> input, long now) throws Rejection {
        Player shooter = require(id);
        WorldRegistry.Entity shootingEntity=world.playerEntity(id);
        long sequence = integer(input.get("seq"), 0, MAX_SAFE_INTEGER, "射击序号");
        if (sequence <= shooter.shotSequence) throw reject("stale_seq", "射击事件序号必须严格递增");
        List<Double> origin = coordinates(input.get("origin"), "射击起点");
        List<Double> target = coordinates(input.get("target"), "射击目标点");
        long weapon = integer(input.get("weapon"), 0, MAX_UNSIGNED_INT, "射击武器");
        if (!shooter.connected || !shootingEntity.components().combat().alive() || !shooter.hasState || now - shooter.stateAt > 2_000)
            throw reject("invalid_shot", "射击需要存活角色及最近两秒内的有效位置");
        if (weapon != shootingEntity.components().ped().weapon())
            throw reject("invalid_shot", "射击武器与角色当前武器不一致");
        if (distance(position(shooter), origin) > 6)
            throw reject("invalid_shot", "射击起点距离角色过远");
        WeaponCatalog.Rule rule=WeaponCatalog.rule(weapon);
        if(rule==null)throw reject("unsupported_weapon",String.format("本地资源目录没有武器 0x%08x",weapon));
        if(!rule.shootable())throw reject("invalid_shot","该目录项不能射击；近战武器应提交近战意图");
        double range=distance(origin,target);
        if(range<=.001 || range>Math.max(MAX_RAY_LENGTH,rule.range()))
            throw reject("invalid_shot","射击射线超出当前武器允许的输入距离");
        if(rule.projectile() && (projectiles.size()+hazards.size()>=128 ||
            projectiles.values().stream().filter(p->p.attackerId.equals(id)).count()+
            hazards.stream().filter(h->h.source.attackerId.equals(id)).count()>=16))
            throw reject("projectile_limit","当前活动投射物和持续效果已达上限");
        shooter.shotSequence=sequence;
        long readyAt=shooter.shotAt==Long.MIN_VALUE?now:shooter.shotAt+rule.cooldownMillis();
        if(!shooter.pendingShots.isEmpty() || now<readyAt) {
            List<Map<String,Object>> events=new ArrayList<>();
            long scheduled=Math.max(now,readyAt);
            if(!shooter.pendingShots.isEmpty())scheduled=shooter.pendingShots.peekLast().scheduledAt+rule.cooldownMillis();
            if(shooter.pendingShots.size()>=8) {
                QueuedShot replaced=shooter.pendingShots.removeLast();scheduled=replaced.scheduledAt;
                events.add(cancelledShot(shooter,replaced,"coalesced"));
            }
            shooter.pendingShots.addLast(new QueuedShot(sequence,shootingEntity.generation(),rule,position(shooter),origin,target,scheduled));
            events.add(object("type","shot_queued","player_id",id,"seq",sequence,"weapon",weapon,
                "pending",true,"scheduled_at",scheduled));
            return events;
        }
        return fire(shooter,shootingEntity,sequence,rule,origin,target,now,now);
    }

    private List<Map<String,Object>> fire(Player shooter,WorldRegistry.Entity shootingEntity,long sequence,
                                         WeaponCatalog.Rule rule,List<Double> origin,List<Double> target,long fireAt,long now)throws Rejection {
        long weapon=rule.hash();String id=shooter.id;shooter.shotAt=fireAt;
        double range=distance(origin,target);
        List<Map<String,Object>> events=new ArrayList<>();
        events.add(object("type","shot_event","room_id","PUBLIC","player_id",id,
            "event",object("seq",sequence,"origin",origin,"target",target,"weapon",weapon,"mode",rule.mode()),
            "time",Instant.ofEpochMilli(now).toString()));
        double effectiveRange=Math.min(range,rule.range());
        double[] direction=direction(origin,target);
        if(rule.projectile()) {
            List<Double> terminal=point(origin,direction,effectiveRange);
            Projectile projectile=new Projectile("p:"+world.worldEpoch()+":"+(++projectileSequence),shootingEntity,
                sequence,rule,origin,terminal,now);
            projectile.physical=collision!=null && (collision.enabled(id)||collision.hasGeometry());
            projectiles.put(projectile.id,projectile); events.add(projectileEvent(projectile,"launch",now));
            return events;
        }
        if("utility".equals(rule.mode())) {
            events.add(object("type","weapon_effect","player_id",id,"weapon",weapon,"shot_seq",sequence,
                "position",point(origin,direction,effectiveRange),"effect",rule.damageType(),"damage",0));
            return events;
        }
        Map<String,Integer> hits=new LinkedHashMap<>();
        List<DamageRay> rays=new ArrayList<>();
        for(int pellet=0;pellet<rule.pellets();pellet++) {
            double[] ray=spreadDirection(direction,rule.spread(),pellet,rule.pellets(),sequence);
            WorldRegistry.Entity victim=nearest(origin,ray,effectiveRange,shootingEntity.entityId());
            if(victim==null)continue;
            int amount=rule.damage()/rule.pellets()+(pellet<rule.damage()%rule.pellets()?1:0);
            hits.merge(victim.entityId(),amount,Integer::sum);
            double hitDistance=capsule(origin,ray,effectiveRange,victim.components().transform().position().values());
            rays.add(new DamageRay(victim.entityId(),victim.generation(),amount,
                new WorldCollision.Segment(vector(origin),vector(point(origin,ray,hitDistance)),0)));
        }
        events.addAll(verifyRays(shootingEntity.entityId(),shootingEntity.generation(),id,id,sequence,weapon,rays,now));
        return events;
    }

    private List<Map<String,Object>> verifyDamage(String attacker,long generation,String actor,long sequence,long weapon,
            Map<String,Integer> hits,List<Double> origin,long now)throws Rejection{
        return verifyDamage(attacker,generation,actor,actor,sequence,weapon,hits,origin,now);
    }
    List<Map<String,Object>> npcShot(WorldRegistry.Entity attacker,WorldRegistry.Entity victim,int amount,long now)throws Rejection{
        var p=attacker.components().transform().position();
        return verifyDamage(attacker.entityId(),attacker.generation(),null,attacker.ownerId(),0,
            attacker.components().ped().weapon(),Map.of(victim.entityId(),amount),List.of(p.x(),p.y(),p.z()+.7),now);
    }
    private List<Map<String,Object>> verifyDamage(String attacker,long generation,String actor,String observer,long sequence,long weapon,
            Map<String,Integer> hits,List<Double> origin,long now)throws Rejection{
        if(collision==null || hits.isEmpty())return applyDamage(attacker,generation,actor,sequence,weapon,hits,now);
        List<DamageRay> rays=new ArrayList<>();
        for(String id:hits.keySet()){
            WorldRegistry.Entity victim=world.entity(id);if(victim==null)continue;
            var p=victim.components().transform().position();
            double z=Math.max(p.z()+.25,Math.min(p.z()+1.65,origin.get(2)));
            rays.add(new DamageRay(id,victim.generation(),hits.get(id),
                new WorldCollision.Segment(vector(origin),new WorldRegistry.Vector(p.x(),p.y(),z),0)));
        }
        return verifyRays(attacker,generation,actor,observer,sequence,weapon,rays,now);
    }
    private List<Map<String,Object>> verifyRays(String attacker,long generation,String actor,String observer,long sequence,long weapon,
            List<DamageRay> rays,long now)throws Rejection{
        if(rays.isEmpty())return List.of();List<Map<String,Object>> events=new ArrayList<>();
        for(int offset=0;offset<rays.size();offset+=16){
            List<DamageRay> batch=List.copyOf(rays.subList(offset,Math.min(rays.size(),offset+16)));
            String query=collision==null?null:collision.submit(observer,"shot",batch.stream().map(DamageRay::segment).toList(),now);
            if(query==null){Map<String,Integer> hits=new LinkedHashMap<>();for(DamageRay ray:batch)hits.merge(ray.target,ray.amount,Integer::sum);
                events.addAll(applyDamage(attacker,generation,actor,sequence,weapon,hits,now));}
            else pendingDamage.add(new PendingDamage(query,attacker,generation,actor,sequence,weapon,batch));
        }
        if(events.isEmpty())events.add(object("type","shot_geometry_pending","player_id",actor,"seq",sequence,"weapon",weapon,"pending",true));
        return events;
    }
    private void resolveDamage(long now,List<Map<String,Object>> events)throws Rejection{
        var iterator=pendingDamage.iterator();while(iterator.hasNext()){
            PendingDamage pending=iterator.next();WorldCollision.Result result=collision.take(pending.query);
            if(result==null)continue;iterator.remove();if(!result.complete())continue;
            Map<String,Integer> clear=new LinkedHashMap<>();
            for(int i=0;i<pending.rays.size();i++){
                DamageRay ray=pending.rays.get(i);WorldRegistry.Entity victim=world.entity(ray.target);
                if(result.hits().get(i)==null && victim!=null && victim.generation()==ray.generation)clear.merge(ray.target,ray.amount,Integer::sum);
            }
            events.addAll(applyDamage(pending.attacker,pending.generation,pending.actor,pending.sequence,pending.weapon,clear,now));
        }
    }

    private Map<String,Object> cancelledShot(Player player,QueuedShot shot,String reason) {
        return object("type","shot_cancelled","player_id",player.id,"seq",shot.sequence,"weapon",shot.rule.hash(),"reason",reason);
    }
    private void cancelShots(Player player,String reason,List<Map<String,Object>> events) {
        while(!player.pendingShots.isEmpty())events.add(cancelledShot(player,player.pendingShots.removeFirst(),reason));
    }
    private void executeQueuedShots(long now,List<Map<String,Object>> events)throws Rejection {
        for(Player player:players.values()) {
            WorldRegistry.Entity entity=world.playerEntity(player.id);
            while(!player.pendingShots.isEmpty()) {
                QueuedShot shot=player.pendingShots.peekFirst();
                if(!player.connected || entity==null || !entity.components().combat().alive() || entity.generation()!=shot.generation ||
                    entity.components().ped().weapon()!=shot.rule.hash() || now-player.stateAt>2000) {
                    cancelShots(player,"shooter_changed",events);break;
                }
                if(now<shot.scheduledAt)break;
                player.pendingShots.removeFirst();
                if(shot.rule.projectile() && (projectiles.size()+hazards.size()>=128 ||
                    projectiles.values().stream().filter(p->p.attackerId.equals(player.id)).count()+
                    hazards.stream().filter(h->h.source.attackerId.equals(player.id)).count()>=16)) {
                    events.add(cancelledShot(player,shot,"projectile_limit"));continue;
                }
                List<Double> current=position(player);
                List<Double> origin=List.of(current.get(0)+shot.origin.get(0)-shot.sourcePosition.get(0),
                    current.get(1)+shot.origin.get(1)-shot.sourcePosition.get(1),current.get(2)+shot.origin.get(2)-shot.sourcePosition.get(2));
                List<Double> target=point(origin,direction(shot.origin,shot.target),distance(shot.origin,shot.target));
                events.addAll(fire(player,entity,shot.sequence,shot.rule,origin,target,shot.scheduledAt,now));
                entity=world.playerEntity(player.id);
            }
        }
    }

    /** 只引爆本玩家已获批创建的黏弹；没有客户端爆点、目标或伤害字段。 */
    public synchronized List<Map<String,Object>> detonate(String id,long now)throws Rejection {
        Player player=require(id);WorldRegistry.Entity entity=world.playerEntity(id);
        if(!player.connected || !entity.components().combat().alive())throw reject("invalid_shot","引爆需要存活的公共战局玩家");
        List<Map<String,Object>> events=new ArrayList<>();
        for(Projectile p:new ArrayList<>(projectiles.values()))if(p.attackerId.equals(id) && "remote".equals(p.rule.detonation())) {
            advance(p,now,events); if(!projectiles.containsKey(p.id))continue;
            if(p.physical && p.validatedUntil<now && !p.landed){p.remoteRequested=true;continue;}
            projectiles.remove(p.id);explode(p,now,events);
        }
        return events;
    }

    /** 晚加入者需要完整活动投射物/持续区域基线，而非重放旧射击。 */
    public synchronized Map<String,Object> projectileState(long now) {
        List<Object> values=new ArrayList<>();
        for(Projectile p:projectiles.values())values.add(projectileEvent(p,p.landed?"landed":"flight",now));
        for(Hazard h:hazards)values.add(object("type","area_effect","projectile_id",h.source.id,
            "position",h.position,"weapon",h.source.rule.hash(),"expires_at",h.expiresAt,
            "radius",h.source.rule.blastRadius(),"damage_type",h.source.rule.damageType()));
        return object("type","projectile_state","room_id","PUBLIC","world_epoch",world.worldEpoch(),"effects",values);
    }

    private Map<String,Object> projectileEvent(Projectile p,String phase,long now) {
        return object("type","projectile_event","room_id","PUBLIC","world_epoch",world.worldEpoch(),
            "projectile_id",p.id,"player_id",p.attackerId,"shot_seq",p.shotSequence,"weapon",p.rule.hash(),
            "phase",phase,"origin",p.origin,"target",p.terminal,"position",p.position,"created_at",p.createdAt,
            "flight_ms",p.flightMillis,"gravity",p.rule.gravity(),"fuse_ms",p.rule.fuseMillis(),
            "detonation",p.rule.detonation(),"expires_at",p.createdAt+p.rule.lifetimeMillis(),"world_tick",now,
            "physics",p.physical?"ballistic":"legacy_arc","velocity",p.velocity,"motion_origin",p.motionOrigin,"motion_at",p.motionAt);
    }

    private void advance(Projectile p,long now,List<Map<String,Object>> events)throws Rejection {
        if(p.physical){advancePhysical(p,now,events);return;}
        long until=Math.min(now,p.createdAt+p.rule.lifetimeMillis());
        if(!p.landed) {
            long end=Math.min(until,p.createdAt+p.flightMillis);
            for(long tick=p.checkedAt;tick<end;) {
                long next=Math.min(end,tick+50);List<Double> dest=p.at(next);
                double length=distance(p.position,dest);
                WorldRegistry.Entity hit=length>.000001?nearest(p.position,direction(p.position,dest),length,p.attackerEntity):null;
                if(hit!=null) {
                    double d=capsule(p.position,direction(p.position,dest),length,hit.components().transform().position().values());
                    p.position=point(p.position,direction(p.position,dest),Math.max(0,d));
                    p.hitEntity=hit.entityId();p.hitGeneration=hit.generation();p.landed=true;break;
                }
                p.position=dest;tick=next;
            }
            p.checkedAt=end;
            if(end>=p.createdAt+p.flightMillis)p.landed=true;
            if(p.landed)events.add(projectileEvent(p,"landed",now));
        }
        if((p.landed && "impact".equals(p.rule.detonation())) ||
            ("timed".equals(p.rule.detonation()) && now>=p.createdAt+p.rule.fuseMillis())) {
            projectiles.remove(p.id);explode(p,now,events);
        } else if(now>=p.createdAt+p.rule.lifetimeMillis()) {
            projectiles.remove(p.id);events.add(projectileEvent(p,"expired",now));
        }
    }

    private void advancePhysical(Projectile p,long now,List<Map<String,Object>> events)throws Rejection{
        long expiry=p.createdAt+p.rule.lifetimeMillis();
        if(now>=expiry && !"timed".equals(p.rule.detonation())){expireProjectile(p,now,events);return;}
        if(p.query!=null){
            WorldCollision.Result result=collision.take(p.query);
            if(result==null)return;p.query=null;
            if(!result.complete()){expireProjectile(p,now,events);return;}
            long start=p.validatedUntil;
            for(int i=0;i<result.hits().size();i++){
                long a=start+(p.queryEnd-start)*i/result.hits().size(),b=start+(p.queryEnd-start)*(i+1)/result.hits().size();
                WorldCollision.Segment segment=new WorldCollision.Segment(vector(p.at(a)),vector(p.at(b)),.02);
                WorldCollision.Hit hit=result.hits().get(i);double length=segment.from().distance(segment.to());
                if(length>.000001){
                    double[] direction=direction(segment.from().values(),segment.to().values());
                    WorldRegistry.Entity ped=nearest(segment.from().values(),direction,length,p.attackerEntity);
                    if(ped!=null){double distance=capsule(segment.from().values(),direction,length,ped.components().transform().position().values());
                        if(hit==null || distance<segment.from().distance(hit.position())){
                            hit=new WorldCollision.Hit(vector(point(segment.from().values(),direction,distance)),new WorldRegistry.Vector(-direction[0],-direction[1],-direction[2]),0);
                            p.hitEntity=ped.entityId();p.hitGeneration=ped.generation();
                        }
                    }
                }
                if(hit!=null){p.impact=hit;p.impactAt=a+Math.round((b-a)*Math.max(0,Math.min(1,WorldCollision.projection(segment,p.impact.position()))));break;}
            }
            p.validatedUntil=p.queryEnd;
        }
        if(!p.landed && p.impact!=null && now>=p.impactAt){
            p.position=p.impact.position().values();WeaponPhysics.Physics physics=WeaponPhysics.byHash(p.rule.hash());
            if(physics!=null && physics.impactDelayMs()>0 && p.detonateAt==0)p.detonateAt=p.impactAt+physics.impactDelayMs();
            double ricochet=physics==null?0:p.hitEntity==null?physics.ricochet():physics.pedRicochet();
            if(physics!=null && ricochet>0 && !physics.destroyOnImpact() && !physics.sticky() && p.bounces<8){
                double elapsed=(p.impactAt-p.motionAt)/1000.0;
                double vx=p.velocity.get(0),vy=p.velocity.get(1),vz=p.velocity.get(2)-9.81*p.rule.gravity()*elapsed;
                var n=p.impact.normal();double dot=vx*n.x()+vy*n.y()+vz*n.z();
                MaterialCatalog.Material material=MaterialCatalog.byCode(p.impact.material());
                double restitution=material==null?.3:Math.max(0,Math.min(1,material.elasticity()));
                double friction=material==null?.6:material.friction();
                double tangent=Math.max(0,1-friction*(physics.friction()<0?1:physics.friction())*.1);
                p.velocity=List.of((vx-dot*n.x())*tangent-dot*n.x()*restitution,
                    (vy-dot*n.y())*tangent-dot*n.y()*restitution,(vz-dot*n.z())*tangent-dot*n.z()*restitution);
                p.motionOrigin=List.of(p.position.get(0)+n.x()*.03,p.position.get(1)+n.y()*.03,p.position.get(2)+n.z()*.03);
                p.motionAt=p.impactAt;p.validatedUntil=p.impactAt;p.impact=null;p.bounces++;
                p.hitEntity=null;p.hitGeneration=0;
                if(distance(List.of(0.,0.,0.),p.velocity)<1)p.landed=true;
                events.add(projectileEvent(p,p.landed?"landed":"flight",now));
            }else {p.landed=true;events.add(projectileEvent(p,"landed",now));}
        }
        if(!p.landed && p.impact!=null && now<p.impactAt)p.position=p.at(now);
        if(!p.landed && p.impact==null){
            if(p.validatedUntil>=expiry && now>=expiry){
                p.position=p.at(expiry);
                if("timed".equals(p.rule.detonation())){projectiles.remove(p.id);explode(p,now,events);}
                else expireProjectile(p,now,events);
                return;
            }
            if(p.validatedUntil<=now){
                long start=p.validatedUntil;
                double speed=Math.max(1,distance(List.of(0.,0.,0.),p.velocity));
                long duration=Math.max(50,Math.min(500,Math.round(100000/speed)));
                p.queryEnd=Math.min(expiry,start+duration);List<WorldCollision.Segment> segments=new ArrayList<>();
                for(int i=0;i<16;i++){
                    List<Double> from=p.at(start+(p.queryEnd-start)*i/16),to=p.at(start+(p.queryEnd-start)*(i+1)/16);
                    if(from.stream().anyMatch(v->!Double.isFinite(v)||Math.abs(v)>15999)||to.stream().anyMatch(v->!Double.isFinite(v)||Math.abs(v)>15999)){
                        expireProjectile(p,now,events);return;}
                    segments.add(new WorldCollision.Segment(vector(from),vector(to),.02));
                }
                p.query=collision.submit(p.attackerId,"projectile",segments,now);
                if(p.query==null){expireProjectile(p,now,events);return;}
                return;
            }
            p.position=p.at(Math.min(now,p.validatedUntil));
        }
        boolean timed="timed".equals(p.rule.detonation()) && now>=p.createdAt+p.rule.fuseMillis();
        boolean impact=p.landed && "impact".equals(p.rule.detonation()) && (p.detonateAt==0||now>=p.detonateAt);
        if(timed || impact || (p.detonateAt>0 && now>=p.detonateAt) || p.remoteRequested){
            projectiles.remove(p.id);explode(p,now,events);
        }
    }
    private void expireProjectile(Projectile p,long now,List<Map<String,Object>> events){
        collision.discard(p.query);projectiles.remove(p.id);events.add(projectileEvent(p,"expired",now));
    }

    private void explode(Projectile p,long now,List<Map<String,Object>> events)throws Rejection {
        events.add(object("type","explosion_event","room_id","PUBLIC","world_epoch",world.worldEpoch(),
            "projectile_id",p.id,"player_id",p.attackerId,"shot_seq",p.shotSequence,"weapon",p.rule.hash(),
            "position",p.position,"radius",p.rule.blastRadius(),"damage_type",p.rule.damageType(),
            "effect_duration_ms",p.rule.effectDurationMillis(),"world_tick",now));
        Map<String,Integer> hits=areaDamage(p.position,p.rule.blastRadius(),p.rule.damage());
        if(p.rule.blastRadius()==0 && p.rule.damage()>0 && p.hitEntity!=null) {
            WorldRegistry.Entity victim=world.entity(p.hitEntity);
            if(victim!=null && victim.generation()==p.hitGeneration)hits.put(p.hitEntity,p.rule.damage());
        }
        List<Double> blastOrigin=p.impact==null?p.position:List.of(p.position.get(0)+p.impact.normal().x()*.05,
            p.position.get(1)+p.impact.normal().y()*.05,p.position.get(2)+p.impact.normal().z()*.05);
        events.addAll(verifyDamage(p.attackerEntity,p.attackerGeneration,p.attackerId,p.shotSequence,p.rule.hash(),hits,blastOrigin,now));
        if(p.rule.effectDurationMillis()>0)hazards.add(new Hazard(p,now));
    }

    private Map<String,Integer> areaDamage(List<Double> origin,double radius,int damage) {
        Map<String,Integer> hits=new LinkedHashMap<>();if(radius<=0 || damage<=0)return hits;
        for(WorldRegistry.Entity candidate:world.snapshot().entities())if(damageable(candidate)) {
            List<Double> feet=candidate.components().transform().position().values();
            double z=Math.max(feet.get(2)+.25,Math.min(feet.get(2)+1.65,origin.get(2)));
            double d=Math.max(0,distance(origin,List.of(feet.get(0),feet.get(1),z))-.45);
            if(d<radius)hits.put(candidate.entityId(),Math.max(1,(int)Math.round(damage*(1-d/radius))));
        }
        return hits;
    }

    private boolean damageable(WorldRegistry.Entity candidate) {
        if(candidate.kind()!=WorldRegistry.Kind.PED || candidate.components().combat()==null || !candidate.components().combat().alive())return false;
        if(candidate.playerId()==null)return candidate.ownerId()!=null;
        Player player=players.get(candidate.playerId());return player!=null && player.connected && player.hasState;
    }
    private WorldRegistry.Entity nearest(List<Double> origin,double[] direction,double range,String exclude) {
        WorldRegistry.Entity victim=null;double closest=range+1;
        for(WorldRegistry.Entity candidate:world.snapshot().entities()) {
            if(candidate.entityId().equals(exclude) || !damageable(candidate))continue;
            double hit=capsule(origin,direction,range,candidate.components().transform().position().values());
            if(hit>=0 && hit<closest){closest=hit;victim=candidate;}
        }
        return victim;
    }
    private List<Map<String,Object>> applyDamage(String attackerEntity,long generation,String attackerId,long shotSequence,
                                                long weapon,Map<String,Integer> hits,long now)throws Rejection {
        if(hits.isEmpty())return List.of();
        Map<String,WorldRegistry.Combat> changes=new LinkedHashMap<>();
        Map<String,Integer> amounts=new LinkedHashMap<>();int kills=0;
        WorldRegistry.Entity attacker=world.entity(attackerEntity);
        for(Map.Entry<String,Integer> entry:hits.entrySet()) {
            WorldRegistry.Entity victim=world.entity(entry.getKey());if(victim==null || !damageable(victim) || entry.getValue()<=0)continue;
            WorldRegistry.Combat life=victim.components().combat();int amount=Math.min(entry.getValue(),life.health()),health=life.health()-amount;
            boolean killed=health==0;
            changes.put(victim.entityId(),new WorldRegistry.Combat(health,life.maxHealth(),life.kills(),life.deaths()+(killed?1:0),
                killed && victim.playerId()!=null?now+RESPAWN_DELAY_MILLIS:0));amounts.put(victim.entityId(),amount);
            if(killed && !victim.entityId().equals(attackerEntity))kills++;
        }
        if(changes.isEmpty())return List.of();
        if(kills>0 && attacker!=null && attacker.generation()==generation) {
            WorldRegistry.Combat life=changes.getOrDefault(attackerEntity,attacker.components().combat());
            changes.put(attackerEntity,new WorldRegistry.Combat(life.health(),life.maxHealth(),life.kills()+kills,life.deaths(),life.respawnAtTick()));
        }
        try{world.setCombatBatchTrusted(changes,now);}catch(WorldRegistry.Rejection rejection){throw reject(rejection.code,rejection.getMessage());}
        List<Map<String,Object>> events=new ArrayList<>();
        for(Map.Entry<String,Integer> entry:amounts.entrySet()) {
            WorldRegistry.Entity victim=world.entity(entry.getKey());WorldRegistry.Combat life=victim.components().combat();
            String victimId=victim.playerId()!=null?victim.playerId():victim.entityId();
            events.add(object("type","damage","victim_id",victimId,"attacker_id",attackerId,"health",life.health(),
                "damage",entry.getValue(),"shot_seq",shotSequence,"weapon",weapon,"revision",victim.revision()));
            if(victim.playerId()!=null)events.add(stateEvent(players.get(victimId),now));
            if(!life.alive())events.add(object("type","death","player_id",victimId,"killer_id",attackerId,
                "kills",attacker!=null && attacker.generation()==generation?world.entity(attackerEntity).components().combat().kills():0,
                "deaths",life.deaths(),"respawn_at",life.respawnAtTick(),"revision",victim.revision()));
        }
        events.add(combatState());return events;
    }

    private static double[] direction(List<Double> origin,List<Double> target) {
        double length=distance(origin,target);return new double[]{(target.get(0)-origin.get(0))/length,
            (target.get(1)-origin.get(1))/length,(target.get(2)-origin.get(2))/length};
    }
    private static List<Double> point(List<Double> origin,double[] direction,double distance) {
        return List.of(origin.get(0)+direction[0]*distance,origin.get(1)+direction[1]*distance,origin.get(2)+direction[2]*distance);
    }
    /** 固定种子的圆盘散射；同一射击重放不会让客户端重掷有利弹道。 */
    private static double[] spreadDirection(double[] forward,double spread,int pellet,int count,long sequence) {
        if(pellet==0 || spread==0)return forward;
        double[] right=Math.abs(forward[2])<.99?new double[]{-forward[1],forward[0],0}:new double[]{1,0,0};
        double magnitude=Math.sqrt(right[0]*right[0]+right[1]*right[1]+right[2]*right[2]);
        for(int i=0;i<3;i++)right[i]/=magnitude;
        double[] up={forward[1]*right[2]-forward[2]*right[1],forward[2]*right[0]-forward[0]*right[2],forward[0]*right[1]-forward[1]*right[0]};
        double angle=pellet*2.399963229728653+(sequence%360)*Math.PI/180;
        double radius=spread*Math.sqrt(pellet/(double)Math.max(1,count-1));
        double[] result=new double[3];double length=0;
        for(int i=0;i<3;i++){result[i]=forward[i]+radius*(Math.cos(angle)*right[i]+Math.sin(angle)*up[i]);length+=result[i]*result[i];}
        length=Math.sqrt(length);for(int i=0;i<3;i++)result[i]/=length;return result;
    }

    /** 到期重生；断线会保留分数，重生不会产生新的角色身份。 */
    public synchronized List<Map<String,Object>> maintain(long now) {
        List<Map<String,Object>> events=new ArrayList<>();
        try {
            if(collision!=null){collision.tick(now);resolveDamage(now,events);}
            executeQueuedShots(now,events);
            for(Projectile projectile:new ArrayList<>(projectiles.values()))advance(projectile,now,events);
            var iterator=hazards.iterator();
            while(iterator.hasNext()) {
                Hazard hazard=iterator.next();
                if(now>=hazard.expiresAt){iterator.remove();continue;}
                if(now<hazard.nextAt)continue;
                Projectile p=hazard.source;hazard.nextAt=now+p.rule.effectIntervalMillis();
                events.addAll(verifyDamage(p.attackerEntity,p.attackerGeneration,p.attackerId,p.shotSequence,p.rule.hash(),
                    areaDamage(hazard.position,p.rule.blastRadius(),p.rule.damage()),hazard.position,now));
            }
        } catch(Rejection rejection) { throw new IllegalStateException(rejection); }
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

    /** 与实际判定共享同一目录；附带本地资源来源和明确的服务器规则。 */
    public static List<Map<String,Object>> weaponRules() { return WeaponCatalog.publicRules(); }

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
