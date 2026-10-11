package offline.multiplayer;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/** Server-owned inventory and shared pickup transactions. Call only after session/entry authorization.
 * Ammo totals include the selected clip and are shared by original AmmoInfo, as in CPedInventory.
 * Client messages carry intentions, never quantities or positions. All clocks are server milliseconds.
 */
public final class EquipmentWorld {
    public static final class Rejection extends Exception {
        public final String code;
        Rejection(String code,String text) { super(text);this.code=code; }
    }
    private static final long UNARMED=0xa2719263L;
    private static final long MAX_SEQUENCE=9_007_199_254_740_991L;
    private static final Set<String> BASE=Set.of("type","world_epoch","entity_id","generation","seq","action");
    private final WorldRegistry world;
    private final Map<String,Inventory> inventories=new LinkedHashMap<>();
    private final Map<String,PickupState> pickups=new LinkedHashMap<>();
    private long reloadSerial;

    private static final class Inventory {
        String entityId;
        long generation,revision=1,sequence=-1,lastShot=-1,selected=UNARMED;
        boolean connected=true;
        final Map<Long,Integer> clips=new LinkedHashMap<>();
        final Map<String,Integer> totals=new LinkedHashMap<>();
        Reload reload;
    }
    private record Reload(String token,long weapon,long startedAt,long readyAt) {}
    private static final class PickupState {
        final String id;
        final EquipmentCatalog.Pickup definition;
        final WorldRegistry.Vector position;
        long generation=1,revision=1,availableAt;
        boolean available=true;
        PickupState(String id,EquipmentCatalog.Pickup definition,WorldRegistry.Vector position) {
            this.id=id;this.definition=definition;this.position=position;
        }
    }

    public EquipmentWorld(WorldRegistry world) {
        this.world=Objects.requireNonNull(world);
        // Public-session supply placement policy; quantities/radii/regeneration come from pickups.meta.
        String[] names={"PICKUP_WEAPON_PISTOL","PICKUP_WEAPON_CARBINERIFLE","PICKUP_WEAPON_PUMPSHOTGUN","PICKUP_WEAPON_RPG","PICKUP_ARMOUR_STANDARD"};
        for(int i=0;i<names.length;i++) {
            String name=names[i];
            EquipmentCatalog.Pickup definition=EquipmentCatalog.pickups().values().stream()
                .filter(value->value.name().equals(name)).findFirst().orElseThrow();
            registerPickupTrusted("supply:"+(i+1),definition.hash(),new WorldRegistry.Vector(704.0+i*3,-1083.0,22.4));
        }
    }

    /** Only trusted server placement may mint a pickup identity. Never map this method to client input. */
    public synchronized void registerPickupTrusted(String id,long definition,WorldRegistry.Vector position) {
        if(id==null || !id.matches("[A-Za-z0-9:_-]{1,96}") || pickups.containsKey(id))
            throw new IllegalArgumentException("Invalid or duplicate pickup identity");
        EquipmentCatalog.Pickup rule=EquipmentCatalog.pickup(definition);
        if(rule==null || rule.radius()<=0 || rule.regenerationMillis()<0)
            throw new IllegalArgumentException("Unsupported original pickup definition");
        if(rule.weapons().stream().anyMatch(hash->!supported(EquipmentCatalog.weapon(hash))))
            throw new IllegalArgumentException("Pickup grants an unsupported equipped weapon");
        pickups.put(id,new PickupState(id,rule,Objects.requireNonNull(position)));
    }

    public synchronized Map<String,Object> join(String id,long now) {
        Inventory inventory=ensure(id);
        inventory.connected=true;
        return state(id,inventory,now);
    }
    public synchronized Map<String,Object> snapshot(String id,long now) { return state(id,ensure(id),now); }
    public synchronized void remove(String id) { inventories.remove(id); }
    public synchronized void setConnected(String id,boolean connected,long now) {
        Inventory inventory=inventories.get(id);
        if(inventory==null)return;
        inventory.connected=connected;
        if(!connected && inventory.reload!=null) { inventory.reload=null;inventory.revision++; }
    }

