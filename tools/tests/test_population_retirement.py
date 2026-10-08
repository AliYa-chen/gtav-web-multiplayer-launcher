#!/usr/bin/env python3
"""隔离 Java 服务夹具验证人口退役；测试时钟只在临时 JVM 内推进，不加生产测试接口。"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
JAR = ROOT / "server/multiplayer-world-experimental.jar"
JAVA = os.environ.get("JAVA", "java")
JAVAC = os.environ.get("JAVAC") or shutil.which("javac")

HARNESS = r'''
package offline.multiplayer;
import java.lang.reflect.*;
import java.util.*;
import offline.multiplayer.WorldRegistry.*;
import offline.multiplayer.WorldRegistry.Vector;

public final class PopulationRetirementHarness {
    static void check(boolean valid,String detail){if(!valid)throw new AssertionError(detail);}
    static Map<String,Object> map(Object...values){Map<String,Object> out=new LinkedHashMap<>();for(int i=0;i<values.length;i+=2)out.put((String)values[i],values[i+1]);return out;}
    static Field field(String name)throws Exception{Field f=WorldService.class.getDeclaredField(name);f.setAccessible(true);return f;}
    static void advance(WorldService service,long elapsed,long originalStarted)throws Exception{
        // 只改变本次测试 JVM 的单调时钟，不改变 Java 源码或公开 WebSocket 协议。
        field("started").setLong(service,originalStarted-elapsed*1_000_000L);
    }
    static Map<String,Object> transform(Transform t){return map("position",t.position().values(),"rotation",t.rotation().values(),"velocity",t.velocity().values(),"angular_velocity",t.angularVelocity().values());}
    static void playerState(WorldService service,String actor,long seq,Vector pos)throws Exception{
        CombatWorld.Outcome result=service.updateState(actor,map("type","player_state","seq",seq,"position",pos.values(),"heading",90,
            "model",0x705e61f2L,"health",200,"weapon",0xa2719263L,"shooting",false),service.now());
        check(result.accepted(),"正常附座样本被拒绝");
    }
    @SuppressWarnings("unchecked") static Set<String> cells(WorldService service)throws Exception{
        return new HashSet<>((Set<String>)field("populationCells").get(service));
    }
    static void retained(WorldRegistry registry,String carId,String playerId,String seat,long generation){
        Entity car=registry.entity(carId),player=registry.playerEntity(playerId);
        check(car!=null,"人口退役删除了玩家占用车辆的世界ID");
        check(player!=null,"人口退役删除了玩家实体");
        check(car.generation()==generation,"人口退役重新创建了另一车辆生命周期");
        check(player.components().attachment()!=null && carId.equals(player.components().attachment().entityId()),"人口退役破坏了玩家附件关系");
        check(player.entityId().equals(car.components().vehicle().seats().get(seat)),"人口退役破坏了车辆座位表");
        check(player.components().transform().equals(car.components().transform()),"附座玩家没有同一确认的车辆姿态");
    }
    public static void main(String[] args)throws Exception{
        String seat=args[0],actor="driver-fixture";WorldService service=new WorldService();
        long originalStarted=field("started").getLong(service);
        WorldRegistry registry=(WorldRegistry)field("registry").get(service);
        service.join(actor);service.worldParticipant(actor,true);
        Set<String> firstCell=cells(service);check(firstCell.size()==1,"初始人口格不是一个");
        Entity car=registry.snapshot().entities().stream().filter(e->e.kind()==Kind.VEHICLE && e.components().vehicle().seats().get("driver")!=null).findFirst().orElseThrow();
        String carId=car.entityId(),playerId=registry.playerEntity(actor).entityId();long generation=car.generation();
        Vector start=car.components().transform().position();playerState(service,actor,1,start);
        service.interaction(actor,map("type","interaction_request","world_epoch",service.epoch(),"request_id","join-fixture",
            "action","enter_vehicle","entity_id",carId,"seat",seat,"expected_revision",car.revision()));
        car=registry.entity(carId);
        service.ready(actor,map("type","entity_ready","world_epoch",service.epoch(),"entity_id",carId,"owner_epoch",car.ownerEpoch()));
        boolean full=false,retiredOther=false;Set<String> previous=cells(service);
        for(int step=1;step<=26;step++){
            advance(service,step*1000L,originalStarted);
            car=registry.entity(carId);
            Transform target=new Transform(new Vector(start.x()+step*100,start.y(),start.z()),car.components().transform().rotation(),new Vector(100,0,0),Vector.zero());
            service.entityInput(actor,map("type","entity_input","world_epoch",service.epoch(),"entity_id",carId,
                "owner_epoch",car.ownerEpoch(),"input_seq",step,"based_on_revision",car.revision(),"transform",transform(target)));
            // 真实服务入口忽略附座旧坐标，续玩家租约并触发新格生成/旧格退役。
            playerState(service,actor,step+1,start);
            service.maintain(service.now());
            Set<String> current=cells(service);full|=current.size()==8;
            retiredOther|=previous.stream().anyMatch(c->!current.contains(c) && !firstCell.contains(c));
            check(current.size()<=8,"人口格预算超过8");
            check(current.containsAll(firstCell),"旧出生格虽无人靠近，却含玩家车辆，不应整体退役");
            retained(registry,carId,actor,seat,generation);previous=current;
        }
        check(full,"没有真正触发8格预算边界");check(retiredOther,"没有触发其他无人旧格的实际退役");
        check(registry.playerEntity(actor).entityId().equals(playerId),"全程玩家世界ID不稳定");
        // 再让该车拥有无活跃参与者的租约并过期，验证只有座位关系也足以保护该格。
        car=registry.entity(carId);registry.grantOwnerTrusted(carId,"inactive-owner",car.revision(),service.now()+5000,service.now());
        advance(service,33000L,originalStarted);registry.expireLeasesTrusted(service.now());
        check(registry.entity(carId).ownerId()==null,"保护测试没有进入无模拟所有者分支");
        Method retire=WorldService.class.getDeclaredMethod("retireDistantCell",Vector.class);retire.setAccessible(true);
        int before=cells(service).size();retire.invoke(service,registry.entity(carId).components().transform().position());
        check(cells(service).size()<before,"无所有者测试未触发真实退役");
        check(cells(service).containsAll(firstCell),"无owner但有玩家座位时旧格被退役");
        retained(registry,carId,actor,seat,generation);
        System.out.println("OK "+seat);
    }
}
'''


class PopulationRetirementTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not JAVAC or not JAR.is_file():
            raise unittest.SkipTest("需要 JDK 与已构建的实验服务 JAR；此测试不自行修改生产源码")
        cls.temporary = tempfile.TemporaryDirectory(prefix="gta-population-retirement-")
        cls.classes = Path(cls.temporary.name) / "classes"; cls.classes.mkdir()
        source = Path(cls.temporary.name) / "PopulationRetirementHarness.java"
        source.write_text(HARNESS, encoding="utf-8")
        result = subprocess.run([JAVAC, "--release", "17", "-encoding", "UTF-8", "-cp", str(JAR), "-d", str(cls.classes), str(source)],
            capture_output=True, text=True, encoding="utf-8", timeout=20)
        if result.returncode:
            cls.temporary.cleanup()
            raise AssertionError("人口退役夹具编译失败：\n" + result.stdout + result.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def scenario(self, seat):
        result = subprocess.run([JAVA, "-ea", "-cp", str(self.classes) + os.pathsep + str(JAR),
            "offline.multiplayer.PopulationRetirementHarness", seat], capture_output=True, text=True, encoding="utf-8", timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("OK " + seat, result.stdout)

    def test_driver_keeps_old_cell_car_world_identity_after_eight_cells(self):
        self.scenario("driver")

    def test_passenger_keeps_old_cell_car_even_after_simulation_owner_expires(self):
        self.scenario("passenger:0")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jar", type=Path, default=JAR)
    parser.add_argument("--java", default=JAVA)
    parser.add_argument("--javac", default=JAVAC)
    args, remainder = parser.parse_known_args()
    JAR, JAVA, JAVAC = args.jar.expanduser().resolve(), args.java, args.javac
    unittest.main(argv=[sys.argv[0], *remainder])
