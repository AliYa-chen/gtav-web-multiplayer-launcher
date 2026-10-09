#!/usr/bin/env python3
"""Verify pedestrian paths stay on mesh portals and game exports remain read-only."""
from __future__ import annotations

import argparse
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import extract_ped_navigation as exporter

JAVA = shutil.which("java") or "java"
JAVAC = shutil.which("javac") or "javac"

HARNESS = r'''
import java.io.*;
import java.nio.file.*;
import java.util.*;
import offline.multiplayer.PedNavigation;
import offline.multiplayer.PedNavigation.*;
public final class PedNavigationHarness {
    static void check(boolean ok,String why){if(!ok)throw new AssertionError(why);}
    static Point p(double x,double y){return new Point(x,y,0);}
    static void fixture(Path output,double[][][] polys,int[][] links)throws Exception{
        try(DataOutputStream out=new DataOutputStream(Files.newOutputStream(output))){
            out.write("GTAPNAV1".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
            for(double v:new double[]{-1,-1,-1,20,20,5})out.writeDouble(v);out.writeInt(polys.length);
            for(int i=0;i<polys.length;i++){
                out.writeInt(1);out.writeInt(i);out.writeInt(0);
                for(double[] v:polys[i]){out.writeFloat((float)v[0]);out.writeFloat((float)v[1]);out.writeFloat(v.length>2?(float)v[2]:0);}
                for(int next:links[i])out.writeInt(next);
            }
        }
    }
    static PedNavigation corridor(Path file)throws Exception{
        // Two rectangles meet at a turn; the missing square (x>4,y<4) is a wall.
        double[][][] triangles={{{0,0},{4,0},{4,4}},{{0,0},{4,4},{0,4}},
            {{0,4},{4,4},{4,8}},{{0,4},{4,8},{0,8}},{{4,4},{8,4},{8,8}},{{4,4},{8,8},{4,8}}};
        int[][] links={{-1,-1,1},{0,2,-1},{1,5,3},{2,-1,-1},{-1,-1,5},{4,-1,2}};
        fixture(file,triangles,links);return PedNavigation.load(file);
    }
    static void wall(Path file)throws Exception{
        PedNavigation nav=corridor(file);Route route=nav.route(p(3.8,.2),p(7.8,4.2),1,100);
        check(route.reached(),"Portal corridor should be reachable");check(route.points().size()>3,"Wall route cannot become a direct chord");
        double length=0;
        for(int i=1;i<route.points().size();i++){
            Point a=route.points().get(i-1),b=route.points().get(i);length+=a.distance(b);
            for(int j=0;j<=20;j++){
                double t=j/20.;Point point=new Point(a.x()+(b.x()-a.x())*t,a.y()+(b.y()-a.y())*t,0);
                check(point.x()<=4.00001 || point.y()>=3.99999,"Route cut through the wall");
                check(nav.nearest(point,.0001)!=null,"Every route segment remains on an actual navigation face");
            }
        }
        check(length>p(3.8,.2).distance(p(7.8,4.2)),"Must go around the obstruction");
        check(nav.route(p(3.8,.2),p(7.8,4.2),1,1).reason().equals("visit_budget"),"Bound route search CPU");
        boolean immutable=false;try{route.points().clear();}catch(UnsupportedOperationException expected){immutable=true;}
        check(immutable,"Route callers cannot modify shared decisions");
    }
    static void snap(Path file)throws Exception{
        PedNavigation nav=corridor(file);
        Snap hit=nav.nearest(new Point(1,1,1),1.001);check(hit!=null && Math.abs(hit.distance()-1)<1e-6,"Snap onto terrain surface");
        check(hit.position().z()==0,"Keep mesh height instead of copying the player's z");
        check(nav.nearest(new Point(1,1,4),1)==null,"Do not teleport between separated storeys");
        check(!nav.route(p(50,50),p(1,1),1,100).reached(),"Outside coverage cannot use straight-line fallback");
        Route same=nav.route(p(3,1),p(2,1),1,100);check(same.reached() && same.points().size()==2,"Same convex face uses its safe segment");
        check(!PedNavigation.empty().route(p(0,0),p(1,1),4,100).reached(),"Missing navmesh freezes movement");
    }
    static void disconnected(Path file)throws Exception{
        fixture(file,new double[][][]{{{0,0},{4,0},{0,4}},{{10,0},{14,0},{10,4}}},new int[][]{{-1,-1,-1},{-1,-1,-1}});
        PedNavigation nav=PedNavigation.load(file);
        check(nav.route(p(1,1),p(11,1),1,100).reason().equals("no_route"),"Separated islands cannot be bridged by proximity");
    }
    static void malformed(Path file)throws Exception{
        fixture(file,new double[][][]{{{0,0},{4,0},{0,4}},{{10,0},{14,0},{10,4}}},new int[][]{{1,-1,-1},{-1,-1,-1}});
        boolean failed=false;try{PedNavigation.load(file);}catch(IOException expected){failed=true;}
        check(failed,"Reject adjacency with no physical shared portal");
        corridor(file);Files.write(file,new byte[]{0},StandardOpenOption.APPEND);
        failed=false;try{PedNavigation.load(file);}catch(IOException expected){failed=true;}check(failed,"Reject trailing malformed data");
    }
    static void wander(Path file)throws Exception{
        PedNavigation nav=corridor(file);Route route=nav.wander(p(1,1),17,10);
        check(route.reached() && route.equals(nav.wander(p(1,1),17,10)),"Seeded reachable wander is deterministic");
        Point last=route.points().get(route.points().size()-1);check(last.distance(p(1,1))<=10,"Wander radius bounded");
        check(nav.status().get("source").equals("local_ynv_polygons"),"Expose actual pedestrian provenance");
    }
    static void detour(Path file)throws Exception{
        // A complete square has two routes around the first obstructed portal.
        fixture(file,new double[][][]{{{0,0},{4,0},{2,2}},{{4,0},{4,4},{2,2}},
            {{4,4},{0,4},{2,2}},{{0,4},{0,0},{2,2}}},new int[][]{{-1,1,3},{-1,2,0},{-1,3,1},{-1,0,2}});
        PedNavigation nav=PedNavigation.load(file);Point from=p(2,.2),to=p(2,3.8);
        Route direct=nav.route(from,to,1,100),around=nav.detour(from,to,1,100);
        check(direct.reached() && around.reached(),"Safe alternate portal should be available");
        check(!direct.points().get(1).equals(around.points().get(1)),"Recovery must choose another first portal");
        corridor(file);nav=PedNavigation.load(file);
        check(!nav.detour(p(3.8,.2),p(7.8,4.2),1,100).reached(),"A blocked single corridor waits instead of looping the same path");
    }
    static void real(Path file)throws Exception{
        PedNavigation nav=PedNavigation.load(file);check(nav.polygonCount()>50000,"Expected actual local YNV export");
        Point spawn=new Point(711.5,-1088.08,22);Snap start=nav.nearest(spawn,4);
        check(start!=null,"Birth point must snap to real pedestrian mesh");
        int successes=0;
        for(int i=0;i<40;i++){Route route=nav.wander(spawn,i,18);if(route.reached()){
            successes++;for(Point point:route.points())check(nav.nearest(point,.06)!=null,"Real portal route left navigation geometry");
            // Exercise pathfinding between distinct native endpoint pairs,
            // not just isolated vertex decoding or one fixed spawn pair.
            Point other=route.points().get(route.points().size()-1);
            Route back=nav.route(other,spawn,4,12000);check(back.reached(),"Verified ordinary birth-zone adjacency should support return route");
        }}
        check(successes==40,"Birth-zone native mesh must offer reachable wandering");
        System.out.println("REAL "+nav.polygonCount()+" spawn="+start+" wander="+successes);
    }
    public static void main(String[] args)throws Exception{
        Path file=Path.of(args[1]);switch(args[0]){
            case "wall" -> wall(file);case "snap" -> snap(file);case "disconnected" -> disconnected(file);
            case "malformed" -> malformed(file);case "wander" -> wander(file);case "real" -> real(file);case "detour" -> detour(file);
            default -> throw new IllegalArgumentException(args[0]);
        }System.out.println("OK "+args[0]);
    }
}
'''


