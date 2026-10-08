package offline.multiplayer;

import java.math.BigDecimal;
import java.util.*;
import offline.multiplayer.WorldRegistry.*;
import offline.multiplayer.WorldRegistry.Vector;

/** 唯一世界协调服务；Registry保存实体事实，CombatWorld只维护输入序号/冷却等规则运行数据。 */
final class WorldService {
    private static final long BLISTA=0xeb70965fL, ASEA=0x94204d89L;
    private static final long UNARMED=0xa2719263L;
    private final WorldRegistry registry;
    private final CombatWorld combat;
    private final long epochMillis=System.currentTimeMillis(),started=System.nanoTime();
    private final Map<String,Offer> offers=new LinkedHashMap<>();
    private final Map<String,LinkedHashMap<String,CompletedRequest>> completedRequests=new HashMap<>();
    private record CompletedRequest(Map<String,Object> input,Map<String,Object> result) {}
    private long meleeRequests,meleeEvents,meleeHits;
    private final Map<String,Long> interactions=new HashMap<>(),lifeReports=new LinkedHashMap<>();
    private final Map<String,String> playerCell=new HashMap<>();
    private final Set<String> populationCells=new LinkedHashSet<>();
    private final Map<String,Vector> cellOrigins=new HashMap<>();
    private final Set<String> worldParticipants=new LinkedHashSet<>(),populationEntities=new LinkedHashSet<>();
    private final Map<String,String> entityCells=new HashMap<>();
    private record Offer(String owner,long epoch,long deadline) {}
    static final class Problem extends Exception {
        final String code;
        Problem(String code,String message){super(message);this.code=code;}
    }
    WorldService(){
        Set<Long> weapons=new HashSet<>(Set.of(0L,UNARMED));
        for(Map<String,Object> rule:CombatWorld.weaponRules())weapons.add(((Number)rule.get("weapon")).longValue());
        registry=new WorldRegistry(UUID.randomUUID().toString(),Map.of(
            Kind.PED,Set.of(0x705e61f2L,0x9c9effd8L,0xc99f21c4L,0xd1feb884L,0x2307a353L,0x2799efd8L,0xc79f6928L,0x9cf26183L),
            Kind.VEHICLE,Set.of(BLISTA,ASEA)),weapons,new Limits(256,4096,4096,1000,5000));
        combat=new CombatWorld(registry);
        try{registry.createTrusted(Kind.VEHICLE,BLISTA,null,Components.vehicle(
            Transform.at(new Vector(715.5,-1088.1,22.4),90),Vehicle.empty(3)),null,0,now());}
        catch(WorldRegistry.Rejection error){throw new IllegalStateException(error);}
    }
    void worldParticipant(String id,boolean enabled){
        if(enabled){worldParticipants.add(id);ensurePopulation(id);assignPopulation();}
        else worldParticipants.remove(id);
    }
    private void ensurePopulation(String actor){
        Entity player=registry.playerEntity(actor);if(player==null)return;Vector origin=position(player);
        String cell=(int)Math.floor(origin.x()/256)+":"+(int)Math.floor(origin.y()/256);
        if(populationCells.contains(cell))return;
        if(populationCells.size()>=8)retireDistantCell(origin);
        if(populationCells.size()>=8)return;
        populationCells.add(cell);cellOrigins.put(cell,origin);
        try{
            for(int i=0;i<8;i++){
                Entity walker=registry.createTrusted(Kind.PED,0xc99f21c4L,null,Components.ped(Transform.at(new Vector(origin.x()+8+i*3,origin.y()-10,origin.z()),90),
                    new PedView(null,Actions.idle(),UNARMED,false,null),new Combat(200,200,0,0,0)),null,0,now()).entities().get(0);
                populationEntities.add(walker.entityId());entityCells.put(walker.entityId(),cell);
                Entity car=registry.createTrusted(Kind.VEHICLE,i%2==0?BLISTA:ASEA,null,Components.vehicle(
                    Transform.at(new Vector(origin.x()+18+i*9,origin.y()+18,origin.z()),90),Vehicle.empty(3)),null,0,now()).entities().get(0);
                Entity driver=registry.createTrusted(Kind.PED,0xc99f21c4L,null,Components.ped(car.components().transform(),
                    new PedView(null,Actions.idle(),UNARMED,false,null),new Combat(200,200,0,0,0)),null,0,now()).entities().get(0);
                registry.assignNpcSeatTrusted(driver.entityId(),car.entityId(),"driver",now());
                for(Entity value:List.of(car,driver)){populationEntities.add(value.entityId());entityCells.put(value.entityId(),cell);}
            }
        }catch(WorldRegistry.Rejection error){throw new IllegalStateException(error);}
    }
    private void retireDistantCell(Vector origin){
        String selected=null;double farthest=400;
        for(String cell:populationCells){Vector point=cellOrigins.get(cell);boolean occupied=false;
            for(String actor:worldParticipants){Entity player=registry.playerEntity(actor);if(player!=null && position(player).distance(point)<400)occupied=true;}
            for(Entity entity:registry.snapshot().entities())if(cell.equals(entityCells.get(entity.entityId())) && entity.kind()==Kind.VEHICLE){
                if(entity.ownerId()!=null && worldParticipants.contains(entity.ownerId()) && entity.leaseUntilTick()>now())occupied=true;
                for(String passenger:entity.components().vehicle().seats().values())if(passenger!=null && registry.entity(passenger)!=null
                    && registry.entity(passenger).playerId()!=null)occupied=true;
            }
            if(!occupied && point.distance(origin)>farthest){selected=cell;farthest=point.distance(origin);}
        }
        if(selected==null)return;String retired=selected;
        try{
            for(String id:new ArrayList<>(populationEntities))if(retired.equals(entityCells.get(id))){
                Entity entity=registry.entity(id);if(entity!=null)registry.deleteTrusted(id,entity.revision(),now());
                populationEntities.remove(id);entityCells.remove(id);offers.remove(id);
            }
            populationCells.remove(retired);cellOrigins.remove(retired);
        }catch(WorldRegistry.Rejection error){throw new IllegalStateException(error);}
    }
    private void assignPopulation(){
        for(String entityId:populationEntities){
            Entity entity=registry.entity(entityId);if(entity==null || entity.ownerId()!=null || (entity.components().combat()!=null && !entity.components().combat().alive()))continue;
            Vector anchor=cellOrigins.get(entityCells.get(entityId));String owner=null;double best=400;
            for(String id:worldParticipants){Entity player=registry.playerEntity(id);if(player==null)continue;double distance=position(player).distance(anchor);
                if(distance<best){owner=id;best=distance;}}
            if(owner!=null)try{offer(entityId,owner);}catch(WorldRegistry.Rejection error){throw new IllegalStateException(error);}
        }
    }
    long now(){return epochMillis+(System.nanoTime()-started)/1_000_000;}
    String epoch(){return registry.worldEpoch();}
    Map<String,Object> join(String id){
        Map<String,Object> profile=combat.join(id,now());
        Entity entity=registry.playerEntity(id);
        profile.put("entity_id",entity.entityId());profile.put("world_epoch",epoch());profile.put("owner_epoch",entity.ownerEpoch());
        return profile;
    }
    void setConnected(String id,boolean connected){
        combat.setConnected(id,connected);
        if(!connected){
            worldParticipants.remove(id);
            try{registry.disconnectOwnerTrusted(id,now());}catch(WorldRegistry.Rejection error){throw new IllegalStateException(error);}
            offers.entrySet().removeIf(item->id.equals(item.getValue().owner));
        }
    }
    void remove(String id){
        Entity entity=registry.playerEntity(id);combat.remove(id);
        if(entity!=null)try{registry.disconnectOwnerTrusted(id,now());entity=registry.playerEntity(id);
            registry.deleteTrusted(entity.entityId(),entity.revision(),now());}
        catch(WorldRegistry.Rejection error){throw new IllegalStateException(error);}
        playerCell.remove(id);worldParticipants.remove(id);interactions.remove(id);completedRequests.remove(id);
        lifeReports.keySet().removeIf(key->key.startsWith(id+":"));
    }
    Map<String,Object> profile(String id){return combat.profile(id);}
    Map<String,Object> meleeStats(){return map("melee_requests_received",meleeRequests,"melee_events_approved",meleeEvents,"melee_hits",meleeHits);}
    int statePlayers(){return combat.statePlayers();}
    Map<String,Object> combatState(){return combat.combatState();}
    Map<String,Object> worldState(){return combat.worldState();}
    CombatWorld.Outcome updateState(String id,Map<String,Object> message,long unused)throws CombatWorld.Rejection{
        CombatWorld.Outcome result=combat.updateState(id,message,now());
        if(result.accepted() && worldParticipants.contains(id)){ensurePopulation(id);assignPopulation();}
        return result;
    }
    List<Map<String,Object>> shoot(String id,Map<String,Object> message,long unused)throws CombatWorld.Rejection{
        return combat.shoot(id,message,now());
    }
    List<Map<String,Object>> maintain(long unused){
        List<Map<String,Object>> events=combat.maintain(now());
        try{
            registry.expireLeasesTrusted(now());
            offers.entrySet().removeIf(item->{Entity entity=registry.entity(item.getKey());
                return entity==null || entity.ownerId()==null || now()>=item.getValue().deadline;});
        }catch(WorldRegistry.Rejection error){throw new IllegalStateException(error);}
        assignPopulation();return events;
    }
    Map<String,Object> snapshot(){return snapshot(registry.snapshot());}
    Snapshot cut(){return registry.snapshot();}
    Entity player(String id){return registry.playerEntity(id);}
    List<Map<String,Object>> snapshotMessages(String id,Set<String> scope,long streamSeq){
        Snapshot cut=registry.snapshot();scope.clear();scope.addAll(scope(id,Set.of()));
        String snapshotId=UUID.randomUUID().toString();
        List<Map<String,Object>> visible=new ArrayList<>();for(Entity entity:cut.entities())if(scope.contains(entity.entityId()))visible.add(entity(entity));
        List<Map<String,Object>> result=new ArrayList<>();
        result.add(map("type","snapshot_begin","schema_version",2,"world_epoch",epoch(),"snapshot_id",snapshotId,
            "cut_revision",cut.cutRevision(),"world_tick",cut.worldTick(),"stream_seq",streamSeq));
        for(int start=0,index=0;start<visible.size();start+=16,index++)result.add(map("type","snapshot_chunk","schema_version",2,
            "world_epoch",epoch(),"snapshot_id",snapshotId,"cut_revision",cut.cutRevision(),"index",index,
            "entities",visible.subList(start,Math.min(visible.size(),start+16)),"tombstones",List.of()));
        result.add(map("type","snapshot_end","schema_version",2,"world_epoch",epoch(),"snapshot_id",snapshotId,
            "cut_revision",cut.cutRevision(),"world_tick",cut.worldTick(),"stream_seq",streamSeq));
        return result;
    }
    Map<String,Object> delta(String id,Set<String> previous,long afterRevision,long streamSeq)throws Problem{
        Delta changes=registry.changesSince(epoch(),afterRevision);
        if(changes.snapshotRequired())throw new Problem("snapshot_required","增量历史已过期，需要完整快照");
        Set<String> current=scope(id,previous),changed=new LinkedHashSet<>();List<Map<String,Object>> deleted=new ArrayList<>();
        for(Commit commit:changes.commits()){
            for(Entity entity:commit.entities())if(current.contains(entity.entityId()))changed.add(entity.entityId());
            for(Tombstone tomb:commit.deleted())if(previous.contains(tomb.entityId()))deleted.add(tombstone(tomb));
        }
        for(String entering:current)if(!previous.contains(entering))changed.add(entering);
        List<String> leaving=previous.stream().filter(value->!current.contains(value)).toList();
        List<Map<String,Object>> entities=new ArrayList<>();for(String changedId:changed){Entity entity=registry.entity(changedId);if(entity!=null)entities.add(entity(entity));}
        previous.clear();previous.addAll(current);
        Snapshot cut=registry.snapshot();
        if(entities.isEmpty() && deleted.isEmpty() && leaving.isEmpty())return null;
        return map("type","world_delta","schema_version",2,"world_epoch",epoch(),"world_revision",cut.cutRevision(),
            "world_tick",cut.worldTick(),"stream_seq",streamSeq,"entities",entities,"tombstones",deleted,"scope_leave",leaving);
    }
    private Set<String> scope(String id,Set<String> previous){
        Entity player=registry.playerEntity(id);Set<String> values=new LinkedHashSet<>();if(player==null)return values;
        Vector origin=position(player);
        for(Entity entity:registry.snapshot().entities()){
            double range=previous.contains(entity.entityId())?400:300;
            // 固定100米格网筛选，边界用300/400米距离滞回。
            Vector point=position(entity);
            if(Math.abs(Math.floor(point.x()/100)-Math.floor(origin.x()/100))<=5 &&
                Math.abs(Math.floor(point.y()/100)-Math.floor(origin.y()/100))<=5 && origin.distance(point)<=range)values.add(entity.entityId());
        }
        values.add(player.entityId());
        boolean changed;
        do{changed=false;for(Entity entity:registry.snapshot().entities())if(values.contains(entity.entityId())){
            if(entity.components().attachment()!=null)changed|=values.add(entity.components().attachment().entityId());
            if(entity.components().vehicle()!=null)for(String ped:entity.components().vehicle().seats().values())if(ped!=null)changed|=values.add(ped);
        }}while(changed);
        return values;
    }
    void ready(String actor,Map<String,Object> input)throws Problem,WorldRegistry.Rejection{
        fields(input,"type","world_epoch","entity_id","owner_epoch");epoch(input);
        String id=text(input.get("entity_id"),128);long leaseEpoch=integer(input.get("owner_epoch"),0,9_007_199_254_740_991L);
        Entity entity=required(id);Offer offer=offers.get(id);
        if(offer==null || !offer.owner.equals(actor) || offer.epoch!=leaseEpoch || offer.deadline<=now() || entity.ownerEpoch()!=leaseEpoch)
            throw new Problem("stale_owner","该模拟邀请无效或已过期");
        offers.remove(id);registry.renewLeaseTrusted(id,leaseEpoch,now()+5000,now());
    }
    void entityInput(String actor,Map<String,Object> input)throws Problem,WorldRegistry.Rejection{
        fields(input,"type","world_epoch","entity_id","owner_epoch","input_seq","based_on_revision","transform","view");epoch(input);
        Proposal proposal=parseProposal(input);submitBatch(actor,List.of(proposal));
    }
    void entityBatch(String actor,Map<String,Object> input)throws Problem,WorldRegistry.Rejection{
        fields(input,"type","world_epoch","updates");epoch(input);
        if(!(input.get("updates")instanceof List<?> values)||values.isEmpty()||values.size()>24)
            throw new Problem("invalid_batch","更新批次必须包含1–24个实体");
        List<Proposal> proposals=new ArrayList<>();
        for(Object value:values){Map<String,Object> update=object(value);fields(update,"entity_id","owner_epoch","input_seq","based_on_revision","transform","view");
            proposals.add(parseProposal(update));}
        submitBatch(actor,proposals);
    }
    private void submitBatch(String actor,List<Proposal> proposals)throws WorldRegistry.Rejection{
        long tick=now();Set<String> vehicleIds=new HashSet<>(),readyDependents=new LinkedHashSet<>();
        for(Proposal proposal:proposals){Entity entity=registry.entity(proposal.entityId());if(entity!=null && entity.kind()==Kind.VEHICLE)vehicleIds.add(entity.entityId());}
        for(Entity entity:registry.snapshot().entities())
            if(entity.playerId()==null && entity.kind()==Kind.PED && entity.components().attachment()!=null
                && vehicleIds.contains(entity.components().attachment().entityId()) && actor.equals(entity.ownerId())
                && entity.leaseUntilTick()>tick && !offers.containsKey(entity.entityId()))readyDependents.add(entity.entityId());
        registry.proposeBatch(actor,proposals,tick,readyDependents);
    }
    private Proposal parseProposal(Map<String,Object> input)throws Problem{
        String id=text(input.get("entity_id"),128);Entity entity=required(id);
        if(entity.playerId()!=null)throw new Problem("player_input_required","玩家角色继续使用已校验的player_state输入");
        if(offers.containsKey(id))throw new Problem("simulation_not_ready","加载完成并确认实体后才能提交模拟状态");
        long ownerEpoch=integer(input.get("owner_epoch"),0,9_007_199_254_740_991L);
        ClientView view=null;
        if(input.containsKey("view")){
            Map<String,Object> value=object(input.get("view"));
            if(entity.kind()==Kind.VEHICLE){fields(value,"engine_on","lights_on");view=new VehicleView(bool(value.get("engine_on")),bool(value.get("lights_on")));}
            else if(entity.kind()==Kind.PED){fields(value,"weapon","shooting","actions","aim_target");
                view=new PedView(entity.components().ped().appearance(),actions(object(value.get("actions"))),
                    integer(value.get("weapon"),0,0xffffffffL),bool(value.get("shooting")),value.containsKey("aim_target")?vector(value.get("aim_target")):null);}
        }
        return new Proposal(epoch(),id,ownerEpoch,integer(input.get("input_seq"),0,9_007_199_254_740_991L),
            integer(input.get("based_on_revision"),0,9_007_199_254_740_991L),transform(input.get("transform")),view);
    }
    List<Map<String,Object>> interaction(String actor,Map<String,Object> input)throws Problem,WorldRegistry.Rejection{
        fields(input,"type","world_epoch","request_id","action","entity_id","seat","expected_revision","target_generation");epoch(input);
        String request=text(input.get("request_id"),64),action=text(input.get("action"),40);
        if("melee".equals(action))meleeRequests++;
        LinkedHashMap<String,CompletedRequest> cache=completedRequests.get(actor);
        CompletedRequest previous=cache==null?null:cache.get(request);
        if(previous!=null){
            if(!previous.input.equals(input))throw new Problem("invalid_request","同一请求ID不能复用为不同内容");
            return List.of(previous.result);
        }
        Entity player=registry.playerEntity(actor);
        if(player==null)throw new Problem("not_in_room","请先加入公共世界");
        boolean untargeted="melee".equals(action) && (!input.containsKey("entity_id") || input.get("entity_id")==null);
        if(untargeted && (input.containsKey("expected_revision") || input.containsKey("target_generation")))
            throw new Problem("invalid_message","无目标近战不应携带目标版本");
        long revision=untargeted?0:integer(input.get("expected_revision"),0,9_007_199_254_740_991L);
        String target=untargeted?null:text(input.get("entity_id"),128);
        Entity targetEntity=untargeted?null:required(target);
        if(targetEntity!=null){
            if(input.containsKey("target_generation") && integer(input.get("target_generation"),1,9_007_199_254_740_991L)!=targetEntity.generation())
                throw new Problem("stale_generation","目标已进入新的生命周期");
            if(revision<(targetEntity.generation()==1?0:registry.generationStartRevision(target)))throw new Problem("stale_generation","请求基线属于旧生命周期");
            if(revision>targetEntity.revision())throw new Problem("invalid_revision","请求基线超出当前目标版本");
        }
        List<Map<String,Object>> events=new ArrayList<>();Map<String,Object> meleeResult=null;
        if("enter_vehicle".equals(action)){
            String seat=text(input.get("seat"),32);registry.enterSeat(actor,player.entityId(),player.ownerEpoch(),target,seat,revision,now());
            if("driver".equals(seat))offer(target,actor);
        }else if("leave_vehicle".equals(action)){
            if(player.components().attachment()==null || !player.components().attachment().entityId().equals(target))throw new Problem("invalid_seat","目标不是当前乘坐的车辆");
            registry.leaveSeat(actor,player.entityId(),player.ownerEpoch(),now());offers.remove(target);
        }else if("melee".equals(action)){
            if(input.containsKey("seat"))throw new Problem("invalid_message","近战不接受座位字段");
            if(!actor.equals(player.ownerId()) || player.leaseUntilTick()<=now())throw new Problem("stale_owner","玩家角色需要有效活动租约");
            if(!player.components().combat().alive())throw new Problem("dead_entity","死亡角色不能参与近战");
            Entity victim=untargeted?nearestMeleeTarget(player):targetEntity;
            if(victim!=null){
                if(victim.kind()!=Kind.PED || victim.entityId().equals(player.entityId()) || victim.components().combat()==null)
                    throw new Problem("invalid_target","近战目标必须是另一个角色");
                if(!victim.components().combat().alive())throw new Problem("dead_entity","死亡角色不能参与近战");
                String geometry=meleeGeometry(player,victim);
                if(geometry!=null)throw new Problem(geometry,"too_far".equals(geometry)?"近战距离或高度差超出范围":"近战目标必须位于角色前方");
            }
            long tick=now(),last=interactions.getOrDefault(actor,Long.MIN_VALUE);
            if(last!=Long.MIN_VALUE && tick-last<700)throw new Problem("rate_limited","近战冷却尚未结束");
            boolean hit=victim!=null;int damage=hit?Math.min(20,victim.components().combat().health()):0;
            if(hit)events.addAll(applyDamage(player,victim,20,tick));
            interactions.put(actor,tick);meleeEvents++;if(hit)meleeHits++;
            Entity updated=hit?registry.entity(victim.entityId()):registry.entity(player.entityId());
            Integer health=hit?updated.components().combat().health():null;
            long currentRevision=updated.revision();
            Map<String,Object> event=map("type","melee_event","schema_version",2,"world_epoch",epoch(),
                "event_id","m:"+epoch()+":"+meleeEvents,"request_id",request,"action","punch","accepted",true,
                "attacker_entity_id",player.entityId(),"attacker_id",actor,"attacker_generation",player.generation(),
                "target_entity_id",hit?victim.entityId():null,"target_generation",hit?victim.generation():null,
                "hit",hit,"damage",damage,"health",health,"revision",currentRevision,
                "world_revision",registry.snapshot().cutRevision(),"world_tick",tick);
            events.add(event);
            meleeResult=map("action","melee","hit",hit,"damage",damage,"health",health,
                "attacker_entity_id",player.entityId(),"attacker_generation",player.generation(),
                "target_entity_id",hit?victim.entityId():null,"target_generation",hit?victim.generation():null,
                "revision",currentRevision);
        }else throw new Problem("unsupported_interaction","不支持该交互动作");
        Map<String,Object> resultValues=map("type","interaction_result","request_id",request,"accepted",true);
        if(meleeResult!=null)resultValues.putAll(meleeResult);
        Map<String,Object> result=Collections.unmodifiableMap(resultValues);
        cache=completedRequests.computeIfAbsent(actor,ignored->new LinkedHashMap<>());
        cache.put(request,new CompletedRequest(Collections.unmodifiableMap(new LinkedHashMap<>(input)),result));
        while(cache.size()>64)cache.remove(cache.keySet().iterator().next());
        events.add(result);return events;
    }
    private Entity nearestMeleeTarget(Entity player){
        Entity target=null;double nearest=2.0001;
        for(Entity candidate:registry.snapshot().entities()){
            if(candidate.kind()!=Kind.PED || candidate.entityId().equals(player.entityId()) || candidate.components().combat()==null
                || !candidate.components().combat().alive() || meleeGeometry(player,candidate)!=null)continue;
            if(candidate.playerId()!=null){Map<String,Object> profile=profile(candidate.playerId());
                // 断线角色已撤销所有权，不能被继续当作近战活体目标。
                if(profile==null || candidate.ownerId()==null)continue;
            }else if(candidate.ownerId()==null)continue;
            double distance=position(player).distance(position(candidate));
            if(distance<nearest){nearest=distance;target=candidate;}
        }
        return target;
    }
    private String meleeGeometry(Entity attacker,Entity victim){
        Vector source=position(attacker),destination=position(victim);
        double dx=destination.x()-source.x(),dy=destination.y()-source.y(),horizontal=Math.hypot(dx,dy);
        if(source.distance(destination)>2 || Math.abs(destination.z()-source.z())>1.5)return "too_far";
        if(horizontal>.1){double heading=Math.toRadians(attacker.components().transform().rotation().heading());
            if((-Math.sin(heading)*dx+Math.cos(heading)*dy)/horizontal<.15)return "not_facing";}
        return null;
    }
    List<Map<String,Object>> simulation(String actor,Map<String,Object> input)throws Problem,WorldRegistry.Rejection{
        fields(input,"type","world_epoch","entity_id","owner_epoch","input_seq","kind","reason","health","engine_health","body_health");epoch(input);
        Entity entity=required(text(input.get("entity_id"),128));String kind=text(input.get("kind"),32);
        long ownerEpoch=integer(input.get("owner_epoch"),0,9_007_199_254_740_991L),seq=integer(input.get("input_seq"),0,9_007_199_254_740_991L);
        if(!actor.equals(entity.ownerId()) || entity.ownerEpoch()!=ownerEpoch || entity.leaseUntilTick()<=now() || offers.containsKey(entity.entityId()))
            throw new Problem("stale_owner","只有当前已激活的模拟所有者可以提交候选结果");
        String key=actor+":"+entity.entityId()+":"+ownerEpoch;
        if(seq<=lifeReports.getOrDefault(key,-1L))throw new Problem("stale_input","候选结果序号过期");
        List<Map<String,Object>> events=new ArrayList<>();
        if("life_report".equals(kind)){
            fields(input,"type","world_epoch","entity_id","owner_epoch","input_seq","kind","reason","health");
            if(!actor.equals(entity.playerId()))throw new Problem("invalid_target","生命候选只能报告自己的玩家角色");
            String reason=text(input.get("reason"),32);if(!Set.of("environmental","dead","arrest").contains(reason))throw new Problem("invalid_reason","不支持的本地生命候选原因");
            int health=(int)integer(input.get("health"),0,200);Combat life=entity.components().combat();
            if(health>life.health())throw new Problem("health_increase_denied","客户端不能请求恢复生命值");
            if("arrest".equals(reason) || "dead".equals(reason))health=0;
            registry.setCombatTrusted(entity.entityId(),new Combat(health,200,life.kills(),life.deaths()+(life.alive() && health==0?1:0),health==0?(life.alive()?now()+4000:life.respawnAtTick()):0),entity.revision(),now());
            if(health==0 && life.alive())events.add(map("type","death","player_id",actor,"killer_id",null,"kills",0,
                "deaths",life.deaths()+1,"respawn_at",now()+4000,"revision",registry.entity(entity.entityId()).revision()));
            events.add(combatState());
        }else if("entity_health".equals(kind)){
            fields(input,"type","world_epoch","entity_id","owner_epoch","input_seq","kind","health");
            if(entity.playerId()!=null || entity.kind()!=Kind.PED || entity.components().combat()==null)throw new Problem("invalid_target","该候选只能作用于本租约NPC");
            int health=(int)integer(input.get("health"),0,200);Combat life=entity.components().combat();
            if(health>life.health())throw new Problem("health_increase_denied","模拟候选不能恢复NPC生命值");
            registry.setCombatBatchTrusted(Map.of(entity.entityId(),new Combat(health,200,life.kills(),life.deaths()+(life.alive()&&health==0?1:0),0)),now());
        }else if("vehicle_damage".equals(kind)){
            fields(input,"type","world_epoch","entity_id","owner_epoch","input_seq","kind","engine_health","body_health");
            if(entity.kind()!=Kind.VEHICLE)throw new Problem("invalid_target","载具损伤候选必须作用于载具");
            double engine=number(input.get("engine_health"),-4000,1000),body=number(input.get("body_health"),0,1000);
            if(engine>entity.components().vehicle().engineHealth() || body>entity.components().vehicle().bodyHealth())throw new Problem("health_increase_denied","模拟候选不能修复载具");
            registry.setVehicleHealthTrusted(entity.entityId(),engine,body,entity.revision(),now());
        }else throw new Problem("unsupported_simulation","不支持此类模拟候选");
        lifeReports.put(key,seq);while(lifeReports.size()>2048)lifeReports.remove(lifeReports.keySet().iterator().next());return events;
    }
    private List<Map<String,Object>> applyDamage(Entity attacker,Entity victim,int damage,long tick)throws WorldRegistry.Rejection{
        Combat life=victim.components().combat(),a=attacker.components().combat();int amount=Math.min(damage,life.health()),health=life.health()-amount;
        Map<String,Combat> changes=new LinkedHashMap<>();changes.put(victim.entityId(),new Combat(health,life.maxHealth(),life.kills(),life.deaths()+(health==0?1:0),health==0?tick+4000:0));
        if(health==0)changes.put(attacker.entityId(),new Combat(a.health(),a.maxHealth(),a.kills()+1,a.deaths(),a.respawnAtTick()));
        registry.setCombatBatchTrusted(changes,tick);List<Map<String,Object>> events=new ArrayList<>();
        if(victim.playerId()!=null){events.add(map("type","damage","victim_id",victim.playerId(),"attacker_id",attacker.playerId(),"health",health,"damage",amount,"revision",registry.entity(victim.entityId()).revision()));
            if(health==0)events.add(map("type","death","player_id",victim.playerId(),"killer_id",attacker.playerId(),"kills",a.kills()+1,"deaths",life.deaths()+1,"respawn_at",tick+4000,"revision",registry.entity(victim.entityId()).revision()));}
        events.add(combatState());return events;
    }
    private void offer(String entityId,String actor)throws WorldRegistry.Rejection{
        Entity entity=registry.entity(entityId);if(!actor.equals(entity.ownerId()))registry.grantOwnerTrusted(entityId,actor,entity.revision(),now()+5000,now());
        entity=registry.entity(entityId);offers.put(entityId,new Offer(actor,entity.ownerEpoch(),now()+5000));
    }
    private Map<String,Object> snapshot(Snapshot snapshot){
        List<Map<String,Object>> entities=new ArrayList<>(),deleted=new ArrayList<>();for(Entity entity:snapshot.entities())entities.add(entity(entity));
        for(Tombstone tomb:snapshot.tombstones())deleted.add(tombstone(tomb));
        return map("schema_version",2,"world_epoch",epoch(),"cut_revision",snapshot.cutRevision(),"world_tick",snapshot.worldTick(),
            "entities",entities,"tombstones",deleted,"source","authoritative_world_registry","shared_population",!populationEntities.isEmpty(),"native_clone_transport",false);
    }
    Map<String,Object> entity(Entity entity){
        Components c=entity.components();Map<String,Object> components=map("transform",map("position",c.transform().position().values(),"rotation",c.transform().rotation().values(),
            "velocity",c.transform().velocity().values(),"angular_velocity",c.transform().angularVelocity().values()));
        if(c.ped()!=null){Map<String,Object> ped=map("weapon",c.ped().weapon(),"shooting",c.ped().shooting(),"actions",c.ped().actions().values());
            if(c.ped().aimTarget()!=null)ped.put("aim_target",c.ped().aimTarget().values());components.put("ped",ped);if(c.ped().appearance()!=null)components.put("appearance",c.ped().appearance().values());}
        if(c.vehicle()!=null)components.put("vehicle",map("engine_health",c.vehicle().engineHealth(),"body_health",c.vehicle().bodyHealth(),"seats",c.vehicle().seats(),
            "engine_on",c.vehicle().view().engineOn(),"lights_on",c.vehicle().view().lightsOn()));
        if(c.object()!=null)components.put("object",map("dynamic",c.object().dynamic()));
        if(c.attachment()!=null)components.put("attachment",map("entity_id",c.attachment().entityId(),"seat",c.attachment().seat()));
        if(c.combat()!=null)components.put("combat",map("health",c.combat().health(),"max_health",c.combat().maxHealth(),"alive",c.combat().alive(),"kills",c.combat().kills(),"deaths",c.combat().deaths(),"respawn_at_tick",c.combat().respawnAtTick()));
        return map("entity_id",entity.entityId(),"kind",entity.kind().name().toLowerCase(Locale.ROOT),"player_id",entity.playerId(),"model",entity.model(),"revision",entity.revision(),
            "generation",entity.generation(),"owner_id",entity.ownerId(),"owner_epoch",entity.ownerEpoch(),"lease_until_tick",entity.leaseUntilTick(),"last_input_seq",entity.lastInputSequence(),
            "population_cell",entityCells.get(entity.entityId()),"simulation_task",entity.playerId()==null && entity.kind()==Kind.PED?(entity.components().attachment()==null?"wander":"driver"):null,
            "ownership",entity.ownerId()==null?"unowned":offers.containsKey(entity.entityId())?"offered":"active","combat_revision",entity.revision(),"components",components);
    }
    private Map<String,Object> tombstone(Tombstone value){return map("entity_id",value.entityId(),"revision",value.revision(),"generation",value.generation(),"world_revision",value.worldRevision());}
    private Vector position(Entity entity){
        if(entity.components().attachment()!=null){Entity vehicle=registry.entity(entity.components().attachment().entityId());if(vehicle!=null)return vehicle.components().transform().position();}
        return entity.components().transform().position();
    }
    private Entity required(String id)throws Problem{Entity entity=registry.entity(id);if(entity==null)throw new Problem("unknown_entity","实体不存在");return entity;}
    private void epoch(Map<String,Object> value)throws Problem{if(!epoch().equals(value.get("world_epoch")))throw new Problem("wrong_world","输入属于另一世界");}
    @SuppressWarnings("unchecked") static Map<String,Object> object(Object value)throws Problem{if(!(value instanceof Map<?,?>))throw new Problem("invalid_message","组件必须是对象");return(Map<String,Object>)value;}
    static void fields(Map<String,Object> value,String...names)throws Problem{if(value.keySet().stream().anyMatch(key->!Arrays.asList(names).contains(key)))throw new Problem("invalid_message","消息包含不允许的字段");}
    static String text(Object value,int length)throws Problem{if(!(value instanceof String s) || s.isBlank() || s.length()>length || s.chars().anyMatch(c->c<32))throw new Problem("invalid_message","文本字段无效");return s;}
    static long integer(Object value,long min,long max)throws Problem{if(value instanceof Number n)try{long result=new BigDecimal(n.toString()).longValueExact();if(result>=min && result<=max)return result;}catch(ArithmeticException|NumberFormatException ignored){}throw new Problem("invalid_message","整数无效");}
    static double number(Object value,double min,double max)throws Problem{if(value instanceof Number n){double result=n.doubleValue();if(Double.isFinite(result) && result>=min && result<=max)return result;}throw new Problem("invalid_message","数值无效");}
    static boolean bool(Object value)throws Problem{if(value instanceof Boolean b)return b;throw new Problem("invalid_message","布尔值无效");}
    static Vector vector(Object value)throws Problem{if(!(value instanceof List<?> l)||l.size()!=3)throw new Problem("invalid_message","向量必须有三个数值");return new Vector(number(l.get(0),-16000,16000),number(l.get(1),-16000,16000),number(l.get(2),-16000,16000));}
    static Transform transform(Object value)throws Problem{Map<String,Object> c=object(value);fields(c,"position","rotation","velocity","angular_velocity");
        if(!(c.get("rotation")instanceof List<?> r)||r.size()!=4)throw new Problem("invalid_message","旋转必须有四个数值");
        try{return new Transform(vector(c.get("position")),new Rotation(number(r.get(0),-1,1),number(r.get(1),-1,1),number(r.get(2),-1,1),number(r.get(3),-1,1)),vector(c.get("velocity")),vector(c.get("angular_velocity")));}
        catch(IllegalArgumentException error){throw new Problem("invalid_message",error.getMessage());}}
    static Actions actions(Map<String,Object> value)throws Problem{fields(value,"aiming","reloading","jumping","ducking","sprinting");return new Actions(bool(value.get("aiming")),bool(value.get("reloading")),bool(value.get("jumping")),bool(value.get("ducking")),bool(value.get("sprinting")));}
    static Map<String,Object> map(Object...values){Map<String,Object> result=new LinkedHashMap<>();for(int i=0;i<values.length;i+=2)result.put((String)values[i],values[i+1]);return result;}
}
