#!/usr/bin/env python3
"""Synthetic routing boundaries plus an optional installed-road smoke test."""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
spec = importlib.util.spec_from_file_location("extract_road_network", ROOT / "tools/extract_road_network.py")
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)

HARNESS = r'''
package offline.multiplayer;
import java.nio.file.*;
import java.io.*;
import java.util.*;
public final class RoadNetworkHarness {
    static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
    static RoadNetwork.Point p(double x,double y,double z){return new RoadNetwork.Point(x,y,z);}
    static void reject(Path file)throws Exception{
        try{RoadNetwork.load(file);throw new AssertionError("Malformed graph accepted");}
        catch(IOException expected){}
    }
    public static void main(String[] args)throws Exception{
        if(args[0].equals("reject")){reject(Path.of(args[1]));return;}
        RoadNetwork graph=RoadNetwork.load(Path.of(args[1]));
        if(args[0].equals("real")){
            check(graph.nodeCount()==77824,"Installed nodes");
            check(graph.linkCount()==81133,"Installed links");
            check(graph.activeLinkCount()>10000,"Nonempty conservative network");
            RoadNetwork.Snap a=graph.nearest(p(120.9885,-37.67239,66.68739),1);
            RoadNetwork.Snap b=graph.nearest(p(3407.426,3745.81,29.79411),1);
            check(a!=null&&b!=null,"Real road references");
            RoadNetwork.Route route=graph.route(a.position(),b.position(),2,20000);
            check(route.reached(),"Real connected-subgraph route: "+route.reason());
            check(route.length()>100,"Route follows multiple graph edges");
            System.out.println(graph.metadata()+" route_points="+route.points().size()+" route_length="+route.length());
            return;
        }
        check(graph.nodeCount()==12&&graph.linkCount()==9,"Read complete raw graph");
        check(graph.activeLinkCount()==5,"Only verified usable roads admitted");
        RoadNetwork.Snap ground=graph.nearest(p(15,0,.5),3);
        RoadNetwork.Snap bridge=graph.nearest(p(15,0,19.5),3);
        check(ground!=null&&Math.abs(ground.position().z())<.001,"Ground layer snapping");
        check(Math.abs(graph.heading(ground)-270)<.001,"GTA heading follows actual from-to link tangent");
        check(bridge!=null&&Math.abs(bridge.position().z()-20)<.001,"Bridge height snapping");
        check(graph.nearest(p(1000,1000,0),10)==null,"No invented road at remote point");
        RoadNetwork.Route route=graph.route(p(2,0,0),p(30,18,0),2,100);
        check(route.reached()&&route.points().size()>=4,"Multi-edge A star");
        check(Math.abs(route.length()-(18+Math.sqrt(200)+8))<.001,"Route includes projected endpoints");
        check(route.points().get(0).distance(p(2,0,0))<.001,"Start projection");
        check(route.points().get(route.points().size()-1).distance(p(30,18,0))<.001,"Destination projection");
        try{route.points().clear();throw new AssertionError("Mutable route");}catch(UnsupportedOperationException expected){}
        check(graph.route(p(2,0,0),p(8,0,0),2,1).reached(),"Same edge works within one expansion");
        check("route_budget".equals(graph.route(p(2,0,0),p(30,18,0),2,1).reason()),"Finite A star budget");
        check("disconnected".equals(graph.route(p(2,0,0),p(15,0,20),2,100).reason()),"No straight-line fallback across layers");
        check("off_road".equals(graph.route(p(1000,1000,0),p(2,0,0),2,100).reason()),"No off-road connector");
        check("unavailable".equals(RoadNetwork.empty().route(p(0,0,0),p(1,1,1),2,10).reason()),"Missing resource explicit");
        check(graph.nearest(p(45,0,0),2)==null,"One way without verified direction excluded");
        check(graph.nearest(p(65,0,0),2)==null,"Disabled node excluded");
        check(graph.nearest(p(85,0,0),2)==null,"Dont-use-for-navigation excluded");
        try{graph.nearest(p(0,0,0),1001);throw new AssertionError("Unbounded snap");}catch(IllegalArgumentException expected){}
        try{graph.route(p(0,0,0),p(1,1,1),2,20001);throw new AssertionError("Unbounded route");}catch(IllegalArgumentException expected){}
        try{p(Double.NaN,0,0);throw new AssertionError("Nonfinite point");}catch(IllegalArgumentException expected){}
        check(graph.link(4).lanesIn()==1&&graph.link(4).lanesOut()==0,"Raw one-way lane semantics preserved");
        RoadNetwork.Route cruise=graph.cruise(p(2,0,0),270,2,30,17);
        check(cruise.reached()&&Math.abs(cruise.length()-30)<.001,"Ambient cruise follows connected real edges");
        check(cruise.points().equals(graph.cruise(p(2,0,0),270,2,30,17).points()),"Stable ambient cruise");
        check(!graph.cruise(p(45,0,0),270,2,30,17).reached(),"Cruise cannot enter unverified one-way edge");
        System.out.println("RoadNetwork synthetic checks passed");
    }
}
'''


