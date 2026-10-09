#!/usr/bin/env python3
"""Verify real service population handoff and Registry atomic group transactions in an isolated JVM."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
JAVA = os.environ.get("JAVA", shutil.which("java") or "java")
JAVAC = os.environ.get("JAVAC", shutil.which("javac") or "javac")

HARNESS = r'''
package offline.multiplayer;
import java.lang.reflect.*;
import java.util.*;
import offline.multiplayer.WorldRegistry.*;
import offline.multiplayer.WorldRegistry.Vector;

public final class PopulationOwnershipIntegrationHarness {
    static final long MODEL=0xc99f21c4L,CAR_MODEL=0xeb70965fL,UNARMED=0xa2719263L;
    interface Checked{void run()throws Exception;}
    static void check(boolean valid,String detail){if(!valid)throw new AssertionError(detail);}
    static void denied(String code,Checked action)throws Exception{
        try{action.run();throw new AssertionError("Expected "+code);}
        catch(WorldRegistry.Rejection rejected){check(code.equals(rejected.code),"Expected "+code+", got "+rejected.code);}
        catch(WorldService.Problem rejected){check(code.equals(rejected.code),"Expected "+code+", got "+rejected.code);}
    }
    static Field field(String name)throws Exception{Field f=WorldService.class.getDeclaredField(name);f.setAccessible(true);return f;}
    static Map<String,Object> map(Object...values){Map<String,Object> out=new LinkedHashMap<>();for(int i=0;i<values.length;i+=2)out.put((String)values[i],values[i+1]);return out;}
    static Map<String,Object> transform(Transform t){return map("position",t.position().values(),"rotation",t.rotation().values(),"velocity",t.velocity().values(),"angular_velocity",t.angularVelocity().values());}
    static final class Context {
        final WorldService service=new WorldService();
        final WorldRegistry registry;
        final long started;
        final String a="owner-a",b="owner-b",carId,driverId;
        final Vector original;
        Context()throws Exception{
            started=field("started").getLong(service);registry=(WorldRegistry)field("registry").get(service);
            service.join(a);service.worldParticipant(a,true);
            Entity car=registry.snapshot().entities().stream().filter(e->e.kind()==Kind.VEHICLE
                && e.components().vehicle().seats().get("driver")!=null).findFirst().orElseThrow();
            carId=car.entityId();driverId=car.components().vehicle().seats().get("driver");original=car.components().transform().position();
            service.join(b);movePlayer(b,new Vector(original.x()+620,original.y(),original.z()));service.worldParticipant(b,true);
            check(a.equals(registry.entity(carId).ownerId())&&a.equals(registry.entity(driverId).ownerId()),"Initial traffic group owner");
        }
        void time(long elapsed)throws Exception{field("started").setLong(service,started-elapsed*1_000_000L);}
        void movePlayer(String actor,Vector at)throws Exception{
            Entity old=registry.playerEntity(actor);registry.projectPlayerTrusted(actor,old.model(),Transform.at(at,90),
                new PedView(null,Actions.idle(),UNARMED,false,null),new Combat(200,200,0,0,0),service.now());
        }
        void renewPlayers()throws Exception{
            for(String actor:List.of(a,b))movePlayer(actor,registry.playerEntity(actor).components().transform().position());
        }
        void assign()throws Exception{Method method=WorldService.class.getDeclaredMethod("assignPopulation");method.setAccessible(true);method.invoke(service);}
        void ready(String actor,String id)throws Exception{
            service.ready(actor,map("type","entity_ready","world_epoch",service.epoch(),"entity_id",id,"owner_epoch",registry.entity(id).ownerEpoch()));
        }
        Map<String,Object> input(String id,long epoch,long sequence,Transform target){
            return map("type","entity_input","world_epoch",service.epoch(),"entity_id",id,"owner_epoch",epoch,
                "input_seq",sequence,"based_on_revision",registry.entity(id).revision(),"transform",transform(target));
        }
        void driveOutOfCell()throws Exception{
            ready(a,carId);ready(a,driverId);
            for(int step=1;step<=3;step++){
                time(step*2000L);renewPlayers();Entity car=registry.entity(carId);
                Transform target=Transform.at(new Vector(original.x()+200*step,original.y(),original.z()),90);
                service.entityInput(a,input(carId,car.ownerEpoch(),step,target));
            }
            check(registry.entity(carId).components().transform().position().distance(original)==600,"Must actually move car beyond original cell");
            check(registry.entity(driverId).components().transform().equals(registry.entity(carId).components().transform()),"Attached NPC position must move with car");
        }
    }
    static void realPositionAndReadyFence()throws Exception{
        Context c=new Context();c.driveOutOfCell();Entity beforeCar=c.registry.entity(c.carId),beforeDriver=c.registry.entity(c.driverId);
        Vector at=beforeCar.components().transform().position();
        check(at.distance(c.registry.playerEntity(c.a).components().transform().position())>400,"Old owner must exceed leave radius");
        check(at.distance(c.registry.playerEntity(c.b).components().transform().position())<=300,"New owner must satisfy enter radius");
        long cut=c.registry.snapshot().cutRevision();c.assign();Entity car=c.registry.entity(c.carId),driver=c.registry.entity(c.driverId);
        check(c.b.equals(car.ownerId())&&c.b.equals(driver.ownerId()),"Service must hand off actual car position, not original cell anchor");
        check(car.ownerEpoch()>beforeCar.ownerEpoch()&&driver.ownerEpoch()>beforeDriver.ownerEpoch(),"Handoff invalidates both old epochs");
        check(car.components().transform().equals(beforeCar.components().transform())&&driver.components().attachment().equals(beforeDriver.components().attachment()),
            "Ownership handoff preserves confirmed transform and seat attachment");
        List<Commit> groupCommits=c.registry.changesSince(c.service.epoch(),cut).commits().stream()
            .filter(commit->commit.change()==Change.OWNER && commit.entities().stream().anyMatch(e->e.entityId().equals(c.carId))).toList();
        check(groupCommits.size()==1,"Car handoff must appear in exactly one owner commit");
        check(groupCommits.get(0).entities().stream().map(Entity::entityId).collect(java.util.stream.Collectors.toSet()).equals(Set.of(c.carId,c.driverId)),
            "One commit must contain car and driver together");
        long beforeRejected=c.registry.snapshot().cutRevision();
        denied("simulation_not_ready",()->c.service.entityInput(c.b,c.input(c.carId,car.ownerEpoch(),1,car.components().transform())));
        check(c.registry.snapshot().cutRevision()==beforeRejected,"Unready new owner must not publish a partial input");
        denied("stale_owner",()->c.service.ready(c.a,map("type","entity_ready","world_epoch",c.service.epoch(),
            "entity_id",c.carId,"owner_epoch",beforeCar.ownerEpoch())));
        c.ready(c.b,c.carId);c.ready(c.b,c.driverId);
        denied("stale_owner",()->c.service.entityInput(c.a,c.input(c.carId,beforeCar.ownerEpoch(),4,car.components().transform())));
        c.service.entityInput(c.b,c.input(c.carId,c.registry.entity(c.carId).ownerEpoch(),1,car.components().transform()));
        check(c.registry.entity(c.carId).lastInputSequence()==1,"Ready new owner can submit fresh simulation state");
    }
    static void serviceHysteresis()throws Exception{
        Context c=new Context();Vector at=c.original;Entity original=c.registry.entity(c.carId);
        c.time(1000);c.movePlayer(c.a,new Vector(at.x()+350,at.y(),at.z()));c.movePlayer(c.b,new Vector(at.x()+20,at.y(),at.z()));c.assign();
        check(c.a.equals(c.registry.entity(c.carId).ownerId())&&c.registry.entity(c.carId).ownerEpoch()==original.ownerEpoch(),
            "Closer new player must not steal valid owner within leave radius");
        c.time(1100);c.movePlayer(c.a,new Vector(at.x()+400.01,at.y(),at.z()));c.movePlayer(c.b,new Vector(at.x()+300.01,at.y(),at.z()));c.assign();
        check(c.registry.entity(c.carId).ownerId()==null&&c.registry.entity(c.driverId).ownerId()==null,
            "Group must release old owner without selecting a new player outside enter radius");
        c.time(1200);c.movePlayer(c.b,new Vector(at.x()+300,at.y(),at.z()));c.assign();
        check(c.b.equals(c.registry.entity(c.carId).ownerId())&&c.b.equals(c.registry.entity(c.driverId).ownerId()),
            "Exact 300m boundary permits one whole-group handoff");
    }
    static WorldRegistry registry(){return new WorldRegistry("ownership-fixture",Map.of(Kind.PED,Set.of(MODEL),Kind.VEHICLE,Set.of(CAR_MODEL)),Set.of(UNARMED));}
    static Entity ped(WorldRegistry r,String player,long now)throws Exception{return r.createTrusted(Kind.PED,MODEL,player,
        Components.ped(Transform.at(new Vector(0,0,20),0),new PedView(null,Actions.idle(),UNARMED,false,null),new Combat(200,200,0,0,0)),
        player,player==null?0:now+5000,now).entities().get(0);}
    static void atomicRegistryGroup()throws Exception{
        WorldRegistry r=registry();Entity car=r.createTrusted(Kind.VEHICLE,CAR_MODEL,null,
            Components.vehicle(Transform.at(new Vector(0,0,20),0),Vehicle.empty(1)),null,0,0).entities().get(0);
        Entity driver=ped(r,null,0);r.assignNpcSeatTrusted(driver.entityId(),car.entityId(),"driver",0);
        Entity player=ped(r,"player",0);List<String> group=List.of(car.entityId(),driver.entityId());
        Commit first=r.setPopulationOwnersTrusted(group,"a",10);check(first.entities().size()==2,"Initial whole-group grant");
        Entity beforeCar=r.entity(car.entityId()),beforeDriver=r.entity(driver.entityId());long cut=r.snapshot().cutRevision();
        denied("unknown_entity",()->r.setPopulationOwnersTrusted(List.of(car.entityId(),"w:missing:999",driver.entityId()),"b",20));
        check(r.entity(car.entityId()).equals(beforeCar)&&r.entity(driver.entityId()).equals(beforeDriver),"Bad middle ID must not partially change any group member");
        check(r.snapshot().cutRevision()==cut&&r.changesSince(r.worldEpoch(),cut).commits().isEmpty(),"Rejected group must not publish a commit");
        denied("invalid_owner",()->r.setPopulationOwnersTrusted(List.of(car.entityId(),player.entityId()),"b",21));
        denied("invalid_owner",()->r.setPopulationOwnersTrusted(List.of(car.entityId(),car.entityId()),"b",22));
        check(r.entity(car.entityId()).equals(beforeCar)&&r.entity(driver.entityId()).equals(beforeDriver),"Invalid player or duplicate group must leave all members intact");
        Commit migrated=r.setPopulationOwnersTrusted(group,"b",30);
        check(migrated.entities().size()==2&&r.snapshot().cutRevision()==cut+1,"Valid handoff publishes exactly one group transaction");
        check(migrated.entities().stream().allMatch(e->"b".equals(e.ownerId())&&e.leaseUntilTick()==5030),"Group members get matching lease owner and deadline");
        check(r.entity(car.entityId()).ownerEpoch()==beforeCar.ownerEpoch()+1&&r.entity(driver.entityId()).ownerEpoch()==beforeDriver.ownerEpoch()+1,
            "Every changed group member receives one new epoch");
        Commit released=r.setPopulationOwnersTrusted(group,null,40);
        check(released.entities().size()==2&&released.entities().stream().allMatch(e->e.ownerId()==null&&e.leaseUntilTick()==0),"Whole-group lease release is atomic");
    }
    public static void main(String[] args)throws Exception{
        switch(args[0]){
            case "handoff":realPositionAndReadyFence();break;
            case "hysteresis":serviceHysteresis();break;
            case "atomic":atomicRegistryGroup();break;
            default:throw new AssertionError("Unknown scenario");
        }
        System.out.println("PopulationOwnershipIntegrationHarness OK "+args[0]);
    }
}
'''


class PopulationOwnershipIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which(JAVAC) or not shutil.which(JAVA):
            raise unittest.SkipTest("需要 JDK 17 或更新版本")
        cls.temporary = tempfile.TemporaryDirectory(prefix="gta-population-ownership-integration-")
        cls.directory = Path(cls.temporary.name)
        harness = cls.directory / "PopulationOwnershipIntegrationHarness.java"
        harness.write_text(HARNESS, encoding="utf-8")
        sources = sorted((ROOT / "server/src/main/java").rglob("*.java"))
        result = subprocess.run([JAVAC, "--release", "17", "-encoding", "UTF-8", "-d", str(cls.directory),
                                 *map(str, sources), str(harness)], capture_output=True, text=True, encoding="utf-8", timeout=45)
        if result.returncode:
            cls.temporary.cleanup()
            raise AssertionError("人口归属集成夹具编译失败：\n" + result.stdout + result.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def scenario(self, name):
        result = subprocess.run([JAVA, "-ea", "-cp", str(self.directory), "offline.multiplayer.PopulationOwnershipIntegrationHarness", name],
                                capture_output=True, text=True, encoding="utf-8", timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PopulationOwnershipIntegrationHarness OK " + name, result.stdout)

    def test_real_car_position_handoff_atomic_commit_and_ready_epoch_fences(self): self.scenario("handoff")
    def test_service_keeps_owner_through_hysteresis_and_uses_enter_radius(self): self.scenario("hysteresis")
    def test_registry_bad_group_id_player_and_duplicates_never_partially_commit(self): self.scenario("atomic")


if __name__ == "__main__":
    unittest.main()
