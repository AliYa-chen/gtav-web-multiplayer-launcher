package offline.multiplayer;

import java.util.*;
import offline.multiplayer.WorldRegistry.Vector;

/** Server-owned, bounded geometry queries. Native observers supply geometry only, never damage. */
final class WorldCollision {
    record Segment(Vector from,Vector to,double radius) {
        Segment { if(from==null || to==null || from.distance(to)>1600 || !Double.isFinite(radius) || radius<0 || radius>1)
            throw new IllegalArgumentException("Invalid collision segment"); }
        Map<String,Object> values(){return WorldService.map("from",from.values(),"to",to.values(),"radius",radius);}
    }
    record Hit(Vector position,Vector normal,long material) {}
    record Result(boolean complete,List<Hit> hits) {}
    private static final int MAX_TRANSPARENT_LAYERS=8;
    private static final class RootQuery {
        final String id,actor,purpose;
        final List<Segment> segments;
        final Hit[] hits;
        final long expires;
        RootQuery(String id,String actor,String purpose,List<Segment> segments,long expires){
            this.id=id;this.actor=actor;this.purpose=purpose;this.segments=List.copyOf(segments);
            this.hits=new Hit[segments.size()];this.expires=expires;
        }
    }
    private record Query(String id,String actor,String observer,String purpose,List<Segment> segments,
                         List<Integer> slots,List<Integer> depths,RootQuery root,long expires) {}
    private final String epoch;
    private final Set<String> observers=new LinkedHashSet<>();
    private final Map<String,Query> pending=new LinkedHashMap<>();
    private final Map<String,RootQuery> roots=new LinkedHashMap<>();
    private final Map<String,Result> results=new LinkedHashMap<>();
    private final List<Map<String,Object>> outgoing=new ArrayList<>();
    private StaticCollision geometry=StaticCollision.empty();
    private long sequence,completed,rejected,timedOut;
    WorldCollision(String epoch){this.epoch=epoch;}
    void geometry(StaticCollision value){geometry=Objects.requireNonNull(value);}
    boolean hasGeometry(){return ((Number)geometry.metadata().get("triangles")).intValue()>0;}
    Hit first(Segment segment){return geometry.first(segment);}
    Hit first(Segment segment,String purpose){return geometry.first(segment,purpose);}
    void observer(String actor,boolean enabled){
        if(enabled)observers.add(actor);else {
            observers.remove(actor);
            for(Query query:new ArrayList<>(pending.values()))if(query.observer.equals(actor))finish(query.root,new Result(false,List.of()));
        }
    }
    boolean enabled(String actor){return observers.contains(actor);}
    String submit(String actor,String purpose,List<Segment> segments,long now){
        if(segments.isEmpty() || segments.size()>16)throw new IllegalArgumentException("Invalid query size");
        if(!enabled(actor)){
            List<Hit> hits=segments.stream().map(segment->geometry.first(segment,purpose)).toList();
            if(hits.stream().allMatch(Objects::isNull))return null;
            String id="q:"+epoch+":"+(++sequence);results.put(id,new Result(true,hits));return id;
        }
        if(pending.size()>=512 || pending.values().stream().filter(q->q.actor.equals(actor)).count()>=64)
            return failed();
        String id="q:"+epoch+":"+(++sequence);
        RootQuery root=new RootQuery(id,actor,purpose,segments,now+1500);roots.put(id,root);
        List<Integer> slots=new ArrayList<>(),depths=new ArrayList<>();
        for(int i=0;i<segments.size();i++){slots.add(i);depths.add(0);}
        issue(id,root,segments,slots,depths,now);
        return id;
    }
    private void issue(String id,RootQuery root,List<Segment> segments,List<Integer> slots,List<Integer> depths,long now){
        Query query=new Query(id,root.actor,root.actor,root.purpose,List.copyOf(segments),List.copyOf(slots),List.copyOf(depths),root,root.expires);
        pending.put(id,query);
        outgoing.add(WorldService.map("type","collision_query","schema_version",2,"world_epoch",epoch,
            "query_id",id,"observer_id",root.actor,"purpose",root.purpose,"segments",segments.stream().map(Segment::values).toList(),
            "issued_at",now,"expires_at",query.expires));
    }
    private String failed(){String id="q:"+epoch+":"+(++sequence);results.put(id,new Result(false,List.of()));return id;}
    List<Map<String,Object>> drain(){List<Map<String,Object>> messages=List.copyOf(outgoing);outgoing.clear();return messages;}
    Result take(String id){return results.remove(id);}
    void discard(String id){if(id!=null){RootQuery root=roots.get(id);if(root!=null)removeRoot(root);results.remove(id);}}
    void tick(long now){for(Query query:new ArrayList<>(pending.values()))if(now>query.expires){timedOut++;finish(query.root,new Result(false,List.of()));}}
    private void removeRoot(RootQuery root){
        roots.remove(root.id);
        Set<String> removed=new HashSet<>();
        pending.entrySet().removeIf(entry->{if(entry.getValue().root==root){removed.add(entry.getKey());return true;}return false;});
        outgoing.removeIf(message->removed.contains(message.get("query_id")));
    }
    private void finish(RootQuery root,Result result){removeRoot(root);results.put(root.id,result);while(results.size()>1024)results.remove(results.keySet().iterator().next());}
    void accept(String actor,Map<String,Object> input,long now)throws WorldService.Problem {
        WorldService.fields(input,"type","schema_version","world_epoch","query_id","hits","complete","reason");
        if(input.containsKey("schema_version"))WorldService.integer(input.get("schema_version"),2,2);
        if(input.containsKey("reason"))WorldService.text(input.get("reason"),64);
        if(!epoch.equals(input.get("world_epoch")))throw new WorldService.Problem("wrong_world","碰撞结果属于其他战局");
        String id=WorldService.text(input.get("query_id"),160);Query query=pending.get(id);
        if(query==null || !query.observer.equals(actor) || now>query.expires){rejected++;throw new WorldService.Problem("stale_collision","碰撞查询已失效或不属于本客户端");}
        boolean complete=WorldService.bool(input.get("complete"));
        if(!complete){finish(query.root,new Result(false,List.of()));return;}
        if(!(input.get("hits") instanceof List<?> values) || values.size()!=query.segments.size())
            throw new WorldService.Problem("invalid_collision","碰撞结果必须对应服务器每一段轨迹");
        List<Hit> hits=new ArrayList<>();
        for(int i=0;i<values.size();i++){
            if(values.get(i)==null){hits.add(null);continue;}
            Map<String,Object> value=WorldService.object(values.get(i));WorldService.fields(value,"position","normal","material");
            Vector position=WorldService.vector(value.get("position")),normal=WorldService.vector(value.get("normal"));
            long material=WorldService.integer(value.get("material"),0,0xffffffffL);
            Segment segment=query.segments.get(i);
            double length=segment.from.distance(segment.to),t=projection(segment,position);
            Vector projected=interpolate(segment,t);
            if(t<-.001 || t>1.001 || position.distance(projected)>Math.max(.15,segment.radius+.1)
                || normal.length()<.9 || normal.length()>1.1 || length<.0001)
                throw new WorldService.Problem("invalid_collision","碰撞点或法线不属于服务器轨迹");
            hits.add(new Hit(position,normal,material));
        }
        // Validate the complete response before consuming its ticket or mutating root result slots.
        pending.remove(query.id);
        outgoing.removeIf(message->query.id.equals(message.get("query_id")));
        List<Segment> continuing=new ArrayList<>();List<Integer> slots=new ArrayList<>(),depths=new ArrayList<>();
        for(int i=0;i<hits.size();i++){
            int slot=query.slots.get(i);Segment original=query.root.segments.get(slot),segment=query.segments.get(i);
            Hit nativeHit=hits.get(i),staticHit=geometry.first(original,query.purpose);
            if(nativeHit==null){query.root.hits[slot]=staticHit;continue;}
            if(staticHit!=null && staticHit.position.distance(original.from)<=nativeHit.position.distance(original.from)){
                query.root.hits[slot]=staticHit;continue;
            }
            MaterialCatalog.Material material=MaterialCatalog.byCode(nativeHit.material);
            boolean transparent=material!=null && ("shot".equals(query.purpose)?material.shootThru():
                "visibility".equals(query.purpose) && material.seeThru());
            if(!transparent){query.root.hits[slot]=nativeHit;continue;}
            if(query.depths.get(i)>=MAX_TRANSPARENT_LAYERS){finish(query.root,new Result(false,List.of()));return;}
            double length=segment.from.distance(segment.to),t=Math.max(0,projection(segment,nativeHit.position)),step=.03/length;
            if(t+step>=1){
                // A remaining native surface cannot be ruled out by a zero-length probe.
                if(staticHit!=null){query.root.hits[slot]=staticHit;continue;}
                finish(query.root,new Result(false,List.of()));return;
            }
            Vector start=interpolate(segment,t+step);
            if(staticHit!=null && staticHit.position.distance(original.from)<=start.distance(original.from)){
                query.root.hits[slot]=staticHit;continue;
            }
            continuing.add(new Segment(start,segment.to,segment.radius));slots.add(slot);depths.add(query.depths.get(i)+1);
        }
        if(!continuing.isEmpty()){
            if(now>=query.expires){timedOut++;finish(query.root,new Result(false,List.of()));return;}
            issue("q:"+epoch+":"+(++sequence),query.root,continuing,slots,depths,now);
            return;
        }
        completed++;finish(query.root,new Result(true,Collections.unmodifiableList(Arrays.asList(query.root.hits))));
    }
    static double projection(Segment s,Vector point){
        double x=s.to.x()-s.from.x(),y=s.to.y()-s.from.y(),z=s.to.z()-s.from.z(),d=x*x+y*y+z*z;
        return d<1e-12?0:((point.x()-s.from.x())*x+(point.y()-s.from.y())*y+(point.z()-s.from.z())*z)/d;
    }
    static Vector interpolate(Segment s,double t){return new Vector(s.from.x()+(s.to.x()-s.from.x())*t,
        s.from.y()+(s.to.y()-s.from.y())*t,s.from.z()+(s.to.z()-s.from.z())*t);}
    Map<String,Object> status(){return WorldService.map("mode",observers.isEmpty()?"server_triangles_or_legacy":"server_triangles_and_leased_native",
        "native_observers",observers.size(),"pending_queries",pending.size(),"completed_queries",completed,
        "rejected_queries",rejected,"timed_out_queries",timedOut,"static_geometry",geometry.metadata(),
        "map_authority","server_extracted_and_leased_engine","damage_authority","server");}
}