    /** Explicit lifecycle synchronization; repeated joins never mint ammunition in the same generation. */
    private Inventory ensure(String id) {
        WorldRegistry.Entity entity=world.playerEntity(id);
        if(entity==null)throw new IllegalStateException("Equipment requires a registered player");
        Inventory prior=inventories.get(id);
        if(prior!=null && prior.generation==entity.generation() && prior.entityId.equals(entity.entityId()))return prior;
        Inventory value=new Inventory();value.entityId=entity.entityId();value.generation=entity.generation();
        value.revision=prior==null?1:prior.revision+1;
        value.connected=prior==null || prior.connected;
        for(EquipmentCatalog.Weapon weapon:EquipmentCatalog.weapons().values())if(supported(weapon)) {
            EquipmentCatalog.Ammo ammo=EquipmentCatalog.ammo(weapon.ammo());
            if(ammo!=null)value.totals.putIfAbsent(ammo.name(),ammo.maximum());
            value.clips.put(weapon.hash(),ammo==null?0:Math.min(weapon.clipSize(),ammo.maximum()));
        }
        long selected=normalized(entity.components().ped().weapon());
        if(value.clips.containsKey(selected))value.selected=selected;
        inventories.put(id,value);return value;
    }

    private static boolean supported(EquipmentCatalog.Weapon weapon) {
        if(weapon==null || !weapon.onFoot() || WeaponCatalog.rule(weapon.hash())==null)return false;
        if(weapon.ammo().isEmpty())return true;
        EquipmentCatalog.Ammo ammo=EquipmentCatalog.ammo(weapon.ammo());
        return ammo!=null && ammo.maximum()>0 && weapon.clipSize()>0
            && (!weapon.animatedReload() || weapon.thrown() || weapon.reloadMillis()>0);
    }

