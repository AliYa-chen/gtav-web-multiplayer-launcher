#!/usr/bin/env python3
"""Exercise server pedestrian plans, portal progress and stalled-route recovery."""
from __future__ import annotations

from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
JAVA = shutil.which("java") or "java"
JAVAC = shutil.which("javac") or "javac"

HARNESS = r'''
package offline.multiplayer;
import java.io.*;
import java.nio.file.*;
import java.lang.reflect.*;
import java.util.*;
import offline.multiplayer.WorldRegistry.*;
import offline.multiplayer.WorldRegistry.Vector;
import offline.multiplayer.PedNavigation.Point;
public final class PedestrianAiHarness {
    static final long PISTOL=WorldLaw.POLICE_WEAPON;
    static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
    static Entity ped(String id,String player,long weapon,Vector at){return new Entity(id,Kind.PED,0xc99f21c4L,player,1,1,"p1",1,100000,1,
        Components.ped(Transform.at(at,90),new PedView(null,Actions.idle(),weapon,false,null),new Combat(200,200,0,0,0)));}
    static Entity at(Entity e,Vector at){Components c=e.components();return new Entity(e.entityId(),e.kind(),e.model(),e.playerId(),e.revision()+1,e.generation(),e.ownerId(),e.ownerEpoch(),e.leaseUntilTick(),2,
        new Components(Transform.at(at,90),c.ped(),c.vehicle(),c.object(),c.combat(),c.attachment()));}
    static Entity identity(Entity e,long generation,long epoch){return new Entity(e.entityId(),e.kind(),e.model(),e.playerId(),e.revision()+1,generation,e.ownerId(),epoch,e.leaseUntilTick(),2,e.components());}
    static Vector destination(WorldAi ai,String id){Object raw=ai.taskForEntity(id).get("destination");if(raw==null)return null;List<?> v=(List<?>)raw;return new Vector(((Number)v.get(0)).doubleValue(),((Number)v.get(1)).doubleValue(),((Number)v.get(2)).doubleValue());}
    static long metric(WorldAi ai,String name){return ((Number)ai.pedestrianStatus().get(name)).longValue();}
    static Point point(Vector p){return new Point(p.x(),p.y(),p.z());}
    static Vector v(double x,double y){return new Vector(x,y,0);}
    static PedNavigation mesh(Path file,boolean twoRoutes)throws Exception{
        double[][][] polys=twoRoutes?new double[][][]{{{0,0},{20,0},{10,10}},{{20,0},{20,20},{10,10}},{{20,20},{0,20},{10,10}},{{0,20},{0,0},{10,10}}}:
            new double[][][]{{{0,0},{20,0},{20,20}},{{0,0},{20,20},{0,20}},{{0,20},{20,20},{20,40}},{{0,20},{20,40},{0,40}},{{20,20},{40,20},{40,40}},{{20,20},{40,40},{20,40}}};
        int[][] links=twoRoutes?new int[][]{{-1,1,3},{-1,2,0},{-1,3,1},{-1,0,2}}:
            new int[][]{{-1,-1,1},{0,2,-1},{1,5,3},{2,-1,-1},{-1,-1,5},{4,-1,2}};
        try(DataOutputStream out=new DataOutputStream(Files.newOutputStream(file))){
            out.write("GTAPNAV1".getBytes(java.nio.charset.StandardCharsets.US_ASCII));for(double x:new double[]{-1,-1,-1,45,45,5})out.writeDouble(x);out.writeInt(polys.length);
            for(int i=0;i<polys.length;i++){out.writeInt(1);out.writeInt(i);out.writeInt(0);for(double[] p:polys[i]){out.writeFloat((float)p[0]);out.writeFloat((float)p[1]);out.writeFloat(0);}for(int next:links[i])out.writeInt(next);}
        }return PedNavigation.load(file);
    }
    static WorldAi pursuing(PedNavigation nav,Entity player,Entity guard){WorldAi ai=new WorldAi("walk-tests",RoadNetwork.empty(),nav);
        check(ai.reportAcceptedDamage(player,guard,10,1),"Accepted attack records distant pursuit");ai.tick(2,List.of(player,guard),Set.of("p1"),null);return ai;}
    static Object course(WorldAi ai)throws Exception{Field f=WorldAi.class.getDeclaredField("walks");f.setAccessible(true);return ((Map<?,?>)f.get(ai)).get("guard");}
    static void progress(Path file)throws Exception{
        PedNavigation nav=mesh(file,false);Entity player=ped("player","p1",PISTOL,v(39,39)),guard=ped("guard",null,PISTOL,v(19,1));
        WorldAi ai=pursuing(nav,player,guard);check(ai.taskForEntity("guard").get("action").equals("pursue"),"Distant actual attacker pursued");
        Vector initial=destination(ai,"guard"),position=guard.components().transform().position();
        check(initial!=null && initial.distance(position)<=2.001,"One native walk task covers at most current two-metre segment");
        check(initial.x()<position.x(),"First waypoint must head around inside corner, not toward the attacker through the wall");
        for(int step=0;step<16;step++){
            Vector goal=destination(ai,"guard");if(goal==null)break;Vector prior=guard.components().transform().position();
            for(int j=0;j<=10;j++){double t=j/10.;Point p=new Point(prior.x()+(goal.x()-prior.x())*t,prior.y()+(goal.y()-prior.y())*t,0);
                check(nav.nearest(p,.0001)!=null,"Native walking plan cut outside server nav polygons");}
            long revision=ai.revision();guard=at(guard,goal);ai.tick(3+step,List.of(player,guard),Set.of("p1"),null);
            Vector next=destination(ai,"guard");if(next!=null && goal.distance(next)>.2)check(ai.revision()>revision,"2m portal updates must not be swallowed by old 3m plan threshold");
        }
    }
    static void blocked(Path file)throws Exception{
        PedNavigation nav=mesh(file,false);Entity player=ped("player","p1",PISTOL,v(39,39)),guard=ped("guard",null,PISTOL,v(19,1));
        WorldAi ai=pursuing(nav,player,guard);ai.tick(3003,List.of(player,guard),Set.of("p1"),null);
        check(metric(ai,"stuck_recoveries")==1 && metric(ai,"replans")==2,"3 seconds stationary triggers server recovery");
        check(destination(ai,"guard")==null && ai.taskForEntity("guard").get("action").equals("idle"),"No second safe portal means wait");
        ai.tick(4500,List.of(player,guard),Set.of("p1"),null);check(destination(ai,"guard")==null,"Do not send the original blocked route again on retry");
        ai.tick(6500,List.of(player,guard),Set.of("p1"),null);check(destination(ai,"guard")==null,"Blocked portal remains avoided until movement/goal changes");
    }
    static void portalTolerance(Path file)throws Exception{
        PedNavigation nav=mesh(file,false);Entity player=ped("player","p1",PISTOL,v(39,39)),guard=ped("guard",null,PISTOL,v(19,1));
        WorldAi ai=pursuing(nav,player,guard);Point portal=nav.route(point(v(19,1)),point(v(39,39)),4,12000).points().get(1);
        Vector near=new Vector(portal.x()+.25,portal.y(),portal.z());guard=at(guard,near);
        ai.tick(3,List.of(player,guard),Set.of("p1"),null);Vector next=destination(ai,"guard");
        check(next!=null && next.distance(new Vector(portal.x(),portal.y(),portal.z()))>.5,"Within .25m of a portal advances the next segment instead of remaining stuck");
    }
    static void alternate(Path file)throws Exception{
        PedNavigation nav=mesh(file,true);Entity player=ped("player","p1",PISTOL,v(10,19)),guard=ped("guard",null,0xa2719263L,v(10,1));
        // Walk private planner accepts a fixed flee goal, keeping this fixture
        // independent of perception geometry and the 25m flee offset rule.
        WorldAi ai=new WorldAi("alternate",RoadNetwork.empty(),nav);Class<?> planType=Class.forName("offline.multiplayer.WorldAi$Plan");
        Constructor<?> ctor=planType.getDeclaredConstructors()[0];ctor.setAccessible(true);
        Object requested=ctor.newInstance(1L,1L,"flee","attacked",player.entityId(),1L,v(10,19),v(10,19),3.,null,100000L);
        Method walk=WorldAi.class.getDeclaredMethod("walk",Entity.class,planType,long.class);walk.setAccessible(true);
        Object first=walk.invoke(ai,guard,requested,2L);Method dest=planType.getDeclaredMethod("destination");dest.setAccessible(true);
        Vector old=(Vector)dest.invoke(first);Object recovered=walk.invoke(ai,guard,requested,3003L);Vector next=(Vector)dest.invoke(recovered);
        check(next!=null && old!=null && old.x()!=next.x(),"Stationary NPC chooses the other first portal");
        check(nav.nearest(point(next),.0001)!=null,"Recovery destination stays on navmesh");
    }
    static void identities(Path file)throws Exception{
        PedNavigation nav=mesh(file,false);Entity player=ped("player","p1",PISTOL,v(39,39)),guard=ped("guard",null,PISTOL,v(19,1));
        WorldAi ai=pursuing(nav,player,guard);Object old=course(ai);guard=identity(guard,1,2);ai.tick(3,List.of(player,guard),Set.of("p1"),null);
        check(old!=course(ai) && metric(ai,"replans")==2,"Owner epoch must discard path from prior simulation lease");
        old=course(ai);guard=identity(guard,2,2);ai.tick(4,List.of(player,guard),Set.of("p1"),null);
        check(old!=course(ai) && metric(ai,"replans")==3,"New NPC life must discard old path and attacker memory");
    }
    static void unavailable(Path file)throws Exception{
        PedNavigation nav=mesh(file,false);Entity player=ped("player","p1",PISTOL,v(100,100)),guard=ped("guard",null,PISTOL,v(19,1));
        WorldAi ai=pursuing(nav,player,guard);check(destination(ai,"guard")==null && ai.taskForEntity("guard").get("action").equals("idle"),"Goal outside actual nav cannot produce direct-line pursuit");
    }
    static void real(Path file)throws Exception{
        PedNavigation nav=PedNavigation.load(file);Vector location=new Vector(711.5,-1088.08,22);var snap=nav.nearest(point(location),4);check(snap!=null,"Actual spawn must snap");
        Vector spawned=new Vector(snap.position().x(),snap.position().y(),snap.position().z()+.05);
        Entity player=ped("player","p1",PISTOL,location),guard=ped("guard",null,0xa2719263L,spawned);
        WorldAi ai=new WorldAi("real-walk",RoadNetwork.empty(),nav);ai.tick(1,List.of(player,guard),Set.of("p1"),null);
        Vector goal=destination(ai,"guard");check(goal!=null && ai.taskForEntity("guard").get("action").equals("wander"),"Actual YNV birth zone yields server walking plan");
        check(nav.nearest(point(goal),.06)!=null && goal.distance(spawned)<=2.001,"Actual plan remains on native navmesh");
    }
    public static void main(String[] args)throws Exception{Path file=Path.of(args[1]);switch(args[0]){
        case "progress"->progress(file);case "blocked"->blocked(file);case "portal"->portalTolerance(file);case "alternate"->alternate(file);case "identities"->identities(file);case "unavailable"->unavailable(file);case "real"->real(file);
        default->throw new IllegalArgumentException(args[0]);}System.out.println("OK "+args[0]);}
}
'''


class PedestrianAiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="gta-pedestrian-ai-test-")
        cls.classes = Path(cls.temporary.name); fixture = cls.classes / "PedestrianAiHarness.java"
        fixture.write_text(HARNESS, encoding="utf-8")
        source = ROOT / "server/src/main/java/offline/multiplayer"
        result = subprocess.run([JAVAC, "--release", "17", "-encoding", "UTF-8", "-d", str(cls.classes),
            *(str(source / name) for name in ("WorldRegistry.java", "WorldLaw.java", "WorldAi.java", "RoadNetwork.java", "PedNavigation.java")), str(fixture)],
            capture_output=True, text=True, timeout=30)
        if result.returncode:
            cls.temporary.cleanup(); raise AssertionError(result.stdout + result.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def scenario(self, name, path=None):
        result = subprocess.run([JAVA, "-ea", "-cp", str(self.classes), "offline.multiplayer.PedestrianAiHarness", name,
            str(path or self.classes / "fixture.bin")], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("OK " + name, result.stdout)

    def test_walk_follows_portals_and_publishes_small_waypoint_updates(self):
        self.scenario("progress")

    def test_stalled_single_corridor_stays_idle_until_world_changes(self):
        self.scenario("blocked")

    def test_within_quarter_metre_of_portal_advances_next_segment(self):
        self.scenario("portal")

    def test_stalled_actor_uses_another_safe_portal(self):
        self.scenario("alternate")

    def test_new_simulator_or_new_life_discards_old_path(self):
        self.scenario("identities")

    def test_uncovered_goal_does_not_restore_direct_line_chase(self):
        self.scenario("unavailable")

    @unittest.skipUnless((ROOT / "server/world-data/ped-navigation.bin").exists(), "Requires local derived YNV navigation")
    def test_actual_ynv_spawn_produces_server_walking_plan(self):
        self.scenario("real", ROOT / "server/world-data/ped-navigation.bin")


if __name__ == "__main__":
    unittest.main()
