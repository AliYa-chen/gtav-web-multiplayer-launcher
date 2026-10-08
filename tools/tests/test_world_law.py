#!/usr/bin/env python3
"""编译临时 Java harness，验证共同警察规则及真实 WorldService 提交，不运行游戏或部署。"""
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
import java.lang.reflect.*;
import java.util.*;
import offline.multiplayer.WorldRegistry.*;
import offline.multiplayer.WorldRegistry.Vector;

public final class WorldLawHarness {
    static final long PISTOL=WorldLaw.POLICE_WEAPON;
    interface Checked {void run()throws Exception;}
    static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
    static void denied(String code,Checked call)throws Exception{
        try{call.run();throw new AssertionError("Expected "+code);}
        catch(WorldService.Problem problem){check(code.equals(problem.code),"Wrong rejection "+problem.code);}
        catch(WorldRegistry.Rejection problem){check(code.equals(problem.code),"Wrong registry rejection "+problem.code);}
    }
    static WorldRegistry registry(WorldService service)throws Exception{
        Field field=WorldService.class.getDeclaredField("registry");field.setAccessible(true);return(WorldRegistry)field.get(service);
    }
    static WorldLaw law(WorldService service)throws Exception{
        Field field=WorldService.class.getDeclaredField("law");field.setAccessible(true);return(WorldLaw)field.get(service);
    }
    static void state(WorldService service,String player,long sequence)throws Exception{
        Entity entity=service.player(player);
        service.updateState(player,WorldService.map("seq",sequence,"position",entity.components().transform().position().values(),
            "heading",90,"model",entity.model(),"health",200,"weapon",PISTOL,"shooting",false),0);
    }
    static WorldService setup()throws Exception{
        WorldService service=new WorldService();service.join("p1");service.join("p2");
        state(service,"p1",1);state(service,"p2",1);
        service.worldParticipant("p1",true);service.worldParticipant("p2",true);return service;
    }
    static List<Entity> responses(WorldService service)throws Exception{
        WorldLaw law=law(service);return registry(service).snapshot().entities().stream()
            .filter(e->law.responseForEntity(e.entityId())!=null).toList();
    }
    static Entity officer(WorldService service)throws Exception{
        return responses(service).stream().filter(e->e.kind()==Kind.PED).findFirst().orElseThrow();
    }
    static void shot(WorldService service)throws Exception{
        Entity player=service.player("p1");Vector p=player.components().transform().position();
        service.shoot("p1",WorldService.map("seq",1,"origin",List.of(p.x(),p.y(),p.z()+.7),
            "target",List.of(p.x(),p.y()-25,p.z()+.7),"weapon",PISTOL),0);
    }
    static void ready(WorldService service,Entity entity)throws Exception{
        service.ready(entity.ownerId(),WorldService.map("type","entity_ready","world_epoch",service.epoch(),
            "entity_id",entity.entityId(),"owner_epoch",entity.ownerEpoch()));
    }
    static Entity activeOfficer(WorldService service)throws Exception{
        shot(service);Entity officer=officer(service);
        registry(service).releaseNpcSeatTrusted(officer.entityId(),service.now());
        officer=registry(service).entity(officer.entityId());ready(service,officer);
        officer=registry(service).entity(officer.entityId());
        service.entityInput(officer.ownerId(),WorldService.map("type","entity_input","world_epoch",service.epoch(),
            "entity_id",officer.entityId(),"owner_epoch",officer.ownerEpoch(),"input_seq",1,
            "based_on_revision",officer.revision(),"transform",WorldService.map("position",officer.components().transform().position().values(),
                "rotation",officer.components().transform().rotation().values(),"velocity",List.of(0,0,0),"angular_velocity",List.of(0,0,0))));
        return registry(service).entity(officer.entityId());
    }
    static Map<String,Object> npcShot(WorldService service,Entity officer,long sequence){
        Entity target=service.player("p1");
        return WorldService.map("type","simulation_result","world_epoch",service.epoch(),"entity_id",officer.entityId(),
            "owner_epoch",officer.ownerEpoch(),"input_seq",sequence,"kind","npc_shot",
            "target_entity_id",target.entityId(),"target_generation",target.generation());
    }
    static void responseReadyAndDamage()throws Exception{
        WorldService service=setup();shot(service);List<Entity> response=responses(service);
        check(response.size()==3,"One authoritative response set");
        Entity cop=officer(service);Map<String,Object> input=npcShot(service,cop,2);
        denied("stale_owner",()->service.simulation(cop.ownerId(),input));
        registry(service).releaseNpcSeatTrusted(cop.entityId(),service.now());ready(service,cop);
        Entity active=registry(service).entity(cop.entityId());
        denied("invalid_target",()->service.simulation(active.ownerId(),npcShot(service,active,2)));
        service.entityInput(active.ownerId(),WorldService.map("type","entity_input","world_epoch",service.epoch(),"entity_id",active.entityId(),
            "owner_epoch",active.ownerEpoch(),"input_seq",1,"based_on_revision",active.revision(),"transform",WorldService.map(
                "position",active.components().transform().position().values(),"rotation",active.components().transform().rotation().values(),
                "velocity",List.of(0,0,0),"angular_velocity",List.of(0,0,0))));
        Entity verified=registry(service).entity(cop.entityId());
        List<Map<String,Object>> events=service.simulation(verified.ownerId(),npcShot(service,verified,2));
        check(service.player("p1").components().combat().health()==190,"One authoritative ten-point hit");
        check(events.stream().anyMatch(e->"world_shot_event".equals(e.get("type"))),"One shared visual shot event");
        denied("stale_input",()->service.simulation(verified.ownerId(),npcShot(service,verified,2)));
        denied("rate_limited",()->service.simulation(verified.ownerId(),npcShot(service,verified,3)));
        check(service.player("p1").components().combat().health()==190,"Replay/cooldown cannot duplicate damage");
        check(((Number)law(service).wanted("p2").get("stars")).intValue()==0,"NPC hit is not a player crime");
    }
    static void targetAndOwnerFencing()throws Exception{
        WorldService service=setup();Entity cop=activeOfficer(service);
        Map<String,Object> forged=npcShot(service,cop,2);Entity other=service.player("p2");
        forged.put("target_entity_id",other.entityId());forged.put("target_generation",other.generation());
        denied("stale_generation",()->service.simulation(cop.ownerId(),forged));
        String otherOwner="p1".equals(cop.ownerId())?"p2":"p1";
        denied("stale_owner",()->service.simulation(otherOwner,npcShot(service,cop,2)));
        Map<String,Object> old=npcShot(service,cop,2);old.put("target_generation",service.player("p1").generation()+1);
        denied("stale_generation",()->service.simulation(cop.ownerId(),old));
        WorldRegistry world=registry(service);world.revokeOwnerTrusted(cop.entityId(),cop.revision(),service.now());
        denied("stale_owner",()->service.simulation(cop.ownerId(),npcShot(service,cop,2)));
    }
    static void lawMetadataDelta()throws Exception{
        WorldService service=setup();activeOfficer(service);Set<String> scope=new LinkedHashSet<>();
        List<Map<String,Object>> messages=service.snapshotMessages("p2",scope,0);
        Map<String,Object> end=messages.get(messages.size()-1);
        long revision=((Number)end.get("cut_revision")).longValue();
        long env=((Number)((Map<?,?>)end.get("environment")).get("revision")).longValue();
        long previousLaw=((Number)((Map<?,?>)end.get("law")).get("revision")).longValue();
        Entity old=officer(service);WorldLaw law=law(service);Entity actor=service.player("p1"),victim=service.player("p2");
        check(law.reportAcceptedDamage(actor,victim,1,service.now()),"Accepted crime changes only law metadata");
        Map<String,Object> delta=service.delta("p2",scope,revision,env,previousLaw,1);
        check(delta!=null,"Law-only change emits continuous delta");
        @SuppressWarnings("unchecked") List<Map<String,Object>> values=(List<Map<String,Object>>)delta.get("entities");
        Map<String,Object> metadata=values.stream().filter(e->old.entityId().equals(e.get("entity_id"))).findFirst().orElseThrow();
        check(((Number)metadata.get("revision")).longValue()==old.revision(),"Metadata does not forge Registry revision");
        check(((Number)metadata.get("task_revision")).longValue()>previousLaw,"Independent task revision advances");
        check(((Number)delta.get("stream_seq")).longValue()==1,"Law-only delta uses connection stream sequence");
    }
    static void arrestAndDeathSeat()throws Exception{
        WorldService service=setup();Entity player=service.player("p1");
        Map<String,Object> life=WorldService.map("type","simulation_result","world_epoch",service.epoch(),"entity_id",player.entityId(),
            "owner_epoch",player.ownerEpoch(),"input_seq",1,"kind","life_report","reason","arrest","health",0);
        denied("unconfirmed_arrest",()->service.simulation("p1",life));
        check(service.player("p1").components().combat().health()==200,"Local arrest cannot decide death");
        WorldRegistry world=registry(service);Entity car=world.snapshot().entities().stream()
            .filter(e->e.kind()==Kind.VEHICLE && e.components().vehicle().seats().get("driver")==null).findFirst().orElseThrow();
        world.enterSeat("p1",player.entityId(),player.ownerEpoch(),car.entityId(),"driver",car.revision(),service.now());
        player=service.player("p1");life.put("reason","dead");life.put("owner_epoch",player.ownerEpoch());
        service.simulation("p1",life);
        check(service.player("p1").components().attachment()==null,"Death life report detaches driver atomically");
        check(world.entity(car.entityId()).components().vehicle().seats().get("driver")==null,"Death releases shared driver seat");
        check(world.entity(car.entityId()).ownerId()==null,"Death revokes vehicle lease");
    }
    static void validArrestNeedsRealInput()throws Exception{
        WorldService service=setup();Entity cop=activeOfficer(service);WorldRegistry world=registry(service);
        Entity original=service.player("p1");Vector p=cop.components().transform().position();
        world.projectPlayerTrusted("p1",original.model(),Transform.at(new Vector(p.x()+1,p.y(),p.z()),90),
            original.components().ped(),original.components().combat(),service.now());
        Entity target=service.player("p1");
        check(law(service).reportArrestCandidate(target,target.generation(),world.snapshot().entities(),service.now()),"Wanted with confirmed nearby officer can be arrested");
        check(!law(service).reportArrestCandidate(target,target.generation()+1,world.snapshot().entities(),service.now()),"Old/new mismatched generation cannot arrest");
        world.revokeOwnerTrusted(cop.entityId(),world.entity(cop.entityId()).revision(),service.now());
        check(!law(service).reportArrestCandidate(target,target.generation(),world.snapshot().entities(),service.now()),"Unleased officer cannot confirm arrest");
    }
    static void stolenPoliceVehicleKeepsSeatAuthority()throws Exception{
        WorldService service=setup();shot(service);WorldRegistry world=registry(service);
        Entity car=responses(service).stream().filter(e->e.kind()==Kind.VEHICLE).findFirst().orElseThrow();
        Entity thief=service.player("p2");Vector point=car.components().transform().position();
        world.projectPlayerTrusted("p2",thief.model(),Transform.at(new Vector(point.x()+1,point.y(),point.z()),90),
            thief.components().ped(),thief.components().combat(),service.now());thief=service.player("p2");
        world.enterSeat("p2",thief.entityId(),thief.ownerEpoch(),car.entityId(),"driver",car.revision(),service.now());
        Entity stolen=world.entity(car.entityId());
        WorldLaw law=law(service);Entity target=service.player("p1");
        // 调度进入frozen仍不得撤销独立座位事务已授予的玩家驾驶权。
        service.worldParticipant("p1",false);service.worldParticipant("p2",false);
        service.maintain(0);stolen=world.entity(car.entityId());
        check("p2".equals(stolen.ownerId()),"Law freeze does not confiscate player-driven car");
        check(stolen.components().vehicle().seats().get("driver").equals(thief.entityId()),"Driver seat remains unique");
        check(law.clearAfterRedeploy("p1",target.generation()+1,service.now()),"Response target leaves prior lifecycle");
        service.maintain(0);Entity retained=world.entity(car.entityId());
        check(retained!=null && "p2".equals(retained.ownerId()),"Retiring cops retains occupied shared vehicle");
        check(!service.entity(retained).containsKey("law_response"),"Retained car no longer carries retired law task");
        check(retained.revision()>stolen.revision(),"Removing metadata republishes Registry entity");
        check(service.player("p2").components().attachment().entityId().equals(car.entityId()),"Retire does not eject player passenger/driver");
    }
    static Entity fake(String id,String player,long generation,Vector position){
        return new Entity(id,Kind.PED,0x705e61f2L,player,1,generation,player,1,100000,0,
            Components.ped(Transform.at(position,90),new PedView(null,Actions.idle(),PISTOL,false,null),new Combat(200,200,0,0,0)));
    }
    static void budgetAndSpawnLanes(){
        WorldLaw law=new WorldLaw("budget");List<Entity> players=new ArrayList<>();Set<String> owners=new LinkedHashSet<>();
        for(int i=0;i<9;i++){Entity player=fake("w:budget:"+(i+1),"p"+i,1,new Vector(700+i,-1088,22.4));
            players.add(player);owners.add(player.playerId());law.reportAcceptedShot(player,PISTOL,player.components().transform().position(),1000);}
        List<WorldLaw.DispatchDecision> decisions=law.tick(1000,players,owners,256-players.size());
        check(decisions.size()==8,"Eight response groups maximum");Set<Vector> lanes=new HashSet<>();
        for(WorldLaw.DispatchDecision value:decisions){check(value.spawns().size()==3,"Exactly one car plus two cops");lanes.add(value.spawns().get(0).position());}
        check(lanes.size()==8,"Shared response vehicles use distinct lanes");
        WorldLaw limited=new WorldLaw("limited");Entity player=fake("w:limited:1","p",1,new Vector(711.5,-1088,22.4));
        limited.reportAcceptedShot(player,PISTOL,player.components().transform().position(),1000);
        check(limited.tick(1000,List.of(player),Set.of("p"),2).isEmpty(),"Insufficient capacity never partially dispatches");
    }
    static void freezeAndGenerationRetire(){
        WorldLaw law=new WorldLaw("fence");Entity first=fake("w:fence:1","p1",1,new Vector(711.5,-1088,22.4));
        law.reportAcceptedShot(first,PISTOL,first.components().transform().position(),1000);
        WorldLaw.DispatchDecision spawn=law.tick(1000,List.of(first),Set.of("p1"),10).get(0);
        check(law.dispatchCommitted(spawn.responseId(),List.of("w:fence:2","w:fence:3","w:fence:4"),1001),"Response binds actual IDs");
        Entity car=new Entity("w:fence:2",Kind.VEHICLE,WorldLaw.POLICE_MODEL,null,1,1,null,1,0,-1,
            Components.vehicle(Transform.at(spawn.spawns().get(0).position(),90),Vehicle.empty(3)));
        List<WorldLaw.DispatchDecision> frozen=law.tick(2001,List.of(first,car),Set.of(),10);
        check(frozen.size()==1 && "freeze".equals(frozen.get(0).action()),"No simulator freezes shared response");
        check(law.clearAfterRedeploy("p1",2,2002),"New server lifecycle clears wanted");
        check(!law.clearAfterRedeploy("p1",1,2002),"Old lifecycle cannot clear wanted");
        Entity next=fake(first.entityId(),"p1",2,first.components().transform().position());
        List<WorldLaw.DispatchDecision> retired=law.tick(2003,List.of(next,car),Set.of("p1"),10);
        check(retired.size()==1 && "retire".equals(retired.get(0).action()),"New generation retires whole old response");
    }
    public static void main(String[] args)throws Exception{
        switch(args[0]){
            case "damage"->responseReadyAndDamage();case "fencing"->targetAndOwnerFencing();
            case "metadata"->lawMetadataDelta();case "seat"->arrestAndDeathSeat();
            case "arrest"->validArrestNeedsRealInput();case "budget"->budgetAndSpawnLanes();
            case "freeze"->freezeAndGenerationRetire();case "stolen"->stolenPoliceVehicleKeepsSeatAuthority();default->throw new AssertionError("Unknown scenario");
        }
        System.out.println("PASS "+args[0]);
    }
}
'''


class WorldLawTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="gta5-world-law-test-")
        cls.directory = Path(cls.temp.name)
        source = cls.directory / "WorldLawHarness.java"
        source.write_text(HARNESS, encoding="utf-8")
        sources = sorted((ROOT / "server/src/main/java").rglob("*.java"))
        result = subprocess.run([JAVAC, "--release", "17", "-encoding", "UTF-8", "-d", str(cls.directory),
                                 *map(str, sources), str(source)], capture_output=True, text=True, timeout=40)
        if result.returncode:
            cls.temp.cleanup()
            raise AssertionError(result.stdout + result.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def scenario(self, name):
        result = subprocess.run([JAVA, "-cp", str(self.directory), "offline.multiplayer.WorldLawHarness", name],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PASS " + name, result.stdout)

    def test_ready_before_authoritative_npc_damage_and_replay_cooldown(self): self.scenario("damage")
    def test_target_generation_and_lease_fencing(self): self.scenario("fencing")
    def test_law_only_metadata_in_continuous_delta(self): self.scenario("metadata")
    def test_unconfirmed_arrest_and_atomic_death_seat_release(self): self.scenario("seat")
    def test_arrest_requires_current_confirmed_shared_officer(self): self.scenario("arrest")
    def test_dispatch_capacity_and_distinct_parking_lanes(self): self.scenario("budget")
    def test_freeze_and_new_lifecycle_retires_old_response(self): self.scenario("freeze")
    def test_stolen_police_car_keeps_player_seat_and_lease(self): self.scenario("stolen")


if __name__ == "__main__":
    unittest.main(verbosity=2)