    public synchronized Map<String,Object> request(String id,Map<String,Object> input,long now)throws Rejection {
        Inventory inventory=ensure(id);
        WorldRegistry.Entity entity=world.playerEntity(id);
        if(!world.worldEpoch().equals(input.get("world_epoch")))throw reject("stale_epoch","装备世界版本已失效");
        if(!inventory.entityId.equals(input.get("entity_id")) || integer(input.get("generation"),"generation")!=inventory.generation)
            throw reject("stale_generation","装备角色生命周期已失效");
        long sequence=integer(input.get("seq"),"seq");
        if(sequence<=inventory.sequence)throw reject("stale_equipment_seq","装备序号必须严格递增");
        String action=input.get("action") instanceof String text?text:"";
        Set<String> extra=switch(action) {
            case "equip","reload_begin"->Set.of("weapon");
            case "reload_complete","reload_cancel"->Set.of("reload_token");
            case "pickup_claim"->Set.of("pickup_id","pickup_generation");
            default->throw reject("invalid_equipment_action","未知装备操作");
        };
        if(!"equipment_request".equals(input.get("type")) || input.size()!=BASE.size()+extra.size()
            || !input.keySet().containsAll(BASE) || !input.keySet().containsAll(extra))
            throw reject("invalid_message","装备请求包含缺失或未授权字段");
        // A syntactically valid intent consumes its sequence even when denied by gameplay rules.
        inventory.sequence=sequence;
        inventory.revision++;
        requireAlive(inventory,entity);
        Map<String,Object> effect=null;
        switch(action) {
            case "equip"->{
                long weapon=integer(input.get("weapon"),"weapon");owned(inventory,weapon);
                if(inventory.selected!=normalized(weapon)) {
                    inventory.selected=normalized(weapon);inventory.reload=null;inventory.revision++;
                }
            }
            case "reload_begin"->{
                long hash=integer(input.get("weapon"),"weapon");
                EquipmentCatalog.Weapon weapon=owned(inventory,hash);
                if(normalized(hash)!=inventory.selected || normalized(entity.components().ped().weapon())!=inventory.selected)
                    throw reject("weapon_changed","装填武器与角色当前武器不一致");
                if(inventory.reload!=null)throw reject("reload_in_progress","已有装填事务");
                EquipmentCatalog.Ammo ammo=EquipmentCatalog.ammo(weapon.ammo());
                if(ammo==null || ammo.infinite() || weapon.thrown() || !weapon.animatedReload())
                    throw reject("reload_not_applicable","当前武器不使用弹匣装填");
                int clip=inventory.clips.get(weapon.hash()),total=inventory.totals.getOrDefault(weapon.ammo(),0);
                if(clip>=weapon.clipSize() || total<=clip)throw reject("reload_not_needed","弹匣已满或没有备用弹药");
                long duration=clip==0?weapon.emptyReloadMillis():weapon.reloadMillis();
                if(duration<=0)throw reject("unsupported_reload","当前武器没有经过验证的原版装填片段");
                inventory.reload=new Reload(inventory.entityId+":"+inventory.generation+":"+(++reloadSerial),weapon.hash(),now,Math.addExact(now,duration));
                inventory.revision++;
            }
            case "reload_complete"->{
                Reload reload=reload(inventory,input);
                if(now<reload.readyAt())throw reject("reload_not_ready","原版装填片段尚未达到完成时间");
                if(inventory.selected!=reload.weapon() || normalized(entity.components().ped().weapon())!=reload.weapon())
                    throw reject("weapon_changed","装填期间武器已切换");
                EquipmentCatalog.Weapon weapon=EquipmentCatalog.weapon(reload.weapon());
                inventory.clips.put(weapon.hash(),Math.min(weapon.clipSize(),inventory.totals.getOrDefault(weapon.ammo(),0)));
                inventory.reload=null;inventory.revision++;
            }
            case "reload_cancel"->{ reload(inventory,input);inventory.reload=null;inventory.revision++; }
            case "pickup_claim"->{
                Object key=input.get("pickup_id");
                PickupState pickup=key instanceof String?pickups.get(key):null;
                if(pickup==null)throw reject("unknown_pickup","拾取物不存在");
                long generation=integer(input.get("pickup_generation"),"pickup_generation");
                if(generation!=pickup.generation || !pickup.available)throw reject("pickup_unavailable","拾取物已被领取或已换代");
                if(entity.components().attachment()!=null)throw reject("pickup_requires_on_foot","此补给点需要下车领取");
                if(entity.components().transform().position().distance(pickup.position)>pickup.definition.radius())
                    throw reject("pickup_out_of_range","角色不在原版拾取半径内");
                boolean changed=false;
                WorldRegistry.Combat life=entity.components().combat();
                // Original CPlayerInfo default max armour is 100 (WASM constructor 41290, +774).
                double armour=Math.min(100,life.armour()+pickup.definition.armour());
                if(armour>life.armour())changed=true;
                for(long hash:pickup.definition.weapons())if(!inventory.clips.containsKey(hash))changed=true;
                for(var amount:pickup.definition.ammo().entrySet())
                    if(inventory.totals.getOrDefault(amount.getKey(),0)<EquipmentCatalog.ammo(amount.getKey()).maximum())changed=true;
                if(!changed)throw reject("pickup_no_capacity","已拥有此装备且弹药已满");
                if(armour>life.armour())try {
                    world.setCombatTrusted(entity.entityId(),new WorldRegistry.Combat(life.health(),life.maxHealth(),
                        life.kills(),life.deaths(),life.respawnAtTick(),armour),entity.revision(),now);
                } catch(WorldRegistry.Rejection rejection) { throw reject(rejection.code,rejection.getMessage()); }
                for(long hash:pickup.definition.weapons())inventory.clips.putIfAbsent(hash,0);
                for(var amount:pickup.definition.ammo().entrySet()) {
                    int total=inventory.totals.getOrDefault(amount.getKey(),0);
                    inventory.totals.put(amount.getKey(),(int)Math.min(EquipmentCatalog.ammo(amount.getKey()).maximum(),(long)total+amount.getValue()));
                }
                pickup.available=false;pickup.availableAt=now+pickup.definition.regenerationMillis();pickup.revision++;
                inventory.revision++;
                effect=map("type","pickup_collected","world_epoch",world.worldEpoch(),"player_id",id,"entity_id",entity.entityId(),
                    "generation",entity.generation(),"pickup",pickupState(pickup));
            }
        }
        var ack=map("type","equipment_ack","player_id",id,"seq",sequence,"action",action,"accepted",true,"state",state(id,inventory,now));
        if(effect!=null)ack.put("event",effect);
        return ack;
    }

