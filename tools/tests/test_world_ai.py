#!/usr/bin/env python3
"""Verify server NPC plans and target/lease fencing without starting a GTA engine."""
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
import java.io.*;
import java.nio.file.*;
import java.util.*;
import offline.multiplayer.WorldRegistry.*;
import offline.multiplayer.WorldRegistry.Vector;

public final class WorldAiHarness {
    static final long PISTOL=WorldLaw.POLICE_WEAPON, UNARMED=0xa2719263L;
    static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
    static Entity ped(String id,String player,long weapon,double x,double y){
        return new Entity(id,Kind.PED,player==null?0xc99f21c4L:0x705e61f2L,player,1,1,"p1",1,100000,1,
            Components.ped(Transform.at(new Vector(x,y,22),90),new PedView(null,Actions.idle(),weapon,false,null),new Combat(200,200,0,0,0)));
    }
    static Entity at(Entity value,double x,double y){
        Components old=value.components();
        return new Entity(value.entityId(),value.kind(),value.model(),value.playerId(),value.revision()+1,
            value.generation(),value.ownerId(),value.ownerEpoch(),value.leaseUntilTick(),value.lastInputSequence(),
            new Components(Transform.at(new Vector(x,y,22),90),old.ped(),old.vehicle(),old.object(),old.combat(),old.attachment()));
    }
    static Entity identity(Entity e,long generation,String owner,long ownerEpoch,long lease){
        return new Entity(e.entityId(),e.kind(),e.model(),e.playerId(),e.revision()+1,generation,owner,
            ownerEpoch,lease,e.lastInputSequence(),e.components());
    }
    static Entity attach(Entity e,String vehicle,String seat){
        Components c=e.components();
        return new Entity(e.entityId(),e.kind(),e.model(),e.playerId(),e.revision()+1,e.generation(),e.ownerId(),e.ownerEpoch(),e.leaseUntilTick(),e.lastInputSequence(),
            new Components(c.transform(),c.ped(),c.vehicle(),c.object(),c.combat(),new Attachment(vehicle,seat)));
    }
    static Entity car(String id,Entity driver,Entity passenger){
        Map<String,String> seats=new LinkedHashMap<>();seats.put("driver",driver.entityId());
        seats.put("passenger:0",passenger==null?null:passenger.entityId());
        return new Entity(id,Kind.VEHICLE,0xeb70965fL,null,1,1,"p1",1,100000,1,
            Components.vehicle(driver.components().transform(),new Vehicle(1000,1000,seats,new VehicleView(true,false))));
    }
    static String action(WorldAi ai,String id){return (String)ai.taskForEntity(id).get("action");}
    static void ambientAndShot(){
        WorldAi ai=new WorldAi("ai");Entity player=ped("player","p1",PISTOL,0,0);
        Entity near=ped("near",null,UNARMED,5,0),far=ped("far",null,UNARMED,61,0);
        List<Entity> world=List.of(player,near,far);
        check(ai.tick(100,world,Set.of("p1"),null).size()==2,"Only NPCs receive tasks");
        check(ai.taskForEntity("player")==null,"Do not task a player ped");
        check(action(ai,"near").equals("wander"),"Initial ambient plan");
        check(ai.taskForEntity("near").get("target_entity_id")==null
            && ai.taskForEntity("near").get("target_generation")==null,"No target uses paired null identifiers for client schema");
        long revision=ai.revision();
        check(ai.tick(101,world,Set.of("p1"),null).isEmpty()&&revision==ai.revision(),"Unchanged world does not churn tasks");
        check(!ai.reportAcceptedShot(player,UNARMED,new Vector(0,0,22),102),"Weapon mismatch is not a threat");
        check(!ai.reportAcceptedShot(player,PISTOL,new Vector(10,0,22),103),"Detached shot origin is not a threat");
        check(ai.reportAcceptedShot(player,PISTOL,new Vector(0,0,22),104),"Accepted shot becomes server event");
        ai.tick(104,world,Set.of("p1"),null);
        check(action(ai,"near").equals("flee"),"Nearby civilian reacts to server shot");
        check(action(ai,"far").equals("wander"),"Hearing radius is bounded");
        @SuppressWarnings("unchecked") List<Double> destination=(List<Double>)ai.taskForEntity("near").get("destination");
        check(destination.get(0)>5&&destination.get(1)==0,"Flee destination points away from danger");
        check(!ai.authorizesShot(near,player,105),"Fleeing civilian cannot shoot");
        ai.tick(10104,world,Set.of("p1"),null);
        check(action(ai,"near").equals("wander"),"Threat expires on server time");
        ai.tick(10105,world,Set.of(),null);
        check(action(ai,"near").equals("idle"),"Inactive simulator freezes plans");
        boolean immutable=false;try{ai.taskForEntity("near").put("action","combat");}catch(UnsupportedOperationException expected){immutable=true;}
        check(immutable,"Task snapshots cannot mutate decisions");
        ai.tick(10106,List.of(player),Set.of("p1"),null);
        check(ai.taskForEntity("near")==null&&ai.taskForEntity("far")==null,"Deleted NPC decisions are removed");
    }
    static void retaliationFencing(){
        WorldAi ai=new WorldAi("self-defence");Entity player=ped("player","p1",PISTOL,0,0);
        Entity guard=ped("guard",null,PISTOL,10,0),other=ped("other",null,UNARMED,20,0);
        List<Entity> world=List.of(player,guard,other);
        ai.tick(1,world,Set.of("p1"),null);ai.reportAcceptedShot(player,PISTOL,new Vector(0,0,22),2);
        ai.tick(2,world,Set.of("p1"),null);
        check(action(ai,"guard").equals("flee"),"Gun ownership alone does not authorize random aggression");
        check(ai.reportAcceptedDamage(player,guard,10,3),"Committed damage records direct attacker");
        ai.tick(3,world,Set.of("p1"),null);
        check(action(ai,"guard").equals("combat")&&ai.authorizesShot(guard,player,4),"Armed victim targets its actual attacker");
        check(ai.taskForEntity("guard").get("target_generation").equals(player.generation()),"Targeted task retains exact generation");
        check(!ai.authorizesShot(guard,other,4),"Cannot substitute an unrelated target");
        check(!ai.authorizesShot(identity(guard,2,"p1",1,100000),player,4),"Old task cannot control a new actor generation");
        check(!ai.authorizesShot(identity(guard,1,"p1",2,100000),player,4),"Old task cannot survive owner epoch transition");
        check(!ai.authorizesShot(guard,identity(player,2,"p1",1,100000),4),"Old target generation cannot be shot");
        check(!ai.authorizesShot(guard,at(player,100,0),4),"Confirmed positions bound firing range");
        Entity unleased=identity(guard,1,null,2,0);
        check(!ai.authorizesShot(unleased,player,4),"Unleased NPC cannot fire");
        ai.tick(5,List.of(player,unleased,other),Set.of("p1"),null);
        check(action(ai,"guard").equals("idle"),"Lease loss retires active attack");
        Entity respawn=identity(player,2,"p1",1,100000);
        ai.tick(6,List.of(respawn,guard,other),Set.of("p1"),null);
        check(action(ai,"guard").equals("wander"),"Respawn invalidates old attacker memory");
    }
    static void driversAndDegenerateGeometry(){
        WorldAi ai=new WorldAi("traffic");Entity player=ped("player","p1",PISTOL,0,0);
        Entity driver=attach(ped("driver",null,UNARMED,0,0),"car","driver");
        Entity passenger=attach(ped("passenger",null,UNARMED,0,0),"car","passenger:0");
        Entity car=car("car",driver,passenger);List<Entity> world=List.of(player,driver,passenger,car);
        ai.tick(1,world,Set.of("p1"),null);
        check(action(ai,"driver").equals("idle")&&"road_unavailable".equals(ai.taskForEntity("driver").get("reason")),
            "Without road data the driver freezes instead of local DriveWander");
        check(action(ai,"passenger").equals("idle"),"Passenger does not run competing driver task");
        ai.reportAcceptedShot(player,PISTOL,new Vector(0,0,22),2);ai.tick(2,world,Set.of("p1"),null);
        check(action(ai,"driver").equals("idle")&&ai.taskForEntity("driver").get("destination")==null,
            "Coincident threat cannot bypass missing server road data");
        ai.tick(3,List.of(player,driver,passenger,identity(car,1,"p2",2,100000)),Set.of("p1"),null);
        check(action(ai,"driver").equals("idle"),"Another vehicle owner cannot be commandeered");
    }
    static void policePlan()throws Exception{
        WorldAi ai=new WorldAi("police");WorldLaw law=new WorldLaw("police");
        Entity player=ped("player","p1",PISTOL,711.5,-1088.08);
        check(law.reportAcceptedShot(player,PISTOL,player.components().transform().position(),1),"Law accepts real actor");
        var dispatch=law.tick(1,List.of(player),Set.of("p1"),256).get(0);
        check(law.dispatchCommitted(dispatch.responseId(),List.of("car","cop","cop2"),2),"Real shared response IDs bind");
        Entity officer=ped("cop",null,PISTOL,715.5,-1088.08);
        ai.tick(2,List.of(player,officer),Set.of("p1"),law);
        check(action(ai,"cop").equals("combat")&&ai.authorizesShot(officer,player,3),"Server law selects close police target");
        Entity far=at(officer,780,-1088.08);ai.tick(600,List.of(player,far),Set.of("p1"),law);
        check(action(ai,"cop").equals("pursue")&&!ai.authorizesShot(far,player,601),"Far officer pursues without remote damage");
        Entity seated=attach(far,"car","driver"),vehicle=car("car",seated,null);
        ai.tick(602,List.of(player,seated,vehicle),Set.of("p1"),law);
        check(action(ai,"cop").equals("idle")&&"road_unavailable".equals(ai.taskForEntity("cop").get("reason")),
            "Police cannot fall back to a direct player chord without roads");
        law.tick(1002,List.of(player,seated,vehicle),Set.of(),256);
        ai.tick(1002,List.of(player,seated,vehicle),Set.of("p1"),law);
        check(action(ai,"cop").equals("idle"),"Frozen law response cannot continue engine pursuit");
    }
    static void deterministicAndMonotonic(){
        Entity player=ped("player","p1",PISTOL,0,0),a=ped("a",null,UNARMED,0,0),b=ped("b",null,UNARMED,2,1);
        WorldAi one=new WorldAi("d"),two=new WorldAi("d");
        one.reportAcceptedShot(player,PISTOL,new Vector(0,0,22),1);two.reportAcceptedShot(player,PISTOL,new Vector(0,0,22),1);
        one.tick(2,List.of(player,a,b),Set.of("p1"),null);two.tick(2,List.of(b,a,player),Set.of("p1"),null);
        check(one.snapshot().equals(two.snapshot()),"Input collection iteration order does not change decisions");
        boolean rejected=false;try{one.tick(1,List.of(player,a,b),Set.of("p1"),null);}catch(IllegalArgumentException expected){rejected=true;}
        check(rejected,"Simulation clock must be monotonic");
    }
    static RoadNetwork roads()throws Exception{
        Path file=Files.createTempFile("ai-road-fixture-",".bin");
        double[][] nodes={{0,0},{20,0},{20,20},{40,20},{40,40},{100,100},{120,100},{200,0},{220,0}};
        int[][] links={{0,1,1,1},{1,2,1,1},{2,3,1,1},{3,4,1,1},{5,6,1,1},{7,8,1,0}};
        try(DataOutputStream output=new DataOutputStream(Files.newOutputStream(file))){
            output.write("GTAROAD1".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
            output.writeInt(nodes.length);output.writeInt(links.length);output.write(new byte[32]);
            for(double[] node:nodes){
                output.writeFloat((float)node[0]+700);output.writeFloat((float)node[1]-1100);output.writeFloat(22);
                output.writeInt(0);output.writeByte(1);output.writeByte(0);output.writeByte(8);output.writeByte(0);output.writeInt(0);
            }
            for(int[] link:links){output.writeInt(link[0]);output.writeInt(link[1]);output.writeFloat(6);
                output.writeShort(link[2]);output.writeShort(link[3]);output.writeInt(0);}
        }
        try{return RoadNetwork.load(file);}finally{Files.delete(file);}
    }
    static Vector destination(WorldAi ai,String id){
        @SuppressWarnings("unchecked") List<Number> values=(List<Number>)ai.taskForEntity(id).get("destination");
        return new Vector(values.get(0).doubleValue(),values.get(1).doubleValue(),values.get(2).doubleValue());
    }
    static Vector roadVector(double x,double y){return new Vector(x+700,y-1100,22);}
    static Entity roadAt(Entity value,double x,double y){return at(value,x+700,y-1100);}
    static Entity roadPed(String id,String player,long weapon,double x,double y){return ped(id,player,weapon,x+700,y-1100);}
    static void serverRoadDriving()throws Exception{
        RoadNetwork roads=roads();WorldAi ai=new WorldAi("road-police",roads);WorldLaw law=new WorldLaw("road-police");
        Entity player=roadPed("player","p1",PISTOL,40,35);
        check(law.reportAcceptedShot(player,PISTOL,player.components().transform().position(),1),"Crime for routed response");
        var dispatch=law.tick(1,List.of(player),Set.of("p1"),256).get(0);
        check(law.dispatchCommitted(dispatch.responseId(),List.of("car","cop","cop2"),2),"Routed response committed");
        Entity officer=attach(roadPed("cop",null,PISTOL,2,0),"car","driver"),vehicle=car("car",officer,null);
        ai.tick(2,List.of(player,officer,vehicle),Set.of("p1"),law);
        check(action(ai,"cop").equals("drive"),"Road-backed police drive");
        Vector waypoint=destination(ai,"cop");
        check(waypoint.distance(roadVector(14,0))<.001,"First target is twelve metres along actual road, before the turn");
        check(!waypoint.equals(player.components().transform().position()),"No direct player-coordinate driver goal");
        Entity later=roadAt(officer,20,10),movedCar=roadAt(vehicle,20,10);
        ai.tick(600,List.of(player,later,movedCar),Set.of("p1"),law);
        check(destination(ai,"cop").distance(roadVector(22,20))<.001,"Moving driver advances along cached turning route");
        Entity acrossGap=roadAt(player,110,100);
        ai.tick(1200,List.of(acrossGap,later,movedCar),Set.of("p1"),law);
        check(action(ai,"cop").equals("idle")&&"road_unavailable".equals(ai.taskForEntity("cop").get("reason")),
            "Disconnected target cannot make a direct cross-map driving task");
        check(ai.taskForEntity("cop").get("destination")==null,"Failed route clears old destination");
        WorldAi ambient=new WorldAi("road-ambient",roads);Entity civilian=attach(roadPed("driver",null,UNARMED,2,0),"traffic","driver");
        Entity traffic=car("traffic",civilian,null);
        ambient.tick(1,List.of(player,civilian,traffic),Set.of("p1"),null);
        check(action(ambient,"driver").equals("drive")&&destination(ambient,"driver").distance(roadVector(14,0))<.001,
            "Ambient traffic receives deterministic connected-road waypoint");
        WorldAi same=new WorldAi("road-ambient",roads);
        same.tick(1,List.of(traffic,civilian,player),Set.of("p1"),null);
        check(ambient.snapshot().equals(same.snapshot()),"Road cruise independent of entity iteration order");
        check("server_road_graph".equals(ambient.snapshot().get("navigation_authority")),"Navigation authority explicit");
        Entity oneWay=roadAt(civilian,210,0),oneWayCar=roadAt(traffic,210,0);
        ambient.tick(600,List.of(player,oneWay,oneWayCar),Set.of("p1"),null);
        check(action(ambient,"driver").equals("idle")&&"road_unavailable".equals(ambient.taskForEntity("driver").get("reason")),
            "Unverified one-way road cannot restore local wandering");
    }
    public static void main(String[] args)throws Exception{
        ambientAndShot();retaliationFencing();driversAndDegenerateGeometry();policePlan();deterministicAndMonotonic();serverRoadDriving();
        System.out.println("WorldAiHarness OK");
    }
}
'''


class WorldAiTests(unittest.TestCase):
    def test_authoritative_npc_decisions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            harness = root / "WorldAiHarness.java"
            harness.write_text(HARNESS, encoding="utf-8")
            source = ROOT / "server/src/main/java/offline/multiplayer"
            subprocess.run([JAVAC, "-encoding", "UTF-8", "-d", str(root),
                            *(str(source / name) for name in ("WorldRegistry.java", "WorldLaw.java", "WorldAi.java", "RoadNetwork.java", "PedNavigation.java")),
                            str(harness)], check=True, capture_output=True, text=True)
            result = subprocess.run([JAVA, "-cp", str(root), "offline.multiplayer.WorldAiHarness"],
                                    check=True, capture_output=True, text=True)
            self.assertIn("WorldAiHarness OK", result.stdout)


if __name__ == "__main__":
    unittest.main()
