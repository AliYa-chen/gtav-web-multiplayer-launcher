#!/usr/bin/env python3
"""Compile real server classes and test collision authority and physical projectiles."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
JAVA = os.environ.get("JAVA", shutil.which("java") or "java")
JAVAC = os.environ.get("JAVAC", shutil.which("javac") or "javac")

HARNESS = r'''
package offline.multiplayer;
import java.nio.file.*;
import java.io.*;
import java.util.*;
import offline.multiplayer.WorldRegistry.Vector;

public final class ServerCollisionHarness {
    static final long MODEL=0x705e61f2L,RIFLE=0xbfefff6dL,GRENADE=0x93e220bdL,STICKY=0x2c3731d9L;
    interface Checked {void run()throws Exception;}
    static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
    static void close(double actual,double expected,double tolerance,String why){check(Math.abs(actual-expected)<=tolerance,why+": "+actual);}
    static void rejects(String code,Checked action)throws Exception{
        try{action.run();throw new AssertionError("Expected rejection "+code);}
        catch(WorldService.Problem e){check(code.equals(e.code),"Unexpected rejection "+e.code+" expected "+code);}
    }
    static long count(List<Map<String,Object>> events,String type){return events.stream().filter(e->type.equals(e.get("type"))).count();}
    static Map<String,Object> reply(String epoch,String id,List<?> hits){
        return WorldService.map("type","collision_result","schema_version",2,"world_epoch",epoch,
            "query_id",id,"complete",true,"hits",hits);
    }
    static Map<String,Object> hit(double x,double y,double z,double nx,double ny,double nz){
        return WorldService.map("position",List.of(x,y,z),"normal",List.of(nx,ny,nz),"material",0xffffffffL);
    }
    static String query(WorldCollision c,long now){
        return c.submit("a","shot",List.of(new WorldCollision.Segment(new Vector(0,0,0),new Vector(10,0,0),.02)),now);
    }
    static class Fixture {
        final WorldRegistry world=new WorldRegistry("collision",Map.of(WorldRegistry.Kind.PED,Set.of(MODEL)),WeaponCatalog.rules().keySet());
        final WorldCollision collision=new WorldCollision("collision");
        final CombatWorld combat=new CombatWorld(world,collision);
        final List<Double> origin;
        Fixture(long weapon,boolean nativeObserver)throws Exception{
            this(weapon,nativeObserver,0);
        }
        Fixture(long weapon,boolean nativeObserver,double targetY)throws Exception{
            combat.join("a",0);combat.join("b",0);
            origin=world.playerEntity("a").components().transform().position().values();
            state("a",weapon,0,0,0);state("b",RIFLE,6,targetY,0);
            if(nativeObserver)collision.observer("a",true);
        }
        List<Double> point(double x,double y,double z){return List.of(origin.get(0)+x,origin.get(1)+y,origin.get(2)+z);}
        void state(String id,long weapon,double x,double y,long now)throws Exception{
            long seq=((Number)combat.profile(id).get("last_state_seq")).longValue()+1;
            check(combat.updateState(id,WorldService.map("seq",seq,"position",point(x,y,0),"model",MODEL,
                "heading",270,"health",200,"weapon",weapon,"shooting",false),now).accepted(),"State accepted");
        }
        List<Map<String,Object>> shot(long weapon,List<Double> target)throws Exception{
            return combat.shoot("a",WorldService.map("seq",1,"weapon",weapon,"origin",point(0,0,.7),"target",target),0);
        }
        int health(String player){return world.playerEntity(player).components().combat().health();}
        List<Map<String,Object>> queries(){return collision.drain();}
        void clear(List<Map<String,Object>> queries,long now)throws Exception{
            for(var q:queries){int size=((List<?>)q.get("segments")).size();
                collision.accept("a",reply("collision",(String)q.get("query_id"),new ArrayList<>(Collections.nCopies(size,null))),now);}
        }
        Map<?,?> projectile(){var effects=(List<?>)combat.projectileState(0).get("effects");
            check(effects.size()==1,"Exactly one live projectile");return(Map<?,?>)effects.get(0);}
    }
    static void bvh(Path file)throws Exception{
        StaticCollision geometry=StaticCollision.load(file);
        check(((Number)geometry.metadata().get("triangles")).intValue()>16,"Exercise internal BVH nodes");
        var forward=geometry.first(new WorldCollision.Segment(new Vector(710,-1088.1,23.1),new Vector(720,-1088.1,23.1),0));
        check(forward!=null,"Front face intersects");close(forward.position().x(),714,.001,"Nearest front surface");
        check(forward.normal().x()<-.99&&forward.material()==17,"Front normal faces incident ray and preserves material");
        var reverse=geometry.first(new WorldCollision.Segment(new Vector(720,-1088.1,23.1),new Vector(710,-1088.1,23.1),0));
        check(reverse!=null,"Back face intersects");close(reverse.position().x(),716,.001,"Nearest back surface");
        check(reverse.normal().x()>.99&&reverse.material()==23,"Back normal faces reverse ray");
        check(geometry.first(new WorldCollision.Segment(new Vector(710,-1100,23.1),new Vector(720,-1100,23.1),0))==null,"Ray outside triangles misses");
        check(geometry.first(new WorldCollision.Segment(new Vector(713,-1088.1,23.1),new Vector(713,-1087,23.1),0))==null,"Parallel ray misses");
    }
    static void bad(Path file)throws Exception{
        try{StaticCollision.load(file);throw new AssertionError("Malformed binary accepted");}catch(IOException expected){}
    }
    static void real(Path file)throws Exception{
        StaticCollision geometry=StaticCollision.load(file);
        check(((Number)geometry.metadata().get("triangles")).intValue()>100000,"Real extraction has substantial geometry");
        var hit=geometry.first(new WorldCollision.Segment(new Vector(711,-1088,200),new Vector(711,-1088,-200),0));
        check(hit!=null,"Extracted public spawn ground intersects");close(hit.position().z(),21.413,.002,"Actual YBN ground height");
        check(hit.normal().z()>.8,"Public spawn ground upward normal");
        System.out.println("real ground="+hit.position()+" material="+hit.material());
    }
    static void validation()throws Exception{
        WorldCollision c=new WorldCollision("test");c.observer("a",true);String id=query(c,0);
        rejects("wrong_world",()->c.accept("a",reply("other",id,Arrays.asList((Object)null)),1));
        rejects("stale_collision",()->c.accept("b",reply("test",id,Arrays.asList((Object)null)),1));
        rejects("invalid_collision",()->c.accept("a",reply("test",id,List.of()),1));
        rejects("invalid_collision",()->c.accept("a",reply("test",id,List.of(hit(5,5,0,-1,0,0))),1));
        rejects("invalid_collision",()->c.accept("a",reply("test",id,List.of(hit(11,0,0,-1,0,0))),1));
        rejects("invalid_collision",()->c.accept("a",reply("test",id,List.of(hit(5,0,0,0,0,0))),1));
        rejects("invalid_collision",()->c.accept("a",reply("test",id,List.of(hit(5,0,0,2,0,0))),1));
        c.accept("a",reply("test",id,List.of(hit(5,0,0,-1,0,0))),2);
        var result=c.take(id);check(result.complete()&&result.hits().size()==1,"Valid native observation accepted once");
        close(result.hits().get(0).position().x(),5,.001,"Native hit preserved");
        check(result.hits().get(0).material()==0xffffffffL,"Unsigned material preserved");
        rejects("stale_collision",()->c.accept("a",reply("test",id,Arrays.asList((Object)null)),3));
        check(c.take(id)==null,"Result consumed once");
        String timeout=query(c,10);c.tick(1511);
        check(!c.take(timeout).complete(),"Timeout cannot become no-hit proof");
        rejects("stale_collision",()->c.accept("a",reply("test",timeout,Arrays.asList((Object)null)),1511));
        String revoked=query(c,1512);c.observer("a",false);
        check(!c.take(revoked).complete(),"Lease observer revocation invalidates pending proof");
        c.observer("a",true);String unavailable=query(c,1513);
        c.accept("a",WorldService.map("type","collision_result","schema_version",2,"world_epoch","test",
            "query_id",unavailable,"complete",false,"hits",List.of(),"reason","outside_streaming_range"),1514);
        check(!c.take(unavailable).complete(),"Unavailable geometry cannot become a clear segment");
        c.drain();for(int i=0;i<64;i++)query(c,1600);String overflow=query(c,1600);
        check(!c.take(overflow).complete()&&c.drain().size()==64,"Per-observer pending limit fails closed");
    }
    static void staticMerge(Path file)throws Exception{
        WorldCollision c=new WorldCollision("merge");c.geometry(StaticCollision.load(file));c.observer("a",true);
        String id=c.submit("a","shot",List.of(new WorldCollision.Segment(new Vector(710,-1088.1,23.1),new Vector(720,-1088.1,23.1),.02)),0);
        c.accept("a",reply("merge",id,Arrays.asList((Object)null)),1);
        close(c.take(id).hits().get(0).position().x(),714,.001,"Native no-hit cannot erase server wall");
        id=c.submit("a","shot",List.of(new WorldCollision.Segment(new Vector(710,-1088.1,23.1),new Vector(720,-1088.1,23.1),.02)),2);
        c.accept("a",reply("merge",id,List.of(hit(718,-1088.1,23.1,-1,0,0))),3);
        close(c.take(id).hits().get(0).position().x(),714,.001,"Nearest static wall beats later native surface");
    }
    static void hitscan(Path wall)throws Exception{
        Fixture f=new Fixture(RIFLE,true);var events=f.shot(RIFLE,f.point(6,0,.7));
        check(count(events,"shot_geometry_pending")==1&&f.health("b")==200,"Ray damage waits for native geometry");
        var q=f.queries();check(q.size()==1,"One server-owned ray query");f.clear(q,1);
        check(f.health("b")==200,"Observation alone cannot apply damage");
        check(count(f.combat.maintain(1),"damage")==1&&f.health("b")==165,"Clear proof permits one server health transaction");
        check(count(f.combat.maintain(2),"damage")==0&&f.health("b")==165,"No duplicate damage");
        Fixture blocked=new Fixture(RIFLE,true);blocked.collision.geometry(StaticCollision.load(wall));
        blocked.shot(RIFLE,blocked.point(6,0,.7));blocked.clear(blocked.queries(),1);blocked.combat.maintain(1);
        check(blocked.health("b")==200,"Server wall blocks damage despite native no-hit");
        Fixture staticOnly=new Fixture(RIFLE,false);staticOnly.collision.geometry(StaticCollision.load(wall));
        staticOnly.shot(RIFLE,staticOnly.point(6,0,.7));staticOnly.combat.maintain(1);
        check(staticOnly.health("b")==200&&staticOnly.queries().isEmpty(),"Known server wall blocks without a native observer");
        Fixture late=new Fixture(RIFLE,true);late.shot(RIFLE,late.point(6,0,.7));late.combat.maintain(1501);
        check(late.health("b")==200,"Timed-out geometry cannot authorize hitscan health changes");
    }
    static void grenade()throws Exception{
        Fixture f=new Fixture(GRENADE,true,10);var launch=f.shot(GRENADE,f.point(1,0,.7));
        check(count(launch,"projectile_event")==1&&"ballistic".equals(f.projectile().get("physics")),"Native-backed physical projectile");
        f.combat.maintain(0);var queries=f.queries();check(queries.size()==1&&"projectile".equals(queries.get(0).get("purpose")),"Server samples ballistic segments");
        check(((List<?>)queries.get(0).get("segments")).size()==16,"Bounded continuous subsegments");
        f.clear(queries,1);var events=f.combat.maintain(100);
        @SuppressWarnings("unchecked") var position=(List<Number>)f.projectile().get("position");
        close(position.get(0).doubleValue(),f.origin.get(0)+2.5,.001,"Physical velocity passes short aim point");
        close(position.get(2).doubleValue(),f.origin.get(2)+.7-.5*9.81*.1*.1,.001,"Server gravity evolves height");
        check("flight".equals(f.projectile().get("phase"))&&count(events,"explosion_event")==0,"Aim-terminal time cannot land or explode physical grenade");
        check(f.health("a")==200&&f.health("b")==200,"Flight does not invent damage");
        Fixture future=new Fixture(GRENADE,true);future.shot(GRENADE,future.point(1,0,.7));future.combat.maintain(0);
        future.clear(future.queries(),1);future.combat.maintain(100);
        @SuppressWarnings("unchecked") var futurePosition=(List<Number>)future.projectile().get("position");
        close(futurePosition.get(0).doubleValue(),future.origin.get(0)+2.5,.01,"A future capsule impact cannot freeze earlier flight");
        Fixture fuse=new Fixture(GRENADE,true,10);fuse.shot(GRENADE,fuse.point(1,0,.7));
        for(long tick=0;tick<=3500;tick+=500){
            check(count(fuse.combat.maintain(tick),"explosion_event")==0,"Grenade cannot explode before its fuse");
            fuse.clear(fuse.queries(),tick+1);
            check(count(fuse.combat.maintain(tick+1),"explosion_event")==0,
                "A future geometry proof through expiry cannot trigger the fuse early at "+(tick+1));
        }
        check(count(fuse.combat.maintain(3999),"explosion_event")==0,"Verified final flight still waits until fuse tick");
        check(count(fuse.combat.maintain(4000),"explosion_event")==1,"Grenade detonates once at verified fuse tick");
        check(count(fuse.combat.maintain(4001),"explosion_event")==0,"Fuse cannot replay after the projectile is removed");
    }
    static void sticky()throws Exception{
        Fixture f=new Fixture(STICKY,true);f.shot(STICKY,f.point(3,0,.7));f.combat.maintain(0);
        var pending=f.queries();check(pending.size()==1,"Sticky trajectory proof pending");
        check(count(f.combat.detonate("a",100),"explosion_event")==0,"Remote button waits for outstanding geometry");
        check(f.health("a")==200&&f.health("b")==200,"Waiting sticky cannot cause unproven damage");
        f.clear(pending,100);var events=f.combat.maintain(100);
        check(count(events,"explosion_event")==1,"Pending remote intent resolves after proof");
        check(f.health("a")==200&&f.health("b")==200,"Blast health also waits for its own occlusion proof");
        var blast=f.queries();check(!blast.isEmpty(),"Blast occlusion gets server-owned queries");
        f.clear(blast,101);f.combat.maintain(101);
        check(f.health("b")<200,"Clear blast proof applies authoritative damage");
        check(count(f.combat.detonate("a",102),"explosion_event")==0,"Remote detonation cannot replay");
    }
    public static void main(String[] args)throws Exception{
        switch(args[0]){
            case "bvh"->bvh(Path.of(args[1]));case "bad"->bad(Path.of(args[1]));case "real"->real(Path.of(args[1]));
            case "validation"->validation();case "merge"->staticMerge(Path.of(args[1]));
            case "hitscan"->hitscan(Path.of(args[1]));case "grenade"->grenade();case "sticky"->sticky();
            default->throw new IllegalArgumentException(args[0]);
        }
        System.out.println("ServerCollisionHarness "+args[0]+" OK");
    }
}
'''


def collision_bytes(triangles):
    return b"GTACOL1\n" + struct.pack(">6di", 600, -1200, -100, 850, -1000, 100, len(triangles)) + b"".join(
        struct.pack(">9fi", *points, material) for points, material in triangles)


class ServerCollisionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="server-collision-tests-")
        cls.work = Path(cls.temp.name)
        source = cls.work / "ServerCollisionHarness.java"
        source.write_text(HARNESS, encoding="utf-8")
        result = subprocess.run([JAVAC, "--release", "17", "-encoding", "UTF-8", "-d", str(cls.work),
                                 *map(str, sorted((ROOT / "server/src/main/java").rglob("*.java"))), str(source)],
                                text=True, capture_output=True)
        if result.returncode:
            raise AssertionError(result.stdout + result.stderr)
        triangles = []
        for x, material in ((714, 17), (716, 23)):
            triangles.extend([((x, -1098, 12, x, -1078, 12, x, -1078, 34), material),
                              ((x, -1098, 12, x, -1078, 34, x, -1098, 34), material)])
        for i in range(40):
            x = 650 + i
            triangles.append(((x, -1050, 0, x, -1040, 0, x, -1040, 10), i))
        cls.data = collision_bytes(triangles)
        cls.wall = cls.work / "wall.bin"
        cls.wall.write_bytes(cls.data)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def run_case(self, mode, path=None):
        result = subprocess.run([JAVA, "-cp", str(self.work), "offline.multiplayer.ServerCollisionHarness", mode,
                                 *([] if path is None else [str(path)])], text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def test_bvh_front_back_nearest_and_miss(self):
        self.run_case("bvh", self.wall)

    def test_malformed_binary_rejected(self):
        cases = [b"broken", self.data[:-1], self.data + b"x"]
        for offset, replacement in ((0, b"BADCOL1\n"), (8, struct.pack(">d", float("nan"))),
                                    (56, struct.pack(">i", -1)), (60, struct.pack(">f", float("nan")))):
            cases.append(self.data[:offset] + replacement + self.data[offset + len(replacement):])
        for index, data in enumerate(cases):
            with self.subTest(index=index):
                path = self.work / f"bad-{index}.bin"
                path.write_bytes(data)
                self.run_case("bad", path)

    def test_native_observer_geometry_replay_and_timeout(self):
        self.run_case("validation")

    def test_static_surface_cannot_be_erased_by_native_reply(self):
        self.run_case("merge", self.wall)

    def test_hitscan_waits_for_proof_and_wall_blocks(self):
        self.run_case("hitscan", self.wall)

    def test_physical_grenade_passes_aim_terminal(self):
        self.run_case("grenade")

    def test_sticky_remote_detonation_waits_for_proof(self):
        self.run_case("sticky")

    def test_real_extracted_spawn_ground_if_present(self):
        path = ROOT / "server/world-data/collision.bin"
        if not path.exists():
            self.skipTest("Local extracted game geometry is not bundled with source")
        self.run_case("real", path)


if __name__ == "__main__":
    unittest.main()