    /** Called exactly once when the validated shot actually fires, never when it enters a queue. */
    public synchronized Map<String,Object> consumeShot(String id,long generation,long sequence,long hash,long now)throws Rejection {
        Inventory inventory=ensure(id);WorldRegistry.Entity entity=world.playerEntity(id);
        if(generation!=inventory.generation)throw reject("stale_generation","射击装备生命周期已失效");
        if(sequence<0 || sequence>MAX_SEQUENCE || sequence<=inventory.lastShot)throw reject("stale_equipment_shot","射击已消费或序号过期");
        requireAlive(inventory,entity);
        EquipmentCatalog.Weapon weapon=owned(inventory,hash);
        if(normalized(hash)!=inventory.selected || normalized(entity.components().ped().weapon())!=inventory.selected)
            throw reject("weapon_changed","射击武器未获得装备确认");
        if(inventory.reload!=null)throw reject("weapon_reloading","装填事务尚未完成");
        EquipmentCatalog.Ammo ammo=EquipmentCatalog.ammo(weapon.ammo());
        if(ammo==null)throw reject("weapon_has_no_ammo","当前武器不能消费射击弹药");
        int total=inventory.totals.getOrDefault(ammo.name(),0),clip=inventory.clips.getOrDefault(weapon.hash(),0);
        if(total<1 || clip<1)throw reject(total<1?"out_of_ammo":"empty_clip","没有可发射的权威弹药");
        if(!ammo.infinite()) {
            inventory.totals.put(ammo.name(),--total);
            inventory.clips.put(weapon.hash(),weapon.thrown()?Math.min(weapon.clipSize(),total):clip-1);
            for(var slot:inventory.clips.entrySet()) {
                EquipmentCatalog.Weapon sibling=EquipmentCatalog.weapon(slot.getKey());
                if(sibling.ammo().equals(ammo.name()))slot.setValue(Math.min(slot.getValue(),total));
            }
        }
        inventory.lastShot=sequence;inventory.revision++;
        return state(id,inventory,now);
    }

    /** An authoritative state report may select an owned weapon, but never grants ownership or ammo. */
    public synchronized void validateSelection(String id,long hash)throws Rejection { owned(ensure(id),hash); }

    public synchronized void selectTrusted(String id,long hash,long now)throws Rejection {
        Inventory inventory=ensure(id);owned(inventory,hash);
        long weapon=normalized(hash);
        if(inventory.selected!=weapon) { inventory.selected=weapon;inventory.reload=null;inventory.revision++; }
    }

    public synchronized List<Map<String,Object>> tick(long now) {
        var events=new ArrayList<Map<String,Object>>();
        for(String id:List.copyOf(inventories.keySet())) {
            WorldRegistry.Entity entity=world.playerEntity(id);
            if(entity==null) { inventories.remove(id);continue; }
            Inventory before=inventories.get(id),inventory=ensure(id);
            boolean changed=before!=inventory;
            if(inventory.reload!=null && (!inventory.connected || !entity.components().combat().alive()
                || normalized(entity.components().ped().weapon())!=inventory.reload.weapon())) {
                inventory.reload=null;inventory.revision++;changed=true;
            }
            if(changed)events.add(state(id,inventory,now));
        }
        for(PickupState pickup:pickups.values())if(!pickup.available && now>=pickup.availableAt) {
            pickup.available=true;pickup.availableAt=0;pickup.generation++;pickup.revision++;
            events.add(map("type","pickup_state","world_epoch",world.worldEpoch(),"pickup",pickupState(pickup)));
        }
        return events;
    }

