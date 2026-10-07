#!/usr/bin/env python3
"""独立编译统一世界内核，用确定性 Java 场景验证事务、租约与快照，不启动游戏。"""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "server/src/main/java/offline/multiplayer/WorldRegistry.java"
JAVA = os.environ.get("JAVA", shutil.which("java") or "java")
JAVAC = os.environ.get("JAVAC", shutil.which("javac") or "javac")

HARNESS = r'''
import offline.multiplayer.WorldRegistry;
import offline.multiplayer.WorldRegistry.*;
import offline.multiplayer.WorldRegistry.Vector;
import java.util.*;
import java.util.concurrent.*;

public class WorldRegistryHarness {
    static final long PED=1885233650L, PED2=225514697L, VEHICLE=1032823388L, OBJECT=123L;
    static final long PISTOL=453432689L, RIFLE=0xbfefff6dL;
    static final Map<Kind,Set<Long>> MODELS=Map.of(Kind.PED,Set.of(PED,PED2),Kind.VEHICLE,Set.of(VEHICLE),Kind.OBJECT,Set.of(OBJECT));
    static final Set<Long> WEAPONS=Set.of(0L,2725352035L,PISTOL,RIFLE);
    interface Checked { void run() throws Exception; }
    static void check(boolean condition,String label) { if(!condition) throw new AssertionError(label); }
    static void denied(String code,Checked action) throws Exception {
        try { action.run(); throw new AssertionError("Expected rejection "+code); }
        catch (WorldRegistry.Rejection rejection) { check(code.equals(rejection.code),"Wrong rejection "+rejection.code+" vs "+code); }
    }
    static void invalid(Checked action) throws Exception {
        try { action.run(); throw new AssertionError("Expected invalid immutable component"); }
        catch (IllegalArgumentException expected) {}
    }
    static void immutable(Checked action) throws Exception {
        try { action.run(); throw new AssertionError("Expected read only snapshot"); }
        catch (UnsupportedOperationException expected) {}
    }
    static WorldRegistry world() { return new WorldRegistry("test",MODELS,WEAPONS); }
    static Transform at(double x) { return Transform.at(new Vector(x,0,20),90); }
    static PedView view(long weapon) { return new PedView(null,Actions.idle(),weapon,false,null); }
    static Combat healthy() { return new Combat(200,200,0,0,0); }
    static Entity ped(WorldRegistry world,String player,double x) throws Exception {
        return world.createTrusted(Kind.PED,PED,player,Components.ped(at(x),view(PISTOL),healthy()),player,5000,0).entities().get(0);
    }
    static Entity vehicle(WorldRegistry world,double x) throws Exception {
        return world.createTrusted(Kind.VEHICLE,VEHICLE,null,Components.vehicle(at(x),Vehicle.empty(1)),null,0,0).entities().get(0);
    }
    static Proposal proposal(Entity entity,long sequence,Transform transform,ClientView view) {
        return new Proposal("test",entity.entityId(),entity.ownerEpoch(),sequence,entity.revision(),transform,view);
    }

    static void identityAndComponents() throws Exception {
        WorldRegistry w=world(); Entity p=ped(w,"p1",0),v=vehicle(w,1);
        Entity o=w.createTrusted(Kind.OBJECT,OBJECT,null,Components.object(at(2),false),null,0,0).entities().get(0);
        check(p.entityId().equals("w:test:1") && v.entityId().equals("w:test:2") && o.entityId().equals("w:test:3"),"Server IDs");
        check(p.generation()==1 && p.revision()==1,"Initial generations");
        check(w.playerEntity("p1").equals(p),"Player binding");
        denied("duplicate_player",()->ped(w,"p1",0));
        denied("unsupported_model",()->w.createTrusted(Kind.VEHICLE,PED,null,Components.vehicle(at(0),Vehicle.empty(1)),null,0,0));
        denied("invalid_component",()->w.createTrusted(Kind.OBJECT,OBJECT,null,Components.vehicle(at(0),Vehicle.empty(1)),null,0,0));
        denied("unsupported_weapon",()->w.createTrusted(Kind.PED,PED,"p2",Components.ped(at(0),view(0xffffffffL),healthy()),"p2",5000,0));
        invalid(()->new Vector(Double.NaN,0,0));
        invalid(()->new Rotation(0,0,0,0));
        invalid(()->new Combat(1001,200,0,0,0));
        invalid(()->new Vehicle(1001,1000,Map.of("driver","fake"),new VehicleView(false,false)));
        Map<String,String> badSeats=new LinkedHashMap<>(); badSeats.put("driver","p");badSeats.put("passenger:0","p");
        invalid(()->new Vehicle(1000,1000,badSeats,new VehicleView(false,false)));
        check(w.snapshot().cutRevision()==3,"Rejected create must not commit");
    }

    static void deepImmutabilityAndProjection() throws Exception {
        List<List<Integer>> components=new ArrayList<>(),props=new ArrayList<>();
        for(int i=0;i<12;i++) components.add(new ArrayList<>(List.of(1,0,0)));
        for(int i=0;i<8;i++) props.add(new ArrayList<>(List.of(-1,0)));
        Appearance appearance=new Appearance(components,props,null,null);
        WorldRegistry w=world(); PedView view=new PedView(appearance,new Actions(true,false,false,true,false),PISTOL,true,new Vector(20,0,20));
        w.projectPlayerTrusted("p1",PED,at(0),view,healthy(),0);
        Snapshot baseline=w.snapshot(); Map<String,Object> projection=w.playerStateProjection("p1");
        components.get(0).set(0,999); props.clear();
        check(baseline.entities().get(0).components().ped().appearance().components().get(0).get(0)==1,"Defensive deep copy");
        immutable(()->appearance.components().get(0).set(0,4));
        immutable(()->baseline.entities().clear());
        immutable(()->projection.put("health",0));
        @SuppressWarnings("unchecked") Map<String,Object> reflected=(Map<String,Object>)projection.get("appearance");
        immutable(()->reflected.put("hair",List.of(2,2)));
        Entity p=w.playerEntity("p1");w.setCombatTrusted(p.entityId(),new Combat(0,200,0,1,1000),p.revision(),100);
        check(baseline.entities().get(0).components().combat().health()==200,"Snapshot cut stays immutable");
        check(w.playerStateProjection("p1").get("health").equals(0) && w.playerStateProjection("p1").get("shooting").equals(false),"Authority projection");
        check((double)projection.get("heading")==90,"Heading quaternion compatibility");
    }

    static void proposalsAndMovement() throws Exception {
        WorldRegistry w=world();Entity p=ped(w,"p1",0);
        denied("stale_owner",()->w.propose("other",proposal(p,1,at(1),null),1));
        denied("wrong_world",()->w.propose("p1",new Proposal("old",p.entityId(),p.ownerEpoch(),1,1,at(1),null),1));
        denied("invalid_component",()->w.propose("p1",proposal(p,1,at(1),new VehicleView(true,true)),1));
        Entity a=w.propose("p1",proposal(p,1,at(1),view(RIFLE)),1).entities().get(0);
        check(a.components().combat().health()==200 && a.components().ped().weapon()==RIFLE,"View cannot set combat");
        denied("stale_input",()->w.propose("p1",proposal(a,1,at(1),null),2));
        Entity b=w.propose("p1",proposal(a,2,at(2),null),2).entities().get(0);
        denied("invalid_movement",()->w.propose("p1",proposal(b,3,at(3),null),3));
        check(w.entity(p.entityId()).lastInputSequence()==2,"Rejected movement cannot modify accepted entity");
        denied("invalid_revision",()->w.propose("p1",new Proposal("test",p.entityId(),b.ownerEpoch(),3,999,at(2),null),3));
        Entity c=w.propose("p1",new Proposal("test",p.entityId(),b.ownerEpoch(),3,1,at(2),null),200).entities().get(0);
        check(c.lastInputSequence()==3,"Old transform baseline allowed under fencing and budget");
        w.setCombatTrusted(p.entityId(),new Combat(0,200,0,1,1000),c.revision(),201);
        Entity dead=w.entity(p.entityId());
        denied("dead_entity",()->w.propose("p1",proposal(dead,4,at(2),null),202));
    }

    static void leaseFencingAndMigration() throws Exception {
        WorldRegistry w=world();Entity p=ped(w,"p1",0);
        Entity before=w.propose("p1",proposal(p,40,at(0),null),100).entities().get(0);
        Entity renewed=w.renewLeaseTrusted(p.entityId(),before.ownerEpoch(),6000,200).entities().get(0);
        check(renewed.ownerEpoch()==before.ownerEpoch() && renewed.lastInputSequence()==40,"Renew keeps fencing and input seq");
        denied("stale_revision",()->w.grantOwnerTrusted(p.entityId(),"p2",before.revision(),6500,300));
        Entity migrated=w.grantOwnerTrusted(p.entityId(),"p2",renewed.revision(),6500,300).entities().get(0);
        check(migrated.ownerEpoch()>before.ownerEpoch() && migrated.lastInputSequence()==-1,"Migration fences old owner");
        denied("stale_owner",()->w.propose("p1",proposal(before,41,at(0),null),301));
        Entity accepted=w.propose("p2",proposal(migrated,1,at(0),null),301).entities().get(0);
        Snapshot frozen=w.snapshot();w.expireLeasesTrusted(6500);
        Entity expired=w.entity(p.entityId());
        check(expired.ownerId()==null && expired.ownerEpoch()>accepted.ownerEpoch(),"Expiry revokes");
        check(expired.components().equals(accepted.components()) && expired.generation()==1,"No fake simulation after expiry");
        denied("stale_owner",()->w.propose("p2",proposal(accepted,2,at(0),null),6501));
        check(frozen.entities().get(0).ownerId().equals("p2"),"Old snapshot ownership frozen");
        denied("invalid_tick",()->w.expireLeasesTrusted(0));
    }

    static void atomicSeatsAndDisconnect() throws Exception {
        WorldRegistry w=world();Entity first=ped(w,"p1",0),second=ped(w,"p2",1),v=vehicle(w,2);
        CountDownLatch start=new CountDownLatch(1);ExecutorService pool=Executors.newFixedThreadPool(2);
        List<Future<Boolean>> results=new ArrayList<>();
        for(Entity p:List.of(first,second)) results.add(pool.submit(()->{
            start.await();try{w.enterSeat(p.playerId(),p.entityId(),p.ownerEpoch(),v.entityId(),"driver",v.revision(),100);return true;}
            catch(WorldRegistry.Rejection rejection){check(Set.of("stale_revision","seat_unavailable").contains(rejection.code),"Seat race error");return false;}
        }));
        start.countDown();int winners=0;for(Future<Boolean> result:results)if(result.get(3,TimeUnit.SECONDS))winners++;
        pool.shutdownNow();check(winners==1,"Exactly one driver wins atomic transaction");
        Entity car=w.entity(v.entityId());String occupant=car.components().vehicle().seats().get("driver");Entity driver=w.entity(occupant);
        check(driver.components().attachment().entityId().equals(v.entityId()) && car.ownerId().equals(driver.playerId()),"Seat and vehicle ownership committed together");
        Entity loser=w.entity(first.entityId().equals(occupant)?second.entityId():first.entityId());
        Entity oldDriver=driver;
        denied("attached_entity",()->w.propose(driver.playerId(),proposal(oldDriver,1,at(0),null),101));
        w.enterSeat(loser.playerId(),loser.entityId(),loser.ownerEpoch(),v.entityId(),"passenger:0",car.revision(),102);
        Snapshot cut=w.snapshot();
        w.disconnectOwnerTrusted(driver.playerId(),200);
        Entity freed=w.entity(v.entityId()),detached=w.entity(driver.entityId());
        check(freed.ownerId()==null && freed.components().vehicle().seats().get("driver")==null,"Disconnect releases driver and simulation lease");
        check(detached.components().attachment()==null && detached.ownerId()==null,"Player identity stays but is detached");
        check(freed.components().vehicle().seats().get("passenger:0").equals(loser.entityId()),"Unrelated passenger not lost");
        check(cut.entities().stream().filter(e->e.entityId().equals(v.entityId())).findFirst().get().components().vehicle().seats().get("driver").equals(driver.entityId()),"Snapshot cut before disconnect consistent");
        Entity newOwner=w.grantOwnerTrusted(v.entityId(),loser.playerId(),freed.revision(),5201,201).entities().get(0);
        check(newOwner.ownerEpoch()>car.ownerEpoch() && newOwner.entityId().equals(v.entityId()),"Migration keeps vehicle ID");
        w.deleteTrusted(v.entityId(),newOwner.revision(),202);
        check(w.entity(loser.entityId()).components().attachment()==null,"Vehicle deletion detaches passenger");
        check(w.playerEntity(driver.playerId())!=null,"Driver identity preserved");
    }

    static void healthRespawnAndDeletion() throws Exception {
        WorldRegistry w=world();Entity p=ped(w,"p1",0),v=vehicle(w,2);
        w.setVehicleHealthTrusted(v.entityId(),400,350,v.revision(),100);
        Entity vehicle=w.entity(v.entityId());
        check(vehicle.components().vehicle().engineHealth()==400,"Server vehicle health");
        Entity transferred=w.grantOwnerTrusted(v.entityId(),"p1",vehicle.revision(),5200,200).entities().get(0);
        w.propose("p1",proposal(transferred,1,at(2),new VehicleView(true,true)),201);
        check(w.entity(v.entityId()).components().vehicle().bodyHealth()==350,"Driver view cannot heal vehicle");
        w.setCombatTrusted(p.entityId(),new Combat(0,200,3,1,1000),p.revision(),300);
        Entity dead=w.entity(p.entityId());
        w.respawnTrusted(p.entityId(),at(4),new Combat(200,200,3,1,0),dead.revision(),1000);
        Entity alive=w.entity(p.entityId());
        check(alive.generation()==dead.generation()+1 && alive.entityId().equals(dead.entityId()),"Respawn stable ID with generation");
        check(alive.components().combat().kills()==3 && alive.components().combat().deaths()==1,"Score preserved");
        check(alive.components().ped().actions().equals(Actions.idle()),"Respawn idle");
        w.deleteTrusted(p.entityId(),alive.revision(),1001);
        check(w.playerEntity("p1")==null && w.entity(p.entityId())==null,"Delete binding");
        Tombstone tomb=w.snapshot().tombstones().get(0);
        check(tomb.generation()==alive.generation() && tomb.revision()>alive.revision(),"Versioned tombstone");
        denied("unknown_entity",()->w.propose("p1",proposal(alive,2,at(4),null),1002));
        Entity replacement=w.projectPlayerTrusted("p1",PED,at(0),view(PISTOL),healthy(),1003).entities().get(0);
        check(!replacement.entityId().equals(p.entityId()),"Deleted ID never reused");
    }

    static void boundedHistoryAndEpoch() throws Exception {
        WorldRegistry w=new WorldRegistry("test",MODELS,WEAPONS,new Limits(8,3,2,1000,5000));
        for(int i=0;i<4;i++){
            Entity object=w.createTrusted(Kind.OBJECT,OBJECT,null,Components.object(at(i),false),null,0,i*2).entities().get(0);
            w.deleteTrusted(object.entityId(),object.revision(),i*2+1);
        }
        Snapshot s=w.snapshot();check(s.entities().isEmpty() && s.tombstones().size()==2 && s.cutRevision()==8,"Bounded deleted metadata");
        check(w.changesSince("test",0).snapshotRequired(),"Expired delta needs snapshot");
        check(w.changesSince("old",7).snapshotRequired(),"World epoch mismatch");
        check(w.changesSince("test",9).snapshotRequired(),"Future revision needs snapshot");
        Delta latest=w.changesSince("test",7);check(!latest.snapshotRequired() && latest.commits().size()==1,"Latest delta available");
        check(latest.commits().get(0).deleted().get(0).worldRevision()==8,"Tombstone belongs same cut");
        immutable(()->latest.commits().clear());
        WorldRegistry limited=new WorldRegistry("test",MODELS,WEAPONS,new Limits(1,3,2,1000,5000));
        ped(limited,"p1",0);denied("world_full",()->vehicle(limited,0));
    }

    static void snapshotTransactionsUnderConcurrency() throws Exception {
        WorldRegistry w=world();Entity p=ped(w,"p1",0),v=vehicle(w,1);
        ExecutorService pool=Executors.newSingleThreadExecutor();
        Future<?> mutations=pool.submit(()->{
            try{
                for(int i=0;i<300;i++){
                    Entity current=w.entity(v.entityId());w.enterSeat("p1",p.entityId(),p.ownerEpoch(),v.entityId(),"driver",current.revision(),0);
                    w.leaveSeat("p1",p.entityId(),p.ownerEpoch(),0);
                }
            }catch(Exception error){throw new RuntimeException(error);}
        });
        for(int i=0;i<500;i++){
            Snapshot s=w.snapshot();Map<String,Entity> byId=new HashMap<>();for(Entity entity:s.entities())byId.put(entity.entityId(),entity);
            Entity ped=byId.get(p.entityId()),car=byId.get(v.entityId());
            String driver=car.components().vehicle().seats().get("driver");
            check((driver==null)==(ped.components().attachment()==null),"No partial seat transaction visible");
            if(driver!=null)check(driver.equals(p.entityId()) && ped.components().attachment().entityId().equals(v.entityId()),"Same seat transaction cut");
            check(s.cutRevision()>=2,"Monotonic world cut");
        }
        mutations.get(5,TimeUnit.SECONDS);pool.shutdownNow();
        check(w.snapshot().cutRevision()==602,"Exactly 600 seat transactions committed");
    }

    static void trustedPlayerProjectionAndLifeFencing() throws Exception {
        WorldRegistry w=world();
        // 旧协议已经接受的 uint 型号/武器不能被新目录阻断，但不能绕过新客户端提议目录。
        Entity unknown=w.projectPlayerTrusted("legacy",1L,at(0),view(0xffffffffL),healthy(),0).entities().get(0);
        check(unknown.model()==1L && unknown.components().ped().weapon()==0xffffffffL,"Legacy projection structurally valid");
        denied("unsupported_model",()->w.propose("legacy",proposal(unknown,1,at(0),null),1));
        w.projectPlayerTrusted("legacy",PED,at(0),view(PISTOL),healthy(),2000);
        Entity ready=w.playerEntity("legacy");
        check(ready.ownerEpoch()==unknown.ownerEpoch() && ready.leaseUntilTick()==7000,"Trusted inputs renew current lease");
        w.disconnectOwnerTrusted("legacy",2100);Entity disconnected=w.playerEntity("legacy");
        w.projectPlayerTrusted("legacy",PED,at(0),view(PISTOL),healthy(),2200);
        Entity resumed=w.playerEntity("legacy");
        check(resumed.ownerId().equals("legacy") && resumed.ownerEpoch()>disconnected.ownerEpoch(),"Trusted resume regrants lease");
        denied("stale_owner",()->w.propose("legacy",proposal(ready,5,at(0),null),2201));
        Entity accepted=w.propose("legacy",proposal(resumed,1,at(0),null),2202).entities().get(0);
        w.projectPlayerTrusted("legacy",PED,at(0),view(PISTOL),new Combat(0,200,2,1,3000),2203);
        Entity dead=w.playerEntity("legacy");
        Commit revival=w.projectPlayerTrusted("legacy",PED,at(1),view(PISTOL),new Combat(200,200,2,1,0),3000);
        Entity alive=w.playerEntity("legacy");
        check(revival.change()==Change.RESPAWN && alive.generation()==dead.generation()+1,"Projection single life generation change");
        check(alive.ownerEpoch()>accepted.ownerEpoch() && alive.lastInputSequence()==-1,"Respawn fences old life input");
        denied("stale_owner",()->w.propose("legacy",proposal(accepted,99,at(0),null),3001));
        w.projectPlayerTrusted("legacy",PED,at(1),view(PISTOL),new Combat(200,200,2,1,0),3002);
        check(w.playerEntity("legacy").generation()==alive.generation(),"Later positive health does not repeat respawn");
        check(w.snapshot().entities().size()==1,"Stable projected player identity");
    }

    public static void main(String[] args) throws Exception {
        switch(args[0]){
            case "identity" -> identityAndComponents();
            case "immutable" -> deepImmutabilityAndProjection();
            case "proposal" -> proposalsAndMovement();
            case "lease" -> leaseFencingAndMigration();
            case "seats" -> atomicSeatsAndDisconnect();
            case "lifecycle" -> healthRespawnAndDeletion();
            case "history" -> boundedHistoryAndEpoch();
            case "concurrent" -> snapshotTransactionsUnderConcurrency();
            case "projection" -> trustedPlayerProjectionAndLifeFencing();
            default -> throw new AssertionError(args[0]);
        }
        System.out.println("OK "+args[0]);
    }
}
'''


class WorldRegistryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="world-registry-test-")
        cls.classes = Path(cls.temporary.name) / "classes"
        cls.classes.mkdir()
        harness = Path(cls.temporary.name) / "WorldRegistryHarness.java"
        harness.write_text(HARNESS, encoding="utf-8")
        result = subprocess.run([JAVAC, "--release", "17", "-encoding", "UTF-8", "-d", str(cls.classes),
                                 str(SOURCE), str(harness)], capture_output=True, text=True, encoding="utf-8", timeout=20)
        if result.returncode:
            cls.temporary.cleanup()
            raise AssertionError("Java 世界内核测试编译失败：\n" + result.stdout + result.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def run_scenario(self, name):
        result = subprocess.run([JAVA, "-ea", "-cp", str(self.classes), "WorldRegistryHarness", name],
                                capture_output=True, text=True, encoding="utf-8", timeout=12)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("OK " + name, result.stdout)

    def test_server_identity_and_typed_component_validation(self): self.run_scenario("identity")
    def test_snapshot_deep_immutability_and_legacy_projection(self): self.run_scenario("immutable")
    def test_owner_proposal_cannot_write_health_or_bypass_movement(self): self.run_scenario("proposal")
    def test_lease_expiry_migration_and_old_owner_fencing(self): self.run_scenario("lease")
    def test_atomic_seat_race_disconnect_and_vehicle_deletion(self): self.run_scenario("seats")
    def test_server_health_respawn_generation_and_deleted_identity(self): self.run_scenario("lifecycle")
    def test_bounded_history_tombstones_and_epoch_recovery(self): self.run_scenario("history")
    def test_snapshot_never_observes_half_seat_transaction(self): self.run_scenario("concurrent")
    def test_trusted_legacy_projection_lease_resume_and_life_fencing(self): self.run_scenario("projection")


if __name__ == "__main__":
    unittest.main()