def ynv_fixture():
    data = bytearray(2048)
    def put(fmt, offset, *values):
        struct.pack_into("<" + fmt, data, offset, *values)
    def pointer(offset, target):
        put("Q", offset, 0x50000000 + target)
    put("I", 16, 1); put("3f", 96, 10, 10, 10); pointer(288, 368)
    put("3f", 368, 0, 0, 0); put("3f", 384, 10, 10, 10)
    put("II", 144, 3, 1); put("I", 152, 16383); put("III", 312, 3, 1, 1)
    for field, header, entries, start, size, rows in (
        (112, 512, 800, 1100, 6, [struct.pack("<3H", 0, 0, 0), struct.pack("<3H", 65535, 0, 0), struct.pack("<3H", 0, 65535, 0)]),
        (128, 560, 832, 1120, 2, [struct.pack("<H", i) for i in range(3)]),
        (136, 608, 848, 1136, 8, [b"\0" * 8] * 3),
        (280, 656, 864, 1168, 48, [b"\0" * 48]),
    ):
        pointer(field, header); put("I", header + 8, len(rows)); pointer(header + 16, entries)
        put("I", header + 32, 1); pointer(entries, start); put("I", entries + 8, len(rows))
        for i, row in enumerate(rows):
            data[start + i * size:start + (i + 1) * size] = row
    put("IHH", 1168, 3 << 21, 0, 1); put("6h", 1192, 0, 39, 0, 39, 0, 0)
    return data