    private Reload reload(Inventory inventory,Map<String,Object> input)throws Rejection {
        if(inventory.reload==null || !inventory.reload.token().equals(input.get("reload_token")))
            throw reject("stale_reload","装填令牌已失效");
        return inventory.reload;
    }
    private static void requireAlive(Inventory inventory,WorldRegistry.Entity entity)throws Rejection {
        if(!inventory.connected || !entity.components().combat().alive())throw reject("invalid_equipment_state","装备操作需要在线存活角色");
    }
    private static EquipmentCatalog.Weapon owned(Inventory inventory,long hash)throws Rejection {
        EquipmentCatalog.Weapon weapon=EquipmentCatalog.weapon(hash);
        if(weapon==null || !inventory.clips.containsKey(weapon.hash()))throw reject("weapon_not_owned","当前角色没有此武器");
        return weapon;
    }
    private Map<String,Object> state(String id,Inventory inventory,long now) {
        var weapons=new ArrayList<Map<String,Object>>();
        for(var slot:inventory.clips.entrySet()) {
            EquipmentCatalog.Weapon weapon=EquipmentCatalog.weapon(slot.getKey());
            EquipmentCatalog.Ammo ammo=EquipmentCatalog.ammo(weapon.ammo());
            int total=ammo==null?0:inventory.totals.getOrDefault(ammo.name(),0);
            weapons.add(map("weapon",weapon.hash(),"name",weapon.name(),"clip",slot.getValue(),"clip_size",weapon.clipSize(),
                "ammo_type",weapon.ammo(),"ammo_hash",ammo==null?0L:ammo.hash(),"total",total,"max_ammo",ammo==null?0:ammo.maximum(),"infinite",ammo!=null && ammo.infinite(),
                "reload_ms",weapon.reloadMillis(),"reload_empty_ms",weapon.emptyReloadMillis(),"thrown",weapon.thrown()));
        }
        Reload reload=inventory.reload;
        return map("type","equipment_state","player_id",id,"world_epoch",world.worldEpoch(),"entity_id",inventory.entityId,
            "generation",inventory.generation,"revision",inventory.revision,"last_seq",inventory.sequence,"last_shot_seq",inventory.lastShot,
            "selected_weapon",inventory.selected,"weapons",weapons,"server_time",now,"armour",world.playerEntity(id).components().combat().armour(),
            "reload",reload==null?null:map("token",reload.token(),"weapon",reload.weapon(),"started_at",reload.startedAt(),
                "ready_at",reload.readyAt(),"phase","awaiting_native_completion"),"pickups",pickupSnapshot());
    }
    public synchronized List<Map<String,Object>> pickupSnapshot() { return pickups.values().stream().map(this::pickupState).toList(); }
    private Map<String,Object> pickupState(PickupState pickup) {
        return map("id",pickup.id,"generation",pickup.generation,"type_hash",pickup.definition.hash(),"name",pickup.definition.name(),
            "model",pickup.definition.model(),"position",pickup.position.values(),"radius",pickup.definition.radius(),
            "available",pickup.available,"available_at",pickup.availableAt,"revision",pickup.revision,"weapons",pickup.definition.weapons(),
            "kind",pickup.definition.armour()>0?"armour":"equipment","armour",pickup.definition.armour());
    }
    private static long normalized(long hash) { return hash==0?UNARMED:hash; }
    private static long integer(Object value,String label)throws Rejection {
        if(!(value instanceof Number number) || !Double.isFinite(number.doubleValue()) || number.doubleValue()!=number.longValue()
            || number.longValue()<0 || number.longValue()>MAX_SEQUENCE)throw reject("invalid_message",label+" 必须为安全非负整数");
        return number.longValue();
    }
    private static Rejection reject(String code,String message) { return new Rejection(code,message); }
    private static Map<String,Object> map(Object... values) {
        var result=new LinkedHashMap<String,Object>();
        for(int i=0;i<values.length;i+=2)result.put((String)values[i],values[i+1]);
        return result;
    }
}
