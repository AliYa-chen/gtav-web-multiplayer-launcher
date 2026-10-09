"""Run actual Java collision tickets through transparent material continuations."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
JAVA = os.environ.get('JAVA', shutil.which('java') or 'java')
JAVAC = os.environ.get('JAVAC', shutil.which('javac') or 'javac')
HARNESS = r'''
package offline.multiplayer;
import java.util.*;
import java.io.*;
import java.nio.file.*;
import offline.multiplayer.WorldRegistry.Vector;

public final class MaterialContinuationHarness {
  static final long CHAIN=MaterialCatalog.byIndex(61).nameHash(), TARP=MaterialCatalog.byIndex(85).nameHash();
  static void check(boolean yes,String why){if(!yes)throw new AssertionError(why);}
  static void near(double a,double b){check(Math.abs(a-b)<.00001,"Expected "+b+", got "+a);}
  static WorldCollision.Segment segment(double y){return new WorldCollision.Segment(new Vector(0,y,0),new Vector(10,y,0),.01);}
  static WorldCollision fresh(){WorldCollision c=new WorldCollision("test");c.observer("a",true);return c;}
  static Map<String,Object> hit(double x,double y,long material){return WorldService.map("position",List.of(x,y,0d),"normal",List.of(-1d,0d,0d),"material",material);}
  static Map<String,Object> reply(String ticket,List<?> hits){return WorldService.map("type","collision_result","schema_version",2,"world_epoch","test","query_id",ticket,"hits",hits,"complete",true);}
  static Map<String,Object> ticket(WorldCollision c){var out=c.drain();check(out.size()==1,"Exactly one continuation ticket");return out.get(0);}
  static String id(Map<String,Object> ticket){return (String)ticket.get("query_id");}
  static String begin(WorldCollision c,String purpose,List<WorldCollision.Segment> segments){return c.submit("a",purpose,segments,100);}
  static void reject(WorldCollision c,String actor,Map<String,Object> reply,long now,String code)throws Exception{
    try{c.accept(actor,reply,now);throw new AssertionError("Expected "+code);}catch(WorldService.Problem p){check(code.equals(p.code),p.code);}
  }
  static void wallAfterFence()throws Exception{
    var c=fresh();String root=begin(c,"shot",List.of(segment(0)));var first=ticket(c);
    c.accept("a",reply(root,List.of(hit(2,0,CHAIN))),200);
    check(c.take(root)==null,"Transparent hit cannot prematurely declare clear");var next=ticket(c);
    check(!root.equals(id(next)),"Continuation needs a fresh one-use ticket");
    check(first.get("expires_at").equals(next.get("expires_at")),"Continuation cannot extend root lease");
    var seg=(Map<?,?>)((List<?>)next.get("segments")).get(0);
    near(((Number)((List<?>)seg.get("from")).get(0)).doubleValue(),2.03);
    reject(c,"a",reply(root,List.of(hit(3,0,1))),201,"stale_collision");
    reject(c,"other",reply(id(next),List.of(hit(5,0,1))),201,"stale_collision");
    reject(c,"a",reply(id(next),List.of(hit(1,0,1))),201,"invalid_collision");
    c.accept("a",reply(id(next),List.of(hit(5,0,1))),202);
    var result=c.take(root);check(result.complete(),"Opaque hit completes root");near(result.hits().get(0).position().x(),5);
    check(c.take(id(next))==null,"Results use original root id only");
  }
  static void batches()throws Exception{
    var c=fresh();String root=begin(c,"shot",List.of(segment(0),segment(2)));ticket(c);
    c.accept("a",reply(root,List.of(hit(2,0,CHAIN),hit(3,2,1))),200);
    var next=ticket(c);check(((List<?>)next.get("segments")).size()==1,"Only unresolved segment is queried again");
    c.accept("a",reply(id(next),Collections.singletonList(null)),201);
    var result=c.take(root);check(result.complete()&&result.hits().size()==2,"Preserve root result slots");
    check(result.hits().get(0)==null,"Clear continuation confirms no opaque blocker");near(result.hits().get(1).position().x(),3);
  }
  static void purposes()throws Exception{
    for(String purpose:List.of("shot","visibility","projectile")){
      var c=fresh();String root=begin(c,purpose,List.of(segment(0)));ticket(c);
      c.accept("a",reply(root,List.of(hit(2,0,TARP))),200);
      if(purpose.equals("shot")){var next=ticket(c);c.accept("a",reply(id(next),Collections.singletonList(null)),201);check(c.take(root).hits().get(0)==null,"SHOOT_THRU shot clear");}
      else{check(c.drain().isEmpty(),"Non-see-through tarp blocks "+purpose);check(c.take(root).hits().get(0)!=null,"Tarp blocker retained");}
    }
    var c=fresh();String root=begin(c,"visibility",List.of(segment(0)));ticket(c);c.accept("a",reply(root,List.of(hit(2,0,CHAIN))),200);
    var next=ticket(c);c.accept("a",reply(id(next),Collections.singletonList(null)),201);check(c.take(root).complete(),"SEE_THRU continuation");
    c=fresh();root=begin(c,"shot",List.of(segment(0)));ticket(c);c.accept("a",reply(root,List.of(hit(2,0,0xffffffffL))),200);
    check(c.take(root).hits().get(0)!=null&&c.drain().isEmpty(),"Unknown material is opaque");
  }
  static void bounded()throws Exception{
    var c=fresh();String root=begin(c,"shot",List.of(segment(0)));var q=ticket(c);
    for(int layer=0;layer<9;layer++){
      c.accept("a",reply(id(q),List.of(hit(layer+1,0,CHAIN))),200+layer);
      if(layer<8){check(c.take(root)==null,"Layer cannot finalize pending root");q=ticket(c);}
    }
    check(!c.take(root).complete()&&c.drain().isEmpty(),"Ninth transparent layer fails closed");
    c=fresh();root=begin(c,"shot",List.of(segment(0)));ticket(c);c.accept("a",reply(root,List.of(hit(9.99,0,CHAIN))),200);
    check(!c.take(root).complete(),"Insufficient terminal space cannot assert clear");
    c=fresh();root=begin(c,"shot",List.of(segment(0)));ticket(c);c.accept("a",reply(root,List.of(hit(2,0,CHAIN))),200);q=ticket(c);
    c.tick(1601);check(!c.take(root).complete(),"All continuation shares original expiry");reject(c,"a",reply(id(q),Collections.singletonList(null)),1602,"stale_collision");
  }
  static void cleanup()throws Exception{
    for(boolean disconnect:List.of(false,true)){
      var c=fresh();String root=begin(c,"shot",List.of(segment(0)));ticket(c);c.accept("a",reply(root,List.of(hit(2,0,CHAIN))),200);
      if(disconnect){c.observer("a",false);check(!c.take(root).complete(),"Disconnect finishes original root");}
      else{c.discard(root);check(c.take(root)==null,"Discard removes root result");}
      check(c.drain().isEmpty(),"Cleanup removes unsent continuation");check(((Number)c.status().get("pending_queries")).intValue()==0,"No orphan ticket");
    }
  }
  static Path geometry(double wallX)throws Exception{
    Path file=Files.createTempFile("material-wall-",".bin");
    try(var out=new DataOutputStream(Files.newOutputStream(file))){out.writeBytes("GTACOL1\n");
      for(double x:new double[]{0,-2,-2,10,2,2})out.writeDouble(x);out.writeInt(2);
      for(double[] t:new double[][]{{2,-2,-2,2,2,-2,2,0,2},{wallX,-2,-2,wallX,2,-2,wallX,0,2}}){
        for(double x:t)out.writeFloat((float)x);out.writeInt(t[0]==2?61:1);
      }
    }return file;
  }
  static void staticMerge()throws Exception{
    Path file=geometry(8);
    try{
      var c=fresh();c.geometry(StaticCollision.load(file));String root=begin(c,"shot",List.of(segment(0)));ticket(c);
      c.accept("a",reply(root,List.of(hit(2,0,CHAIN))),200);var next=ticket(c);
      c.accept("a",reply(id(next),Collections.singletonList(null)),201);
      near(c.take(root).hits().get(0).position().x(),8);
      c=fresh();c.geometry(StaticCollision.load(file));root=begin(c,"shot",List.of(segment(0)));ticket(c);
      c.accept("a",reply(root,List.of(hit(9,0,1))),200);near(c.take(root).hits().get(0).position().x(),8);
      c=new WorldCollision("test");c.geometry(StaticCollision.load(file));root=begin(c,"shot",List.of(segment(0)));
      near(c.take(root).hits().get(0).position().x(),8);check(c.drain().isEmpty(),"Static-only uses purpose filtering");
    }finally{Files.delete(file);}
    file=geometry(2.01);try{var c=fresh();c.geometry(StaticCollision.load(file));String root=begin(c,"shot",List.of(segment(0)));ticket(c);
      c.accept("a",reply(root,List.of(hit(2,0,CHAIN))),200);near(c.take(root).hits().get(0).position().x(),2.01);
      check(c.drain().isEmpty(),"Epsilon advance cannot jump a known opaque wall");
    }finally{Files.delete(file);}
  }
  public static void main(String[] args)throws Exception{
    switch(args[0]){case "wall"->wallAfterFence();case "batch"->batches();case "purpose"->purposes();case "bounded"->bounded();case "cleanup"->cleanup();case "static"->staticMerge();default->throw new AssertionError();}
  }
}
'''


class CollisionMaterialContinuationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='gta-material-continuation-')
        cls.work = Path(cls.temp.name)
        fixture = cls.work / 'MaterialContinuationHarness.java'
        fixture.write_text(HARNESS)
        sources = sorted((ROOT / 'server/src/main/java').rglob('*.java'))
        result = subprocess.run([JAVAC, '--release', '17', '-d', str(cls.work), *map(str, sources), str(fixture)], capture_output=True, text=True)
        if result.returncode:
            raise AssertionError(result.stdout + result.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def run_case(self, case):
        result = subprocess.run([JAVA, '-cp', str(self.work), 'offline.multiplayer.MaterialContinuationHarness', case], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_wall_behind_fence_and_ticket_validation(self): self.run_case('wall')
    def test_mixed_batch_preserves_original_slots(self): self.run_case('batch')
    def test_shoot_and_see_flags_are_purpose_specific(self): self.run_case('purpose')
    def test_layer_limit_terminal_gap_and_expiry_fail_closed(self): self.run_case('bounded')
    def test_disconnect_and_discard_clear_continuation(self): self.run_case('cleanup')
    def test_static_opaque_surface_remains_authoritative(self): self.run_case('static')


if __name__ == '__main__':
    unittest.main()
