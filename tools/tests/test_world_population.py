#!/usr/bin/env python3
"""Verify shared NPC cleanup/refill policy from confirmed entity snapshots, without game resources."""
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
import java.util.*;
import offline.multiplayer.WorldRegistry.*;
import offline.multiplayer.WorldRegistry.Vector;
import offline.multiplayer.WorldPopulation.*;

public final class WorldPopulationHarness {
    static final Vector ORIGIN = new Vector(0,0,20), FAR = new Vector(50,0,20);
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    static Slot slot(String cell,int index,Type type){return new Slot(cell,index,type,ORIGIN);}
    static Entity ped(String id,boolean alive){return ped(id,alive,null,ORIGIN,null,1);}
    static Entity ped(String id,boolean alive,String player,Vector at,Attachment attachment,long generation){
        return new Entity(id,Kind.PED,0xc99f21c4L,player,7,generation,"simulator",3,1_000_000,1,
            new Components(Transform.at(at,0),new PedView(null,Actions.idle(),0xa2719263L,false,null),null,null,
                new Combat(alive?200:0,200,0,alive?0:1,0),attachment));
    }
    static Entity car(String id,String driver,double health){
        Map<String,String> seats=new LinkedHashMap<>();seats.put("driver",driver);seats.put("passenger:0",null);
        return carSeats(id,seats,health);
    }
    static Entity carSeats(String id,Map<String,String> seats,double health){
        return new Entity(id,Kind.VEHICLE,0xeb70965fL,null,11,2,"simulator",3,1_000_000,1,
            Components.vehicle(Transform.at(ORIGIN,0),new Vehicle(health,1000,seats,new VehicleView(true,false))));
    }
    static Plan tick(WorldPopulation p,long time,List<Entity> world,Vector...players){
        return p.tick(time,world,List.of(players),Set.of(),256);
    }
    static void corpseGrace(){
        WorldPopulation p=new WorldPopulation();Slot slot=slot("0:0",0,Type.WALKER);p.register(slot,List.of("npc"));
        Entity dead=ped("npc",false);
        check(tick(p,100,List.of(dead),FAR).removals().isEmpty(),"Death must not instantly despawn");
        check(tick(p,30099,List.of(dead),FAR).removals().isEmpty(),"Retain corpse for full 30 seconds");
        Plan plan=tick(p,30100,List.of(dead),FAR);
        check(plan.removals().size()==1&&plan.spawns().isEmpty(),"Distant corpse retires before refill");
        Removal r=plan.removals().get(0);
        check(r.entityId().equals("npc")&&r.slotKey().equals(slot.key())&&r.generation()==1&&r.revision()==7,
            "Removal fences exact current entity identity");
        check(r.reason().equals("dead_npc"),"Corpse removal identifies cause");
        boolean immutable=false;try{plan.removals().clear();}catch(UnsupportedOperationException expected){immutable=true;}
        check(immutable,"Caller cannot mutate returned plan");
    }
    static void visibleCorpseAndGeneration(){
        WorldPopulation p=new WorldPopulation();p.register(slot("0:0",0,Type.WALKER),List.of("npc"));
        Entity dead=ped("npc",false);
        tick(p,0,List.of(dead),ORIGIN);
        check(tick(p,30000,List.of(dead),new Vector(40,0,20)).removals().isEmpty(),"Exactly 40m remains visible");
        check(tick(p,119999,List.of(dead),ORIGIN).removals().isEmpty(),"Nearby corpse retained until hard deadline");
        check(tick(p,120000,List.of(dead),ORIGIN).removals().size()==1,"Hard 120s cap prevents corpse accumulation");
        Entity revived=ped("npc",true);tick(p,120001,List.of(revived),FAR);
        check(tick(p,120002,List.of(dead),FAR).removals().isEmpty(),"Revival resets old death clock");
        Entity nextGeneration=ped("npc",false,null,ORIGIN,null,2);
        check(tick(p,150001,List.of(nextGeneration),FAR).removals().isEmpty(),"New generation never inherits old death clock");
        check(tick(p,180001,List.of(nextGeneration),FAR).removals().get(0).generation()==2,"New generation receives own grace");
    }
    static void refillDelayAndSafety(){
        WorldPopulation p=new WorldPopulation();Slot slot=slot("0:0",0,Type.WALKER);p.register(slot,List.of("npc"));
        Entity dead=ped("npc",false);tick(p,0,List.of(dead),FAR);tick(p,30000,List.of(dead),FAR);
        check(tick(p,30001,List.of(),FAR).spawns().isEmpty(),"Start vacancy clock only after confirmed deletion");
        check(tick(p,45000,List.of(),FAR).spawns().isEmpty(),"Vacancy gets full 15s delay");
        check(tick(p,45001,List.of(),ORIGIN).spawns().isEmpty(),"No replacement on top of a player");
        check(tick(p,45002,List.of(),new Vector(401,0,20)).spawns().isEmpty(),"No filling abandoned distant cells");
        check(tick(p,45003,List.of()).spawns().isEmpty(),"No filling a room with no active players");
        Plan plan=tick(p,45004,List.of(),new Vector(20,0,20));
        check(plan.spawns().size()==1&&plan.spawns().get(0).entityCost()==1,"20m is safe refill boundary");
        check(plan.spawns().get(0).slotKey().equals(slot.key()),"Refill returns original stable slot");
        p.register(slot,List.of("replacement"));
        check(tick(p,45005,List.of(ped("replacement",true)),FAR).spawns().isEmpty(),"Successful registration consumes vacancy");
    }
    static void trafficCorpseAndCar(){
        WorldPopulation p=new WorldPopulation();Slot slot=slot("0:0",0,Type.TRAFFIC);p.register(slot,List.of("car","driver"));
        Entity driver=ped("driver",false,null,ORIGIN,new Attachment("car","driver"),1),car=car("car","driver",1000);
        tick(p,0,List.of(car,driver),FAR);
        Plan corpse=tick(p,30000,List.of(car,driver),FAR);
        check(corpse.removals().size()==1&&corpse.removals().get(0).entityId().equals("driver"),"Dead driver cleaned independently");
        car=car("car",null,1000);
        check(tick(p,59999,List.of(car),FAR).removals().isEmpty(),"Unoccupied car remains available to steal for 60s");
        Plan expired=tick(p,60000,List.of(car),FAR);
        check(expired.removals().size()==1&&expired.removals().get(0).entityId().equals("car"),"Abandoned car expires after minimum");
        tick(p,60001,List.of(),FAR);
        Plan refill=tick(p,75001,List.of(),FAR);
        check(refill.spawns().size()==1&&refill.spawns().get(0).entityCost()==2,"Traffic slot atomically budgets car and driver");
    }
    static void playerVehicleProtection(){
        WorldPopulation p=new WorldPopulation();p.register(slot("0:0",0,Type.TRAFFIC),List.of("car","driver"));
        Entity dead=ped("driver",false),wreck=car("car",null,-4000);
        tick(p,0,List.of(wreck,dead),FAR);
        Plan claimed=p.tick(180000,List.of(wreck,dead),List.of(FAR),Set.of("car"),256);
        check(claimed.removals().stream().noneMatch(r->r.entityId().equals("car")),"Claimed wreck protected even past maximum");
        Entity player=ped("player",true,"p1",ORIGIN,new Attachment("car","passenger:0"),1);
        Map<String,String> seats=new LinkedHashMap<>();seats.put("driver",null);seats.put("passenger:0","player");
        Plan occupied=tick(p,400000,List.of(carSeats("car",seats,-4000),player),FAR);
        check(occupied.removals().isEmpty()&&occupied.spawns().isEmpty(),"Player passenger prevents cleanup and duplicate traffic");
        Entity reverseOnly=car("car",null,-4000);
        check(tick(p,600000,List.of(reverseOnly,player),FAR).removals().isEmpty(),"Reverse player attachment also protects car");
        check(tick(p,600001,List.of(reverseOnly),FAR).removals().isEmpty(),"Protection resets abandoned timer");
        check(tick(p,660001,List.of(reverseOnly),FAR).removals().size()==1,"Normal grace applies after player leaves");
    }
    static void trafficTimerResetAndHardCap(){
        WorldPopulation p=new WorldPopulation();p.register(slot("0:0",0,Type.TRAFFIC),List.of("car","driver"));
        Entity car=car("car",null,1000);tick(p,0,List.of(car),ORIGIN);
        check(tick(p,60000,List.of(car),ORIGIN).removals().isEmpty(),"Visible abandoned car remains through grace");
        check(tick(p,179999,List.of(car),ORIGIN).removals().isEmpty(),"Visible car remains before max age");
        check(tick(p,180000,List.of(car),ORIGIN).removals().size()==1,"Abandoned car hard cap");
        Entity driver=ped("driver",true,null,ORIGIN,new Attachment("car","driver"),1);
        car=car("car","driver",1000);
        check(tick(p,180001,List.of(car,driver),FAR).removals().isEmpty(),"Working NPC traffic is never considered abandoned");
        car=car("car",null,1000);
        check(tick(p,180002,List.of(car),FAR).removals().isEmpty(),"Returning driver reset old abandonment age");
        check(tick(p,240002,List.of(car),FAR).removals().size()==1,"New abandonment expires normally despite simulation owner");
    }
    static void orphanedDriver(){
        WorldPopulation p=new WorldPopulation();p.register(slot("0:0",0,Type.TRAFFIC),List.of("car","driver"));
        Entity driver=ped("driver",true);tick(p,0,List.of(driver),FAR);
        check(tick(p,59999,List.of(driver),FAR).removals().isEmpty(),"Living orphan driver receives full grace");
        Plan plan=tick(p,60000,List.of(driver),FAR);
        check(plan.removals().size()==1&&plan.removals().get(0).reason().equals("orphaned_traffic_npc"),
            "Destroyed traffic cannot leave a permanent unfillable driver slot");
        tick(p,60001,List.of(),FAR);
        check(tick(p,75001,List.of(),FAR).spawns().get(0).entityCost()==2,"Orphan cleanup permits complete traffic refill");
    }
    static void budgetAndRetry(){
        WorldPopulation p=new WorldPopulation();List<Entity> dead=new ArrayList<>();
        for(int n=0;n<6;n++){String id="npc"+n;p.register(slot("0:0",n,Type.WALKER),List.of(id));dead.add(ped(id,false));}
        tick(p,0,dead,FAR);Plan first=tick(p,30000,dead,FAR);
        check(first.removals().size()==4&&first.mutationCost()==4,"At most four removal entity changes per plan");
        check(tick(p,30001,dead,FAR).removals().equals(first.removals()),"Uncommitted removals retry with stable fencing");
        List<Entity> remaining=dead.stream().filter(e->first.removals().stream().noneMatch(r->r.entityId().equals(e.entityId()))).toList();
        check(tick(p,30002,remaining,FAR).removals().size()==2,"Committed removals allow later candidates");
        WorldPopulation spawn=new WorldPopulation();
        for(int n=0;n<3;n++)spawn.register(slot("0:0",n,Type.TRAFFIC),List.of());
        tick(spawn,0,List.of(),FAR);
        check(tick(spawn,15000,List.of(),FAR).mutationCost()==4,"Two complete traffic pairs fit four-entity work budget");
        check(spawn.tick(15001,List.of(ped("existing",true)),List.of(FAR),Set.of(),2).spawns().isEmpty(),
            "One free entity cannot create a partial traffic pair");
        check(spawn.tick(15002,List.of(ped("existing",true)),List.of(FAR),Set.of(),3).spawns().size()==1,
            "Registry entity budget limits even when mutation budget remains");
    }
    static void multiPlayerAndForget(){
        WorldPopulation p=new WorldPopulation();Slot a=slot("0:0",0,Type.WALKER),b=slot("1:0",0,Type.WALKER);
        p.register(a,List.of("a"));p.register(b,List.of("b"));
        List<Entity> entities=List.of(ped("a",false),ped("b",false));tick(p,0,entities,FAR,ORIGIN);
        check(tick(p,30000,entities,FAR,ORIGIN).removals().isEmpty(),"Any nearby player prevents normal corpse retirement");
        p.forgetCell("0:0");
        check(p.slots().equals(List.of(b)),"Forgetting a cell leaves other registrations intact");
        check(tick(p,120000,entities,ORIGIN).removals().stream().allMatch(r->r.entityId().equals("b")),"Forgotten cells never produce deletion");
        boolean duplicate=false;try{p.register(slot("2:0",0,Type.WALKER),List.of("b"));}catch(IllegalArgumentException expected){duplicate=true;}
        check(duplicate,"An entity cannot occupy two refill slots");
        boolean backwards=false;try{tick(p,119999,entities,FAR);}catch(IllegalArgumentException expected){backwards=true;}
        check(backwards,"Policy rejects backwards clock");
    }
    static void actualRegistryIds() throws Exception {
        long model=0xc99f21c4L,weapon=0xa2719263L;
        WorldRegistry registry=new WorldRegistry("e45b8460-df31-4c93-b642-b6042637486d",
            Map.of(Kind.PED,Set.of(model)),Set.of(weapon));
        Entity actual=registry.createTrusted(Kind.PED,model,null,
            Components.ped(Transform.at(ORIGIN,0),new PedView(null,Actions.idle(),weapon,false,null),
                new Combat(200,200,0,0,0)),null,0,1).entities().get(0);
        check(actual.entityId().startsWith("w:")&&actual.entityId().split(":").length==3,
            "Fixture must use actual colon-separated Registry ID");
        WorldPopulation population=new WorldPopulation();Slot slot=slot("-3:9",0,Type.WALKER);
        population.register(slot,List.of(actual.entityId()));
        check(tick(population,1,registry.snapshot().entities(),FAR).spawns().isEmpty(),
            "Actual Registry entity occupies registered slot");
        registry.deleteTrusted(actual.entityId(),actual.revision(),2);
        tick(population,2,registry.snapshot().entities(),FAR);
        check(tick(population,15002,registry.snapshot().entities(),FAR).spawns().size()==1,
            "Actual Registry deletion leads to refill after delay");
    }
    public static void main(String[] args) throws Exception {
        switch(args[0]){
            case "corpse":corpseGrace();break;
            case "generation":visibleCorpseAndGeneration();break;
            case "refill":refillDelayAndSafety();break;
            case "traffic":trafficCorpseAndCar();break;
            case "protection":playerVehicleProtection();break;
            case "vehicle_clock":trafficTimerResetAndHardCap();break;
            case "orphan":orphanedDriver();break;
            case "budget":budgetAndRetry();break;
            case "multi_player":multiPlayerAndForget();break;
            case "registry_ids":actualRegistryIds();break;
            default:throw new AssertionError("Unknown scenario");
        }
        System.out.println("WorldPopulationHarness OK "+args[0]);
    }
}
'''


class WorldPopulationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which(JAVAC) or not shutil.which(JAVA):
            raise unittest.SkipTest("需要 JDK 17 或更新版本")
        cls.temporary = tempfile.TemporaryDirectory(prefix="gta-world-population-")
        cls.directory = Path(cls.temporary.name)
        harness = cls.directory / "WorldPopulationHarness.java"
        harness.write_text(HARNESS, encoding="utf-8")
        source = ROOT / "server/src/main/java/offline/multiplayer"
        result = subprocess.run([JAVAC, "--release", "17", "-encoding", "UTF-8", "-d", str(cls.directory),
                                 str(source / "WorldRegistry.java"), str(source / "WorldPopulation.java"), str(harness)],
                                capture_output=True, text=True, encoding="utf-8", timeout=30)
        if result.returncode:
            cls.temporary.cleanup()
            raise AssertionError("人口策略夹具编译失败：\n" + result.stdout + result.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def scenario(self, name):
        result = subprocess.run([JAVA, "-ea", "-cp", str(self.directory), "offline.multiplayer.WorldPopulationHarness", name],
                                capture_output=True, text=True, encoding="utf-8", timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("WorldPopulationHarness OK " + name, result.stdout)

    def test_dead_npc_minimum_and_fenced_cleanup(self): self.scenario("corpse")
    def test_visible_corpse_hard_cap_and_generation_reset(self): self.scenario("generation")
    def test_refill_waits_for_deletion_delay_and_safe_player_distance(self): self.scenario("refill")
    def test_dead_driver_leaves_stealable_car_before_complete_refill(self): self.scenario("traffic")
    def test_claimed_and_player_occupied_vehicles_always_survive(self): self.scenario("protection")
    def test_abandonment_reset_and_hard_cap(self): self.scenario("vehicle_clock")
    def test_destroyed_vehicle_does_not_leave_permanent_driver_slot(self): self.scenario("orphan")
    def test_entity_and_per_tick_budgets_and_uncommitted_retry(self): self.scenario("budget")
    def test_every_player_matters_and_retired_cells_are_forgotten(self): self.scenario("multi_player")
    def test_accepts_actual_registry_ids_and_observes_registry_deletion(self): self.scenario("registry_ids")


if __name__ == "__main__":
    unittest.main()
