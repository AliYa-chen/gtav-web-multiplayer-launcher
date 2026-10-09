#!/usr/bin/env python3
"""Verify the resource-derived weapon catalog and deterministic server combat.

No game engine runs here. The tests intentionally exercise the declared capsule
and aim-terminal simulation, not terrain collision or native GTA ballistics.
"""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
JAVAC = os.environ.get("JAVAC", shutil.which("javac") or "javac")
JAVA = os.environ.get("JAVA", shutil.which("java") or "java")

HARNESS = r'''
import offline.multiplayer.*;
import java.util.*;

public class WeaponCatalogHarness {
    static final long MODEL=0x705e61f2L, RIFLE=0xbfefff6dL, RPG=0xb1ca77b1L, STICKY=0x2c3731d9L;
    static void check(boolean condition,String message) { if(!condition)throw new AssertionError(message); }
    static class Fixture {
        final WorldRegistry world=new WorldRegistry("weapons",Map.of(WorldRegistry.Kind.PED,Set.of(MODEL)),WeaponCatalog.rules().keySet());
        final CombatWorld combat=new CombatWorld(world);
        final List<Double> origin;
        Fixture(long weapon) throws Exception {
            combat.join("a",0);combat.join("b",0);
            origin=world.playerEntity("a").components().transform().position().values();
            state("a",weapon,0,0,0);state("b",RIFLE,6,0,0);
        }
        List<Double> point(double x,double y,double z) { return List.of(origin.get(0)+x,origin.get(1)+y,origin.get(2)+z); }
        void state(String id,long weapon,double x,double y,long now) throws Exception {
            var current=combat.profile(id);
            var value=new LinkedHashMap<String,Object>();
            value.put("seq",((Number)current.get("last_state_seq")).longValue()+1);
            value.put("position",point(x,y,0));value.put("model",MODEL);value.put("heading",270);
            value.put("health",200);value.put("weapon",weapon);value.put("shooting",false);
            check(combat.updateState(id,value,now).accepted(),"state accepted");
        }
        List<Map<String,Object>> shot(String id,long weapon,long seq,long now,List<Double> target) throws Exception {
            var p=world.playerEntity(id).components().transform().position();
            return combat.shoot(id,Map.of("seq",seq,"weapon",weapon,"origin",List.of(p.x(),p.y(),p.z()+.7),"target",target),now);
        }
        int health(String id) { return world.playerEntity(id).components().combat().health(); }
    }
    static long count(List<Map<String,Object>> events,String type) { return events.stream().filter(e->type.equals(e.get("type"))).count(); }
    static void catalogAndEveryShootable() throws Exception {
        check(WeaponCatalog.rules().size()==95,"91 local records, 3 retained compatibility records and unarmed alias");
        check(WeaponCatalog.rule(RIFLE).damage()==35,"legacy damage");
        check(WeaponCatalog.rule(0x42bf8a85L).cooldownMillis()==20,"legacy minigun rate");
        check(WeaponCatalog.rule(0x3656c8c1L).damage()==1,"stun damage from asset");
        for(var rule:WeaponCatalog.rules().values()) {
            check(rule.cooldownMillis()>0 && rule.meleeRange()<=2,"bounded cadence and melee reach");
            if(!rule.shootable())continue;
            Fixture f=new Fixture(rule.hash());
            var events=f.shot("a",rule.hash(),1,0,f.point(6,0,.7));
            check(count(events,"shot_event")==1,"accepted catalog weapon "+rule.name());
            if(rule.projectile()) {
                check(count(events,"projectile_event")==1,"server projectile "+rule.name());
                f.combat.maintain(Math.max(1000,rule.fuseMillis()));
                if(rule.detonation().equals("remote"))f.combat.detonate("a",1000);
                if(rule.damage()>0)check(f.health("b")<200,"damaging projectile resolves "+rule.name());
            }
            if(rule.mode().equals("utility"))check(f.health("b")==200,"utility cannot invent bullet damage");
        }
    }
    static void bidirectionalAndPellets() throws Exception {
        Fixture f=new Fixture(RIFLE);
        f.shot("a",RIFLE,1,0,f.point(6,0,.7));check(f.health("b")==165,"a harms b");
        f.shot("b",RIFLE,1,0,f.point(0,0,.7));check(f.health("a")==165,"b harms a");
        long shotgun=0x1d073a89L;Fixture pellets=new Fixture(shotgun);
        pellets.shot("a",shotgun,1,0,pellets.point(6,0,.7));check(pellets.health("b")==150,"close shotgun total stays 50");
        Fixture falloff=new Fixture(shotgun);falloff.state("b",RIFLE,35,0,3000);falloff.state("a",shotgun,0,0,3000);
        falloff.shot("a",shotgun,1,3000,falloff.point(35,0,.7));
        check(falloff.health("b")>150 && falloff.health("b")<200,"spread reduces distant aggregate hit");
        Fixture bounded=new Fixture(0x3656c8c1L);bounded.state("b",RIFLE,20,0,2000);
        bounded.shot("a",0x3656c8c1L,1,2000,bounded.point(20,0,.7));check(bounded.health("b")==200,"stungun range is 11m");
    }
    static void delayedBlastAndOwnership() throws Exception {
        Fixture f=new Fixture(RPG);
        var launched=f.shot("a",RPG,1,0,f.point(6,0,.7));
        check(f.health("b")==200 && count(launched,"damage")==0,"projectiles cannot hurt before simulation");
        check(((List<?>)f.combat.projectileState(0).get("effects")).size()==1,"late join sees projectile");
        var events=f.combat.maintain(50);
        check(count(events,"explosion_event")==1,"server approves one impact blast");
        check(f.health("b")==50 && f.health("a")<200,"blast damages nearby target and shooter");
        int after=f.health("b");check(f.combat.maintain(100).isEmpty() && f.health("b")==after,"blast cannot replay");
        Fixture sticky=new Fixture(STICKY);sticky.shot("a",STICKY,1,0,sticky.point(6,0,.7));
        sticky.combat.maintain(1000);check(sticky.health("b")==200,"sticky does not spontaneously detonate");
        check(sticky.combat.detonate("b",1000).isEmpty(),"other player cannot detonate owner charges");
        check(count(sticky.combat.detonate("a",1000),"explosion_event")==1,"owner can detonate");
        check(sticky.health("b")==50 && sticky.combat.detonate("a",1001).isEmpty(),"remote detonation exactly once");
        Fixture grenade=new Fixture(0x93e220bdL);grenade.shot("a",0x93e220bdL,1,0,grenade.point(6,0,.7));
        grenade.combat.maintain(1000);check(grenade.health("b")==200,"grenade respects resource lifetime fuse");
        check(count(grenade.combat.maintain(4000),"explosion_event")==1 && grenade.health("b")==50,"timed grenade damages at fuse");
    }
    static void hazardsAndLimits() throws Exception {
        long molotov=0x24b17070L;Fixture f=new Fixture(molotov);
        f.shot("a",molotov,1,0,f.point(6,0,.7));f.combat.maintain(1000);
        int health=f.health("b");check(health<200,"fire initial damage");
        f.combat.maintain(2000);check(f.health("b")<health,"fire has bounded ongoing server damage");
        int after=f.health("b");f.combat.maintain(2001);check(f.health("b")==after,"no per-packet fire stacking");
        f.combat.maintain(10000);check(f.health("b")==after,"expired hazard stops");
        Fixture limit=new Fixture(STICKY);
        for(int i=0;i<16;i++){limit.state("a",STICKY,0,0,i*500);limit.shot("a",STICKY,i+1,i*500,limit.point(6,0,.7));}
        limit.state("a",STICKY,0,0,8000);
        try {limit.shot("a",STICKY,17,8000,limit.point(6,0,.7));throw new AssertionError("projectile spam accepted");}
        catch(CombatWorld.Rejection rejection){check(rejection.code.equals("projectile_limit"),"projectile cap reason");}
    }
    static void fastInputQueuesWithoutBurstDamage() throws Exception {
        long shotgun=0x1d073a89L;Fixture f=new Fixture(shotgun);
        f.shot("a",shotgun,1,0,f.point(6,0,.7));
        var queued=f.shot("a",shotgun,2,1,f.point(6,0,.7));
        check(count(queued,"shot_queued")==1 && count(queued,"damage")==0,"fast intent accepted pending");
        check(f.health("b")==150,"queued intent cannot damage early");
        f.combat.maintain(799);check(f.health("b")==150,"weapon pacing remains authoritative");
        check(count(f.combat.maintain(800),"shot_event")==1 && f.health("b")==100,"pending intent executes at server cadence");
        Fixture spam=new Fixture(shotgun);spam.shot("a",shotgun,1,0,spam.point(6,0,.7));
        long replaced=0;
        for(int i=2;i<=100;i++)replaced+=count(spam.shot("a",shotgun,i,i,spam.point(6,0,.7)),"shot_cancelled");
        check(replaced==91,"finite eight-entry queue coalesces latest excessive intent");
        spam.state("a",RIFLE,0,0,100);check(count(spam.combat.maintain(1000),"shot_event")==0,"weapon change clears queue");
        Fixture gone=new Fixture(shotgun);gone.shot("a",shotgun,1,0,gone.point(6,0,.7));
        gone.shot("a",shotgun,2,1,gone.point(6,0,.7));gone.combat.setConnected("a",false);
        check(count(gone.combat.maintain(800),"shot_event")==0 && gone.health("b")==150,"disconnect clears queue");
        Fixture dead=new Fixture(shotgun);dead.shot("a",shotgun,1,0,dead.point(6,0,.7));
        dead.shot("a",shotgun,2,1,dead.point(6,0,.7));
        var entity=dead.world.playerEntity("a");
        dead.world.setCombatTrusted(entity.entityId(),new WorldRegistry.Combat(0,200,0,1,4000),entity.revision(),1);
        check(count(dead.combat.maintain(800),"shot_event")==0,"dead shooter pending intent cancelled");
        dead.combat.maintain(4000);check(count(dead.combat.maintain(4800),"shot_event")==0,"old life cannot fire after respawn");
    }
    public static void main(String[] args) throws Exception {
        catalogAndEveryShootable();bidirectionalAndPellets();delayedBlastAndOwnership();hazardsAndLimits();fastInputQueuesWithoutBurstDamage();
        System.out.println("catalog, bilateral damage, pellets, projectiles, hazards, paced queue and lifecycle cancellation passed");
    }
}
'''


class WeaponCatalogTests(unittest.TestCase):
    def test_generated_catalog_matches_local_resource(self):
        subprocess.run(["python3", "-B", str(ROOT / "tools/generate_weapon_catalog.py"), "--check"], check=True)

    def test_authoritative_combat(self):
        with tempfile.TemporaryDirectory(prefix="weapons-test-") as temporary:
            folder = Path(temporary)
            harness = folder / "WeaponCatalogHarness.java"
            harness.write_text(HARNESS)
            sources = sorted((ROOT / "server/src/main/java").rglob("*.java"))
            subprocess.run([JAVAC, "--release", "17", "-d", str(folder), *map(str, sources), str(harness)], check=True)
            subprocess.run([JAVA, "-cp", str(folder), "WeaponCatalogHarness"], check=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