def node(x, y, z=0, flags=0):
    return extractor.NODE.pack(x, y, z, flags, 1, 0, 8, 0, 0)


class RoadNetworkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="roads-test-")
        cls.work = Path(cls.temp.name)
        source = cls.work / "RoadNetworkHarness.java"
        source.write_text(HARNESS)
        cls.java = os.environ.get("JAVA", shutil.which("java") or "java")
        javac = os.environ.get("JAVAC", shutil.which("javac") or "javac")
        subprocess.run([javac, "--release", "17", "-d", str(cls.work),
                        str(ROOT / "server/src/main/java/offline/multiplayer/RoadNetwork.java"), str(source)], check=True)
        cls.fixture = cls.work / "fixture.bin"
        nodes = [node(0, 0), node(10, 0), node(20, 0), node(30, 10), node(30, 20),
                 node(10, 0, 20), node(20, 0, 20), node(40, 0), node(50, 0),
                 node(60, 0, flags=1), node(70, 0), node(90, 0)]
        links = [(0, 1, 6, 1, 1, 0), (1, 2, 6, 1, 1, 0), (2, 3, 6, 1, 1, 0),
                 (3, 4, 6, 1, 1, 0), (7, 8, 6, 1, 0, 0), (5, 6, 6, 1, 1, 0),
                 (9, 10, 6, 1, 1, 0), (10, 11, 6, 1, 1, 16), (8, 9, 6, 1, 1, 0)]
        cls.data = extractor.MAGIC + struct.pack(">II", len(nodes), len(links)) + bytes(32)
        cls.data += b"".join(nodes) + b"".join(extractor.LINK.pack(*link) for link in links)
        cls.fixture.write_bytes(cls.data)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def run_java(self, mode, file):
        subprocess.run([self.java, "-cp", str(self.work), "offline.multiplayer.RoadNetworkHarness", mode, str(file)], check=True)

    def test_geometry_route_limits_and_safe_failures(self):
        self.run_java("fixture", self.fixture)

    def test_malformed_header_count_coordinate_and_endpoint(self):
        bad_values = [b"broken", self.data[:-1], self.data + b"x"]
        for offset, replacement in [(0, b"CORRUPT!"), (8, struct.pack(">I", 2**31 - 1)),
                                    (48, struct.pack(">f", float("nan"))),
                                    (48 + 12 * extractor.NODE.size, struct.pack(">i", 999))]:
            bad_values.append(self.data[:offset] + replacement + self.data[offset + len(replacement):])
        for index, data in enumerate(bad_values):
            with self.subTest(index=index):
                file = self.work / f"bad-{index}.bin"
                file.write_bytes(data)
                self.run_java("reject", file)

    def test_extractor_resolves_concrete_ipl_fields(self):
        fixture = self.work / "small.ipl"
        fixture.write_text("vnod\n0,0,2,0,0,0,1,0,0.5333334,0,0,0,0,0,0,0,0,0,0,0,0,0\n"
                           "10,0,3,0,0,0,2,0,1,42,1,0,0,0,0,0,0,0,0,0,0,0\nend\nlink\n0,1,6,2,1,0\nend\n")
        output = self.work / "extracted.bin"
        audit = extractor.export(fixture, output)
        self.assertEqual(audit["nodes"], 2)
        self.assertEqual(audit["links"], 1)
        self.assertEqual(audit["node_flag_counts"]["Highway"], 1)
        self.assertEqual(audit["bounds"]["max"], [10, 0, 3])
        self.assertEqual(output.stat().st_size, 48 + 2 * extractor.NODE.size + extractor.LINK.size)

    def test_extractor_rejects_missing_endpoint(self):
        file = self.work / "invalid.ipl"
        file.write_text("vnod\n0,0,0,0,0,0,1,0,0.5,0,0,0,0,0,0,0,0,0,0,0,0,0\nend\nlink\n0,9,1,1,1,0\nend\n")
        with self.assertRaisesRegex(ValueError, "missing node"):
            extractor.export(file, self.work / "invalid.bin")

    def test_installed_network_if_available(self):
        file = ROOT / "server/world-data/roads.bin"
        if not file.exists():
            self.skipTest("Installed game graph is not bundled with source")
        self.run_java("real", file)


if __name__ == "__main__":
    unittest.main()
