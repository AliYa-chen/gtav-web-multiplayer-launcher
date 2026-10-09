#!/usr/bin/env python3
"""Check population lease handoff against confirmed positions without a game runtime."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
JAVA = os.environ.get("JAVA", shutil.which("java") or "java")
JAVAC = os.environ.get("JAVAC", shutil.which("javac") or "javac")

HARNESS = r'''
package offline.multiplayer;
import java.util.*;
import offline.multiplayer.WorldRegistry.*;
import offline.multiplayer.WorldRegistry.Vector;

public final class WorldOwnershipHarness {
    static final long NOW=1000, UNTIL=10000;
    static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
    static Entity ped(String id,String player,String owner,double x){
        return new Entity(id,Kind.PED,0xc99f21c4L,player,1,1,owner,1,owner==null?0:UNTIL,-1,
            Components.ped(Transform.at(new Vector(x,0,22),90),new PedView(null,Actions.idle(),0xa2719263L,false,null),new Combat(200,200,0,0,0)));
    }
    static Entity player(String id,double x){return ped("player-"+id,id,id,x);}
    static Entity state(Entity e,String owner,long until,int health){
        Components c=e.components();
        return new Entity(e.entityId(),e.kind(),e.model(),e.playerId(),e.revision()+1,e.generation(),owner,e.ownerEpoch(),until,-1,
            new Components(c.transform(),c.ped(),c.vehicle(),c.object(),c.combat()==null?null:new Combat(health,200,0,0,0),c.attachment()));
    }
    static Entity attach(Entity e,String car,String seat){
        Components c=e.components();
        return new Entity(e.entityId(),e.kind(),e.model(),e.playerId(),e.revision()+1,e.generation(),e.ownerId(),e.ownerEpoch(),e.leaseUntilTick(),-1,
            new Components(c.transform(),c.ped(),c.vehicle(),c.object(),c.combat(),new Attachment(car,seat)));
    }
    static Entity car(String id,String owner,double x,Entity driver,Entity passenger){
        Map<String,String> seats=new LinkedHashMap<>();seats.put("driver",driver==null?null:driver.entityId());
        seats.put("passenger:0",passenger==null?null:passenger.entityId());seats.put("passenger:1",null);
        return new Entity(id,Kind.VEHICLE,0xeb70965fL,null,1,1,owner,1,owner==null?0:UNTIL,-1,
            Components.vehicle(Transform.at(new Vector(x,0,22),90),new Vehicle(1000,1000,seats,new VehicleView(true,false))));
    }
    static List<WorldOwnership.Decision> decide(List<Entity> entities,Set<String> ids,Set<String> participants){
        return WorldOwnership.decide(NOW,entities,ids,participants,Map.of());
    }
    static WorldOwnership.Decision single(List<WorldOwnership.Decision> decisions,String owner,String... ids){
        check(decisions.size()==1,"Expected one whole-group decision: "+decisions);
        WorldOwnership.Decision decision=decisions.get(0);
        check(Objects.equals(decision.ownerId(),owner),"Unexpected owner: "+decision);
        check(new HashSet<>(decision.entityIds()).equals(Set.of(ids)),"Group membership: "+decision);
        return decision;
    }
    static void currentPosition(){
        Entity walker=ped("walker",null,"a",800);
        single(decide(List.of(player("a",0),player("b",810),walker),Set.of("walker"),Set.of("a","b")),"b","walker");
        single(decide(List.of(player("a",0),player("b",810),state(walker,null,0,200)),Set.of("walker"),Set.of("a","b")),"b","walker");
        // A following player keeps a chase moving even after leaving the original cell by 1 km.
        check(decide(List.of(player("a",1000),player("b",0),ped("chase",null,"a",1000)),Set.of("chase"),Set.of("a","b")).isEmpty(),"Following owner must retain chase");
    }
    static void hysteresis(){
        Entity walker=ped("walker",null,"a",0);
        for(double distance:new double[]{300,350,399.99,400})
            check(decide(List.of(player("a",distance),player("b",0),walker),Set.of("walker"),Set.of("a","b")).isEmpty(),"Closer player must not steal valid owner at "+distance);
        single(decide(List.of(player("a",400.01),player("b",0),walker),Set.of("walker"),Set.of("a","b")),"b","walker");
        Entity unowned=state(walker,null,0,200);
        check(decide(List.of(player("a",300.01),unowned),Set.of("walker"),Set.of("a")).isEmpty(),"New ownership exceeds enter radius");
        single(decide(List.of(player("a",300),unowned),Set.of("walker"),Set.of("a")),"a","walker");
    }
    static void eligibility(){
        Entity walker=ped("walker",null,"a",0),a=player("a",0),b=player("b",10);
        single(decide(List.of(a,b,walker),Set.of("walker"),Set.of("b")),"b","walker");
        single(decide(List.of(state(a,"a",NOW,200),b,walker),Set.of("walker"),Set.of("a","b")),"b","walker");
        single(decide(List.of(state(a,"other",UNTIL,200),b,walker),Set.of("walker"),Set.of("a","b")),"b","walker");
        single(decide(List.of(state(a,"a",UNTIL,0),b,walker),Set.of("walker"),Set.of("a","b")),"b","walker");
        single(decide(List.of(a,state(walker,"a",NOW,200)),Set.of("walker"),Set.of("a")),"a","walker");
        single(decide(List.of(a,walker),Set.of("walker"),Set.of()),null,"walker");
        single(decide(List.of(a,state(walker,"a",UNTIL,0)),Set.of("walker"),Set.of("a")),null,"walker");
    }
    static void offers(){
        Entity walker=ped("walker",null,"a",0);List<Entity> world=List.of(player("a",0),player("b",10),walker);
        Map<String,WorldOwnership.PendingOffer> pending=Map.of("walker",new WorldOwnership.PendingOffer("a",6000));
        for(int tick=1000;tick<1100;tick++)check(WorldOwnership.decide(tick,world,Set.of("walker"),Set.of("a","b"),pending).isEmpty(),"Pending readiness must not reissue or switch every tick");
        single(WorldOwnership.decide(NOW,world,Set.of("walker"),Set.of("a","b"),Map.of("walker",new WorldOwnership.PendingOffer("b",6000))),"a","walker");
        single(WorldOwnership.decide(NOW,world,Set.of("walker"),Set.of("a","b"),Map.of("walker",new WorldOwnership.PendingOffer("a",NOW))),"a","walker");
        single(WorldOwnership.decide(NOW,world,Set.of("walker"),Set.of("b"),pending),"b","walker");
    }
    static void vehicleGroup(){
        Entity driver=attach(ped("driver",null,"a",0),"car","driver");
        Entity passenger=attach(ped("passenger",null,"a",0),"car","passenger:0");
        Entity car=car("car","a",700,driver,passenger);
        List<Entity> world=List.of(player("a",0),player("b",710),driver,passenger,car);
        var expected=single(decide(world,Set.of("car","driver","passenger"),Set.of("a","b")),"b","car","driver","passenger");
        check(expected.anchorId().equals("car"),"Passenger stale position must not anchor a moving car");
        for(int i=0;i<20;i++){
            List<Entity> shuffled=new ArrayList<>(world);Collections.shuffle(shuffled,new Random(i));
            check(decide(shuffled,Set.of("passenger","car","driver"),Set.of("b","a")).equals(List.of(expected)),"Input order changes grouped handoff");
        }
        // A single expired member must join the car's owner without stealing the group.
        Entity expired=state(passenger,"a",NOW,200);
        single(decide(List.of(player("a",700),player("b",710),driver,expired,car),Set.of("car","driver","passenger"),Set.of("a","b")),"a","car","driver","passenger");
        // Empty seats and unmanaged vehicle attachments are deliberately safe.
        check(decide(List.of(player("a",0),driver,car),Set.of("driver"),Set.of("a")).isEmpty(),"Must not steal another subsystem's attached NPC");
        single(decide(List.of(player("b",710),car("empty",null,700,null,null)),Set.of("empty"),Set.of("b")),"b","empty");
    }
    static void playerDriver(){
        Entity driver=attach(player("b",700),"car","driver");
        Entity passenger=attach(ped("passenger",null,"a",700),"car","passenger:0");
        Entity car=car("car","a",700,driver,passenger);
        single(decide(List.of(player("a",700),driver,passenger,car),Set.of("car","passenger",driver.entityId()),Set.of("a","b")),"b","car","passenger");
        single(decide(List.of(player("a",700),driver,passenger,car),Set.of("car","passenger"),Set.of("a")),null,"car","passenger");
        Entity readyCar=state(car,"b",UNTIL,200),readyPassenger=state(passenger,"b",UNTIL,200);
        check(decide(List.of(player("a",700),driver,readyPassenger,readyCar),Set.of("car","passenger"),Set.of("a","b")).isEmpty(),"Player driving must retain car and associated NPC");
    }
    static void movingCrowd(){
        List<Entity> world=new ArrayList<>(List.of(player("a",0),player("b",800)));
        Set<String> ids=new HashSet<>();
        for(int i=0;i<32;i++){String id="npc-"+i;ids.add(id);world.add(ped(id,null,"a",780+i));}
        List<WorldOwnership.Decision> decisions=decide(world,ids,Set.of("a","b"));
        check(decisions.size()==32,"Every moving crowd member receives the nearby active simulator");
        for(var decision:decisions)check(decision.ownerId().equals("b")&&decision.entityIds().size()==1,"Invalid crowd handoff");
        boolean immutable=false;try{decisions.clear();}catch(UnsupportedOperationException expected){immutable=true;}
        check(immutable,"Decision list must be immutable");
        immutable=false;try{decisions.get(0).entityIds().clear();}catch(UnsupportedOperationException expected){immutable=true;}
        check(immutable,"Group members must be immutable");
    }
    public static void main(String[] args){
        switch(args[0]){
            case "position" -> currentPosition();case "hysteresis" -> hysteresis();case "eligibility" -> eligibility();
            case "offers" -> offers();case "vehicle" -> vehicleGroup();case "driver" -> playerDriver();case "crowd" -> movingCrowd();
            default -> throw new IllegalArgumentException(args[0]);
        }
        System.out.println("OK "+args[0]);
    }
}
'''


class WorldOwnershipTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="gta-world-ownership-")
        cls.classes = Path(cls.temporary.name)
        fixture = cls.classes / "WorldOwnershipHarness.java"
        fixture.write_text(HARNESS, encoding="utf-8")
        source = ROOT / "server/src/main/java/offline/multiplayer"
        result = subprocess.run([JAVAC, "--release", "17", "-encoding", "UTF-8", "-d", str(cls.classes),
            str(source / "WorldRegistry.java"), str(source / "WorldOwnership.java"), str(fixture)],
            capture_output=True, text=True, timeout=30)
        if result.returncode:
            cls.temporary.cleanup()
            raise AssertionError(result.stdout + result.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def scenario(self, name):
        result = subprocess.run([JAVA, "-ea", "-cp", str(self.classes), "offline.multiplayer.WorldOwnershipHarness", name],
            capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("OK " + name, result.stdout)

    def test_actual_position_and_following_chase(self):
        self.scenario("position")

    def test_stable_distance_hysteresis(self):
        self.scenario("hysteresis")

    def test_disconnect_dead_player_and_expired_leases(self):
        self.scenario("eligibility")

    def test_pending_offers_do_not_churn(self):
        self.scenario("offers")

    def test_vehicle_and_npc_occupants_migrate_together(self):
        self.scenario("vehicle")

    def test_player_driver_priority_preserves_control(self):
        self.scenario("driver")

    def test_moving_crowd_has_stable_immutable_decisions(self):
        self.scenario("crowd")


if __name__ == "__main__":
    unittest.main()
