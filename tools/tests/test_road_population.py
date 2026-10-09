#!/usr/bin/env python3
"""WorldService traffic spawn positions use loaded roads and keep vehicle spacing."""
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
import java.lang.reflect.*;
import java.util.*;
import offline.multiplayer.WorldRegistry.*;
public class RoadPopulationHarness {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception{
        RoadNetwork roads=args[0].equals("legacy")?RoadNetwork.empty():RoadNetwork.load(Path.of(args[1]));
        WorldService service=new WorldService(StaticCollision.empty(),roads);
        service.join("p1");service.worldParticipant("p1",true);
        Field registryField=WorldService.class.getDeclaredField("registry");registryField.setAccessible(true);
        WorldRegistry registry=(WorldRegistry)registryField.get(service);
        Field populationField=WorldService.class.getDeclaredField("populationEntities");populationField.setAccessible(true);
        @SuppressWarnings("unchecked") Set<String> population=(Set<String>)populationField.get(service);
        List<Entity> cars=registry.snapshot().entities().stream().filter(e->e.kind()==Kind.VEHICLE&&population.contains(e.entityId())).toList();
        int expected=switch(args[0]){case "normal","legacy"->8;case "crowded"->1;case "oneway"->0;default->throw new AssertionError(args[0]);};
        check(cars.size()==expected,"Expected "+expected+" road-backed cars, got "+cars.size());
        long drivers=registry.snapshot().entities().stream().filter(e->e.components().attachment()!=null&&population.contains(e.entityId())).count();
        check(drivers==cars.size(),"Only successfully placed cars get drivers");
        for(Entity car:cars){
            if(!args[0].equals("legacy")){
                var p=car.components().transform().position();
                check(Math.abs(p.y()+1070)<.001&&Math.abs(p.z()-22)<.001,"Traffic uses road XY and reference Z + 1");
                check(Math.abs(car.components().transform().rotation().heading()-270)<.001,"Traffic faces selected road tangent");
                for(Entity other:registry.snapshot().entities())if(other.kind()==Kind.VEHICLE&&!other.entityId().equals(car.entityId()))
                    check(p.distance(other.components().transform().position())>=6,"Spawned vehicles cannot overlap within six metres");
            }
            check(car.components().vehicle().seats().get("driver")!=null,"Road car has one authoritative driver seat");
        }
        System.out.println("Road population "+args[0]+" OK");
    }
}
'''


class RoadPopulationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="road-population-")
        cls.work = Path(cls.temp.name)
        harness = cls.work / "RoadPopulationHarness.java"
        harness.write_text(HARNESS)
        result = subprocess.run([JAVAC, "--release", "17", "-encoding", "UTF-8", "-d", str(cls.work),
                                 *map(str, sorted((ROOT / "server/src/main/java").rglob("*.java"))), str(harness)],
                                capture_output=True, text=True)
        if result.returncode:
            raise AssertionError(result.stdout + result.stderr)
        for name, end, lanes_out in (("normal", 900, 1), ("crowded", 735, 1), ("oneway", 900, 0)):
            data = b"GTAROAD1" + struct.pack(">II", 2, 1) + bytes(32)
            for x in (700, end):
                data += struct.pack(">fffIBBBBI", x, -1070, 21, 0, 1, 0, 8, 0, 0)
            data += struct.pack(">iifHHI", 0, 1, 6, 1, lanes_out, 0)
            (cls.work / f"{name}.bin").write_bytes(data)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def run_case(self, mode):
        result = subprocess.run([JAVA, "-cp", str(self.work), "offline.multiplayer.RoadPopulationHarness", mode,
                                 str(self.work / f"{mode}.bin")], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_traffic_uses_road_height_and_tangent(self):
        self.run_case("normal")

    def test_collapsed_nearest_points_cannot_overlap_cars(self):
        self.run_case("crowded")

    def test_unverified_one_way_road_does_not_spawn_car_or_driver(self):
        self.run_case("oneway")

    def test_no_data_retains_existing_legacy_test_mode(self):
        self.run_case("legacy")


if __name__ == "__main__":
    unittest.main()
