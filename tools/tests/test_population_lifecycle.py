#!/usr/bin/env python3
"""Compile the real service and verify population cleanup/refill without starting a game engine."""
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

public final class PopulationLifecycleHarness {
    static final long UNARMED=0xa2719263L;
    static void check(boolean valid,String detail){if(!valid)throw new AssertionError(detail);}
    static Field field(String name)throws Exception{Field f=WorldService.class.getDeclaredField(name);f.setAccessible(true);return f;}
    static Map<String,Object> map(Object...values){Map<String,Object> out=new LinkedHashMap<>();for(int i=0;i<values.length;i+=2)out.put((String)values[i],values[i+1]);return out;}
    static final class Context {
        final WorldService service=new WorldService();
        final WorldRegistry registry;
        final long initialStarted;
        final Vector origin;
        final String actor="population-fixture";
        Context()throws Exception{
            initialStarted=field("started").getLong(service);
            registry=(WorldRegistry)field("registry").get(service);
            service.join(actor);service.worldParticipant(actor,true);
            origin=registry.playerEntity(actor).components().transform().position();
            check(managed().size()==24,"Initial real service must register 8 walkers, 8 cars and 8 drivers");
        }
        @SuppressWarnings("unchecked") Set<String> managed()throws Exception{return new HashSet<>((Set<String>)field("populationEntities").get(service));}
        List<Entity> walkers()throws Exception{return managed().stream().map(registry::entity)
            .filter(e->e!=null && e.kind()==Kind.PED && e.components().attachment()==null).sorted(Comparator.comparing(Entity::entityId)).toList();}
        Entity traffic()throws Exception{return managed().stream().map(registry::entity)
            .filter(e->e!=null && e.kind()==Kind.VEHICLE).findFirst().orElseThrow();}
        void time(long elapsed,Vector player)throws Exception{
            field("started").setLong(service,initialStarted-elapsed*1_000_000L);
            Entity old=registry.playerEntity(actor);
            registry.projectPlayerTrusted(actor,old.model(),Transform.at(player,90),
                new PedView(null,Actions.idle(),UNARMED,false,null),new Combat(200,200,0,0,0),service.now());
        }
        void maintain()throws Exception{service.maintain(service.now());}
        void kill(Entity entity)throws Exception{
            entity=registry.entity(entity.entityId());
            registry.setCombatTrusted(entity.entityId(),new Combat(0,200,0,1,0),entity.revision(),service.now());
        }
        Vector away(){return new Vector(origin.x()+150,origin.y(),origin.z());}
        long count(String fieldName)throws Exception{return field(fieldName).getLong(service);}
    }
    static void corpseAndRefill()throws Exception{
        Context c=new Context();Entity victim=c.walkers().get(0);String oldId=victim.entityId();
        Set<String> before=c.managed();c.time(1000,c.away());c.kill(victim);c.maintain();
        c.time(30000,c.away());c.maintain();check(c.registry.entity(oldId)!=null,"Corpse removed before 30 seconds");
        c.time(31200,c.away());c.maintain();check(c.registry.entity(oldId)==null,"Distant dead NPC not removed after 30 seconds");
        check(!c.managed().contains(oldId),"Deleted NPC remains in managed population");
        check(c.registry.snapshot().tombstones().stream().anyMatch(t->t.entityId().equals(oldId)),"Deletion must publish a tombstone");
        check(c.count("populationRefilled")==0,"Deletion must not immediately create a replacement");
        c.time(31300,c.away());c.maintain();
        c.time(46000,c.away());c.maintain();check(c.count("populationRefilled")==0,"Empty slot refilled before 15-second delay");
        c.time(46500,c.away());c.maintain();
        check(c.count("populationRefilled")==1,"One deleted walker needs exactly one replacement");
        Set<String> after=c.managed();after.removeAll(before);check(after.size()==1,"Replacement must use a fresh world ID");
        String replacement=after.iterator().next();check(!replacement.equals(oldId),"Old tombstone ID must never revive");
        check(c.registry.entity(replacement).components().combat().alive(),"Replacement must be alive");
        for(int n=0;n<5;n++){c.time(46600+n*10,c.away());c.maintain();}
        check(c.count("populationRefilled")==1&&c.managed().size()==24,"Repeated maintain duplicated the same spawn slot");
    }
    static void visibleCorpse()throws Exception{
        Context c=new Context();Entity victim=c.walkers().get(0);Vector near=victim.components().transform().position();
        c.time(1000,near);c.kill(victim);c.maintain();
        c.time(40000,near);c.maintain();check(c.registry.entity(victim.entityId())!=null,"Nearby corpse popped before max age");
        c.time(120000,near);c.maintain();check(c.registry.entity(victim.entityId())!=null,"Nearby corpse max age starts at observation");
        c.time(121200,near);c.maintain();check(c.registry.entity(victim.entityId())==null,"120-second corpse cap was not applied");
        c.time(121300,near);c.maintain();c.time(137000,near);c.maintain();
        check(c.count("populationRefilled")==0,"Replacement must not appear inside player exclusion radius");
    }
    static void boundedCleanup()throws Exception{
        Context c=new Context();List<Entity> victims=c.walkers();check(victims.size()==8,"Walker fixture count");
        c.time(1000,c.away());for(Entity victim:victims)c.kill(victim);c.maintain();
        c.time(31200,c.away());c.maintain();check(c.count("populationRemoved")==4,"One maintenance tick exceeds four removals");
        check(victims.stream().filter(e->c.registry.entity(e.entityId())!=null).count()==4,"First tick must retain remaining corpses");
        c.time(31400,c.away());c.maintain();check(c.count("populationRemoved")==8,"Later tick must drain remaining corpse work");
    }
    static void claimedCarAndCellRetirement()throws Exception{
        Context c=new Context();Entity car=c.traffic();String carId=car.entityId();Vector at=car.components().transform().position();
        c.time(1000,at);
        c.service.interaction(c.actor,map("type","interaction_request","world_epoch",c.service.epoch(),
            "request_id","claim-car","action","enter_vehicle","entity_id",carId,"seat","driver","expected_revision",car.revision()));
        car=c.registry.entity(carId);
        c.service.interaction(c.actor,map("type","interaction_request","world_epoch",c.service.epoch(),
            "request_id","leave-car","action","leave_vehicle","entity_id",carId,"expected_revision",car.revision()));
        car=c.registry.entity(carId);c.registry.setVehicleHealthTrusted(carId,-4000,0,car.revision(),c.service.now());
        c.maintain();c.time(201000,c.away());c.maintain();
        check(c.registry.entity(carId)!=null,"Claimed wreck must survive normal lifetime cleanup after player exits");
        Vector far=new Vector(c.origin.x()+2000,c.origin.y(),c.origin.z());c.time(202000,far);
        car=c.registry.entity(carId);c.registry.revokeOwnerTrusted(carId,car.revision(),c.service.now());
        for(String id:c.managed()){
            Entity entity=c.registry.entity(id);
            if(entity!=null && entity.ownerId()!=null)c.registry.revokeOwnerTrusted(id,entity.revision(),c.service.now());
        }
        Method retire=WorldService.class.getDeclaredMethod("retireDistantCell",Vector.class);retire.setAccessible(true);retire.invoke(c.service,far);
        check(c.registry.entity(carId)!=null,"Cell retirement must not delete a claimed car after owner lease is gone");
    }
    static void globalEntityBudget()throws Exception{
        Context c=new Context();Entity car=c.traffic();String driver=car.components().vehicle().seats().get("driver");
        c.time(1000,c.away());
        Entity driverEntity=c.registry.entity(driver);c.registry.deleteTrusted(driver,driverEntity.revision(),c.service.now());
        car=c.registry.entity(car.entityId());c.registry.deleteTrusted(car.entityId(),car.revision(),c.service.now());
        c.maintain();
        while(c.registry.snapshot().entities().size()<255)c.registry.createTrusted(Kind.PED,0xc99f21c4L,null,
            Components.ped(Transform.at(c.away(),0),new PedView(null,Actions.idle(),UNARMED,false,null),new Combat(200,200,0,0,0)),null,0,c.service.now());
        c.time(17200,c.away());c.maintain();
        check(c.registry.snapshot().entities().size()==255,"Refill may not create half a traffic pair or exceed 256 entities");
        check(c.count("populationRefilled")==0,"One free entity cannot admit car-and-driver refill");
        Entity unrelated=c.registry.snapshot().entities().stream().filter(e->e.playerId()==null && e.kind()==Kind.PED)
            .filter(e->{try{return !c.managed().contains(e.entityId());}catch(Exception x){throw new RuntimeException(x);}}).findFirst().orElseThrow();
        c.registry.deleteTrusted(unrelated.entityId(),unrelated.revision(),c.service.now());
        c.time(17400,c.away());c.maintain();
        check(c.registry.snapshot().entities().size()==256&&c.count("populationRefilled")==2,"Two free slots must admit one complete traffic pair");
    }
    static void occupiedPassenger()throws Exception{
        Context c=new Context();Entity car=c.traffic();String carId=car.entityId();Vector at=car.components().transform().position();
        c.time(1000,at);
        c.service.interaction(c.actor,map("type","interaction_request","world_epoch",c.service.epoch(),
            "request_id","passenger-enter","action","enter_vehicle","entity_id",carId,"seat","passenger:0","expected_revision",car.revision()));
        car=c.registry.entity(carId);c.registry.setVehicleHealthTrusted(carId,-4000,0,car.revision(),c.service.now());
        c.maintain();c.time(201000,at);c.maintain();
        car=c.registry.entity(carId);check(car!=null,"Occupied passenger car must survive vehicle hard cap");
        check(c.registry.playerEntity(c.actor).entityId().equals(car.components().vehicle().seats().get("passenger:0")),
            "Lifecycle cleanup must preserve reciprocal player passenger seat");
        c.service.interaction(c.actor,map("type","interaction_request","world_epoch",c.service.epoch(),
            "request_id","passenger-leave","action","leave_vehicle","entity_id",carId,"expected_revision",car.revision()));
        c.time(202000,c.away());c.maintain();
        check(c.registry.entity(carId)!=null,"Leaving protected car must restart normal abandonment grace");
        c.time(263000,c.away());c.maintain();
        check(c.registry.entity(carId)==null,"Unclaimed wreck should clean up after passenger leaves and new grace expires");
    }
    public static void main(String[] args)throws Exception{
        switch(args[0]){
            case "refill":corpseAndRefill();break;
            case "visible":visibleCorpse();break;
            case "bounded":boundedCleanup();break;
            case "claimed":claimedCarAndCellRetirement();break;
            case "budget":globalEntityBudget();break;
            case "passenger":occupiedPassenger();break;
            default:throw new AssertionError("Unknown scenario");
        }
        System.out.println("PopulationLifecycleHarness OK "+args[0]);
    }
}
'''


class PopulationLifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which(JAVAC) or not shutil.which(JAVA):
            raise unittest.SkipTest("需要 JDK 17 或更新版本")
        cls.temporary = tempfile.TemporaryDirectory(prefix="gta-population-lifecycle-")
        cls.directory = Path(cls.temporary.name)
        harness = cls.directory / "PopulationLifecycleHarness.java"
        harness.write_text(HARNESS, encoding="utf-8")
        sources = sorted((ROOT / "server/src/main/java").rglob("*.java"))
        result = subprocess.run([JAVAC, "--release", "17", "-encoding", "UTF-8", "-d", str(cls.directory),
                                 *map(str, sources), str(harness)], capture_output=True, text=True, encoding="utf-8", timeout=45)
        if result.returncode:
            cls.temporary.cleanup()
            raise AssertionError("完整服务生命周期夹具编译失败：\n" + result.stdout + result.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def scenario(self, name):
        result = subprocess.run([JAVA, "-ea", "-cp", str(self.directory), "offline.multiplayer.PopulationLifecycleHarness", name],
                                capture_output=True, text=True, encoding="utf-8", timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PopulationLifecycleHarness OK " + name, result.stdout)

    def test_dead_walker_is_replaced_once_after_cleanup_and_delay(self): self.scenario("refill")
    def test_nearby_corpse_has_hard_cap_but_refill_cannot_pop_near_player(self): self.scenario("visible")
    def test_lifecycle_cleanup_per_tick_is_bounded(self): self.scenario("bounded")
    def test_claimed_car_survives_cleanup_and_cell_retirement_after_exit(self): self.scenario("claimed")
    def test_global_entity_limit_reserves_complete_traffic_pair(self): self.scenario("budget")
    def test_unclaimed_car_preserves_player_passenger_until_exit(self): self.scenario("passenger")


if __name__ == "__main__":
    unittest.main()