class PedNavigationExportTests(unittest.TestCase):
    def test_recover_vertices_from_native_split_arrays(self):
        polygons = list(exporter.NavReader(ynv_fixture()).polygons())
        self.assertEqual(len(polygons), 1)
        self.assertAlmostEqual(polygons[0].vertices[1][0], 65535 / 65536 * 10)
        self.assertEqual(polygons[0].neighbors, [None, None, None])

    def test_invalid_pointer_and_world_origin_fail_closed(self):
        for offset, fmt, value in ((112, "Q", 0x70000000), (1168 + 24, "h", 500)):
            data = ynv_fixture(); struct.pack_into("<" + fmt, data, offset, value)
            with self.assertRaises(ValueError):
                list(exporter.NavReader(data).polygons())

    def test_nonstandard_connections_are_not_walked(self):
        data = ynv_fixture(); struct.pack_into("<I", data, 152, 1)
        struct.pack_into("<II", data, 1136, 0x300000 | (3 << 5), 0)
        self.assertIsNone(list(exporter.NavReader(data).polygons())[0].neighbors[0])

    def test_concave_native_polygon_is_decomposed_before_routing(self):
        polygon = exporter.Polygon(1, 0, 0, [(0, 0, 0), (4, 0, 0), (4, 2, 0), (2, 2, 0), (2, 4, 0), (0, 4, 0)], [None] * 6)
        mesh, omitted = exporter.build_mesh([polygon])
        self.assertEqual(len(mesh), 4)
        self.assertFalse(omitted)
        area = sum(abs(exporter.cross(*t["vertices"])) / 2 for t in mesh)
        self.assertAlmostEqual(area, 12)
        self.assertEqual(sum(n >= 0 for t in mesh for n in t["neighbors"]), 6)

    def test_exports_cannot_enter_selected_game_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); data = root / "player-game/data"; data.mkdir(parents=True)
            wasm = data.parent / "game.wasm"; wasm.write_bytes(b"unchanged")
            args = argparse.Namespace(data=data, wasm=wasm, output=data / "navigation.bin", bounds=[0, 0, 0, 10, 10, 10])
            with self.assertRaises(ValueError):
                exporter.export(args)
            link = root / "server-output"; link.symlink_to(data, target_is_directory=True)
            args.output = link / "navigation.bin"
            with self.assertRaises(ValueError):
                exporter.export(args)
            self.assertEqual(wasm.read_bytes(), b"unchanged")
            self.assertFalse((data / "navigation.bin").exists())

    def test_separately_selected_engine_game_root_is_protected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); data = root / "resource-game/data"; data.mkdir(parents=True)
            engine_root = root / "engine-game"; wasm = engine_root / "b/test-build/game.wasm"
            wasm.parent.mkdir(parents=True); wasm.write_bytes(b"original-engine")
            args = argparse.Namespace(data=data, wasm=wasm, output=engine_root / "data/navigation.bin", bounds=[0, 0, 0, 10, 10, 10])
            with self.assertRaises(ValueError):
                exporter.export(args)
            self.assertEqual(wasm.read_bytes(), b"original-engine")
            self.assertFalse(args.output.exists())


class PedNavigationJavaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="gta-ped-navigation-test-")
        cls.directory = Path(cls.temporary.name)
        harness = cls.directory / "PedNavigationHarness.java"; harness.write_text(HARNESS, encoding="utf-8")
        result = subprocess.run([JAVAC, "--release", "17", "-d", str(cls.directory),
            str(ROOT / "server/src/main/java/offline/multiplayer/PedNavigation.java"), str(harness)],
            capture_output=True, text=True, timeout=30)
        if result.returncode:
            cls.temporary.cleanup(); raise AssertionError(result.stdout + result.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def scenario(self, name, path=None):
        result = subprocess.run([JAVA, "-ea", "-cp", str(self.directory), "PedNavigationHarness", name,
                                str(path or self.directory / "fixture.bin")], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("OK " + name, result.stdout)
        if name == "real":
            print(result.stdout.strip())

    def test_portal_route_goes_around_wall(self):
        self.scenario("wall")

    def test_nearest_surface_keeps_floor_height(self):
        self.scenario("snap")

    def test_disconnected_islands_have_no_direct_fallback(self):
        self.scenario("disconnected")

    def test_malformed_adjacency_and_trailing_bytes_are_rejected(self):
        self.scenario("malformed")

    def test_wander_is_reachable_and_deterministic(self):
        self.scenario("wander")

    def test_stalled_portal_uses_safe_alternate_or_waits(self):
        self.scenario("detour")

    @unittest.skipUnless((ROOT / "server/world-data/ped-navigation.bin").exists(), "Requires separately derived local YNV navigation")
    def test_actual_local_birth_zone_navigation(self):
        self.scenario("real", ROOT / "server/world-data/ped-navigation.bin")


if __name__ == "__main__":
    unittest.main()
