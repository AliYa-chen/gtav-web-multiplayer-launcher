package offline.multiplayer;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import offline.multiplayer.WorldRegistry.Entity;
import offline.multiplayer.WorldRegistry.Vector;

/** Original YFT primitives positioned by bounded, leased native bone observations. */
final class PedCollision {
    static final long MAX_POSE_AGE_MILLIS = 250;
    private static final String ENGINE_HASH="11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0";
    private record Shape(int tag,int kind,double[] local,V center,double radius,double halfLength,V halfExtents) {}
    private record Edge(int from,int to,double length) {}
    private record Model(String name,List<Shape> shapes,List<Edge> edges,Set<Integer> tags) {}
    private record Lifetime(long generation,long ownerEpoch,String owner,long model,int deaths,WorldRegistry.Attachment attachment) {}
    record Bounds(Vector minimum,Vector maximum) {}
    /** A present record with a null height means both native water queries found no water. */
    record Water(Double height) {}
    private record Observation(Map<Integer,double[]> bones,Bounds bounds,Water water) {}
    private record Pose(Lifetime lifetime,CombatHistory.Fence fence,WorldRegistry.Transform anchor,long received,Map<Integer,double[]> bones,Bounds bounds,Water water) {}
    private record Frame(Map<String,Pose> poses,Map<String,CombatHistory.Fence> fences) {}
    record Contact(WorldCollision.Hit hit,int boneTag,boolean verifiedSurface) {}
    private record V(double x,double y,double z) {
        V add(V b){return new V(x+b.x,y+b.y,z+b.z);}
        V sub(V b){return new V(x-b.x,y-b.y,z-b.z);}
        V mul(double n){return new V(x*n,y*n,z*n);}
        double dot(V b){return x*b.x+y*b.y+z*b.z;}
        V cross(V b){return new V(y*b.z-z*b.y,z*b.x-x*b.z,x*b.y-y*b.x);}
        double norm(){return Math.sqrt(dot(this));}
        double at(int axis){return axis==0?x:axis==1?y:z;}
        Vector vector(){return new Vector(x,y,z);}
    }
    private final Map<Long,Model> models;
    private final Map<String,Pose> poses=new HashMap<>();
    private final LinkedHashMap<Long,Frame> history=new LinkedHashMap<>();
    private enum RejectionReason { MODEL, BONES, MATRIX, ANCHOR, EDGES, BOUNDS, WATER, LIFECYCLE }
    private static final class InvalidPose extends IllegalArgumentException {
        final RejectionReason reason;
        InvalidPose(RejectionReason reason) { this.reason = reason; }
    }
    private final Map<RejectionReason,Long> rejectionReasons=new java.util.EnumMap<>(RejectionReason.class);
    private WorldRegistry world;
    private String epoch="";
    private long accepted,rejected;
    private PedCollision(Map<Long,Model> models){this.models=Map.copyOf(models);}
    static PedCollision empty(){return new PedCollision(Map.of());}
    static PedCollision load(Path path)throws IOException{
        if(Files.size(path)>2*1024*1024)throw new IOException("角色碰撞数据过大");
        try{
            Map<String,Object> root=WorldService.object(Main.Json.parse(Files.readString(path),40_000));
            WorldService.integer(root.get("version"),1,1);
            if(!ENGINE_HASH.equals(root.get("engine_sha256")))throw new IOException("角色碰撞引擎版本不兼容");
            if(!(root.get("ragdolls") instanceof List<?> groups)||groups.size()!=2)throw new IOException("无效角色碰撞组");
            List<List<Shape>> shapes=new ArrayList<>();
            for(Object raw:groups){
                Map<String,Object> group=WorldService.object(raw);
                if(!(group.get("shapes") instanceof List<?> entries)||entries.size()!=21)throw new IOException("角色部件不完整");
                List<Shape> parsed=new ArrayList<>();Set<Integer> tags=new HashSet<>();
                for(Object entry:entries){
                    Map<String,Object> row=WorldService.object(entry);
                    int tag=(int)WorldService.integer(row.get("tag"),1,65535);
                    if(!tags.add(tag))throw new IOException("重复角色部件");
                    int kind=(int)WorldService.integer(row.get("kind"),1,3);
                    if(kind!=1&&kind!=3)throw new IOException("不支持的角色碰撞体");
                    double[] local=matrix(row.get("local"),100);
                    V center=point(row.get("center"),10);
                    double radius=kind==1?WorldService.number(row.get("radius"),.0001,1):0;
                    double length=kind==1?WorldService.number(row.get("half_length"),0,1):0;
                    V half=kind==3?point(row.get("half_extents"),1):new V(0,0,0);
                    if(kind==3&&(half.x<=0||half.y<=0||half.z<=0))throw new IOException("无效角色盒体尺寸");
                    parsed.add(new Shape(tag,kind,local,center,radius,length,half));
                }
                shapes.add(List.copyOf(parsed));
            }
            if(!(root.get("models") instanceof List<?> entries)||entries.size()!=10)throw new IOException("角色模型覆盖不完整");
            Map<Long,Model> models=new LinkedHashMap<>();
            for(Object entry:entries){
                Map<String,Object> row=WorldService.object(entry);
                long id=WorldService.integer(row.get("model"),1,0xffffffffL);
                String name=WorldService.text(row.get("name"),64);
                List<Shape> components=shapes.get((int)WorldService.integer(row.get("ragdoll"),0,1));
                Set<Integer> tags=new HashSet<>();for(Shape shape:components)tags.add(shape.tag);
                if(!(row.get("edges") instanceof List<?> links)||links.size()>21)throw new IOException("无效角色骨架约束");
                List<Edge> edges=new ArrayList<>();Set<Integer> children=new HashSet<>();
                for(Object link:links){
                    Map<String,Object> edge=WorldService.object(link);
                    int from=(int)WorldService.integer(edge.get("from"),1,65535),to=(int)WorldService.integer(edge.get("to"),1,65535);
                    if(from==to||!tags.contains(from)||!tags.contains(to)||!children.add(to))throw new IOException("无效角色骨架绑定");
                    edges.add(new Edge(from,to,WorldService.number(edge.get("length"),.000001,2)));
                }
                if(models.put(id,new Model(name,components,List.copyOf(edges),Set.copyOf(tags)))!=null)throw new IOException("重复角色模型");
            }
            return new PedCollision(models);
        }catch(WorldService.Problem|IllegalArgumentException failure){throw new IOException("无效角色碰撞数据: "+failure.getMessage(),failure);}
    }
    boolean hasModel(long model){return models.containsKey(model);}
    /** Validate before changing the authoritative transform; invalid input must not erase its last body. */
    boolean validObservation(long model,WorldRegistry.Transform transform,Object raw){
        try { parseObservation(model,transform,raw);return true; }
        catch(InvalidPose failure){reject(failure.reason);return false;}
    }
    private void reject(RejectionReason reason) {
        rejected++;
        rejectionReasons.merge(reason,1L,Long::sum);
    }
    private Observation parseObservation(long modelHash,WorldRegistry.Transform transform,Object raw){
        RejectionReason reason=RejectionReason.MODEL;
        try {
            Model model=models.get(modelHash);
            if(model==null||transform==null)throw new IllegalArgumentException();
            reason=RejectionReason.BONES;
            Map<String,Object> value=WorldService.object(raw);
            WorldService.fields(value,"bones","bounds","water_height","origin");
            if(!(value.get("bones") instanceof List<?> entries)||entries.size()!=model.tags.size())throw new IllegalArgumentException();
            Map<Integer,double[]> bones=new HashMap<>();V anchor=v(transform.position());
            reason=RejectionReason.ANCHOR;
            if(value.containsKey("origin")&&point(value.get("origin"),16000).sub(anchor).norm()>.05)throw new IllegalArgumentException();
            for(Object entry:entries){
                reason=RejectionReason.BONES;
                Map<String,Object> row=WorldService.object(entry);
                WorldService.fields(row,"tag","matrix");
                int tag=(int)WorldService.integer(row.get("tag"),1,65535);
                if(!model.tags.contains(tag)||bones.containsKey(tag))throw new IllegalArgumentException();
                reason=RejectionReason.MATRIX;
                double[] matrix=matrix(row.get("matrix"),16000);
                reason=RejectionReason.ANCHOR;
                if(origin(matrix).sub(anchor).norm()>2.5)throw new IllegalArgumentException();
                bones.put(tag,matrix);
            }
            // Bone translations come from the original model hierarchy. Allow bounded
            // animation/IK stretch, while rejecting detached limbs or collapsed skeletons.
            reason=RejectionReason.EDGES;
            for(Edge edge:model.edges){
                double distance=origin(bones.get(edge.from)).sub(origin(bones.get(edge.to))).norm();
                if(distance>edge.length*1.2+.025||distance<edge.length*.2-.01)throw new IllegalArgumentException();
            }
            Bounds bounds=null;Water water=null;
            if(value.containsKey("bounds")){
                reason=RejectionReason.BOUNDS;
                Map<String,Object> rawBounds=WorldService.object(value.get("bounds"));
                WorldService.fields(rawBounds,"minimum","maximum");
                V minimum=point(rawBounds.get("minimum"),16000),maximum=point(rawBounds.get("maximum"),16000);
                for(int axis=0;axis<3;axis++){
                    double lo=minimum.at(axis),hi=maximum.at(axis),at=anchor.at(axis);
                    if(lo>=hi||hi-lo>8||Math.abs(lo-at)>4||Math.abs(hi-at)>4)throw new IllegalArgumentException();
                }
                bounds=new Bounds(minimum.vector(),maximum.vector());
            }
            reason=RejectionReason.WATER;
            if(value.containsKey("water_height"))water=new Water(value.get("water_height")==null?null:
                WorldService.number(value.get("water_height"),-16000,16000));
            return new Observation(Map.copyOf(bones),bounds,water);
        } catch(WorldService.Problem|IllegalArgumentException failure) {
            throw new InvalidPose(reason);
        }
    }
    /** Called only after the containing player or NPC intent passed its epoch/generation/lease fence. */
    boolean acceptPose(Entity entity,Object raw,long now){
        if(entity==null){reject(RejectionReason.LIFECYCLE);return false;}
        try{
            if(entity.kind()!=WorldRegistry.Kind.PED||!alive(entity)||now<0
                ||entity.ownerId()==null||entity.leaseUntilTick()<=now)throw new InvalidPose(RejectionReason.LIFECYCLE);
            Observation observation=parseObservation(entity.model(),entity.components().transform(),raw);
            Pose previous=poses.get(entity.entityId());
            if(previous!=null&&now<previous.received)throw new InvalidPose(RejectionReason.LIFECYCLE);
            poses.put(entity.entityId(),new Pose(lifetime(entity),world==null?null:CombatHistory.fence(entity,world),entity.components().transform(),now,
                observation.bones,observation.bounds,observation.water));
            accepted++;return true;
        }catch(InvalidPose failure){reject(failure.reason);return false;}
    }
    void capture(WorldRegistry current,long now){
        world=current;
        if(!epoch.equals(current.worldEpoch())){
            if(!epoch.isEmpty()){history.clear();poses.clear();}
            epoch=current.worldEpoch();
        }
        poses.entrySet().removeIf(entry->!valid(entry.getValue(),current.entity(entry.getKey()),now));
        Map<String,Pose> cut=new HashMap<>();Map<String,CombatHistory.Fence> fences=new HashMap<>();
        for(Map.Entry<String,Pose> entry:poses.entrySet()){
            Pose pose=entry.getValue();CombatHistory.Fence fence=CombatHistory.fence(current.entity(entry.getKey()),current);
            if(pose.fence==null){pose=new Pose(pose.lifetime,fence,pose.anchor,pose.received,pose.bones,pose.bounds,pose.water);entry.setValue(pose);}
            cut.put(entry.getKey(),pose);fences.put(entry.getKey(),fence);
        }
        history.put(now,new Frame(Map.copyOf(cut),Map.copyOf(fences)));
        history.entrySet().removeIf(entry->now-entry.getKey()>MAX_POSE_AGE_MILLIS);
        while(history.size()>256)history.remove(history.keySet().iterator().next());
    }
    boolean hasPose(Entity entity,long now){return pose(entity,now,-1)!=null;}
    boolean hasPose(Entity entity,long now,long historicalTick){return pose(entity,now,historicalTick)!=null;}
    Bounds freshBounds(Entity entity,long now){Pose pose=pose(entity,now,-1);return pose==null?null:pose.bounds;}
    Water freshWater(Entity entity,long now){Pose pose=pose(entity,now,-1);return pose==null?null:pose.water;}
    Map<String,Object> acceptedPose(Entity entity,long now){
        Pose pose=pose(entity,now,-1);if(pose==null)return null;
        List<Map<String,Object>> bones=new ArrayList<>();
        for(Shape shape:models.get(entity.model()).shapes){
            double[] matrix=pose.bones.get(shape.tag);List<Double> values=new ArrayList<>(12);
            for(double value:matrix)values.add(value);
            bones.add(Map.of("tag",shape.tag,"matrix",List.copyOf(values)));
        }
        return Map.of("bones",List.copyOf(bones),"origin",pose.anchor.position().values(),"sample_tick",pose.received);
    }
    Vector bonePoint(Entity entity,int bone,long now){
        Pose pose=pose(entity,now,-1);
        double[] matrix=pose==null?null:pose.bones.get(bone);
        return matrix==null?null:origin(matrix).vector();
    }
    Vector closestPoint(Entity entity,Vector source,long now){
        Model model=models.get(entity.model());Pose pose=pose(entity,now,-1);
        if(model==null||pose==null)return null;
        V point=v(source),selected=null;double nearest=Double.POSITIVE_INFINITY;
        for(Shape shape:model.shapes){
            double[] transform=compose(pose.bones.get(shape.tag),shape.local);
            V local=inverse(transform,point).sub(shape.center),closest;
            if(shape.kind==1){
                V axis=new V(0,clamp(local.y,-shape.halfLength,shape.halfLength),0),radial=local.sub(axis);
                double length=radial.norm();
                closest=length<=shape.radius?local:axis.add(radial.mul(shape.radius/length));
            }else closest=new V(clamp(local.x,-shape.halfExtents.x,shape.halfExtents.x),
                clamp(local.y,-shape.halfExtents.y,shape.halfExtents.y),clamp(local.z,-shape.halfExtents.z,shape.halfExtents.z));
            V candidate=direction(transform,closest.add(shape.center)).add(origin(transform));
            double distance=candidate.sub(point).norm();
            if(distance<nearest){nearest=distance;selected=candidate;}
        }
        return selected==null?null:selected.vector();
    }
    Contact first(Entity entity,WorldCollision.Segment segment,long now){return first(entity,segment,now,-1);}
    Contact first(Entity entity,WorldCollision.Segment segment,long now,long historicalTick){
        Model model=models.get(entity.model());Pose pose=pose(entity,now,historicalTick);
        if(model==null||pose==null)return null;
        V start=v(segment.from()),delta=v(segment.to()).sub(start);double nearest=Double.POSITIVE_INFINITY;Shape chosen=null;double[] chosenMatrix=null;V chosenLocal=null;
        for(Shape shape:model.shapes){
            double[] transform=compose(pose.bones.get(shape.tag),shape.local);
            V from=inverse(transform,start).sub(shape.center),to=inverse(transform,start.add(delta)).sub(shape.center),ray=to.sub(from);
            double at=shape.kind==1?capsule(from,ray,shape.halfLength,shape.radius+segment.radius()):roundedBox(from,ray,shape.halfExtents,segment.radius());
            if(at>=0&&at<=1&&at<nearest){nearest=at;chosen=shape;chosenMatrix=transform;chosenLocal=from.add(ray.mul(at));}
        }
        if(chosen==null)return null;
        V normal;
        if(chosen.kind==1)normal=chosenLocal.sub(new V(0,clamp(chosenLocal.y,-chosen.halfLength,chosen.halfLength),0));
        else{
            V half=chosen.halfExtents;
            normal=chosenLocal.sub(new V(clamp(chosenLocal.x,-half.x,half.x),clamp(chosenLocal.y,-half.y,half.y),clamp(chosenLocal.z,-half.z,half.z)));
            if(normal.norm()<1e-10){int axis=0;double gap=Double.POSITIVE_INFINITY;for(int a=0;a<3;a++){double g=half.at(a)-Math.abs(chosenLocal.at(a));if(g<gap){gap=g;axis=a;}}
                double sign=chosenLocal.at(axis)<0?-1:1;normal=axis==0?new V(sign,0,0):axis==1?new V(0,sign,0):new V(0,0,sign);}
        }
        if(normal.norm()<1e-10)normal=new V(0,0,1);else normal=normal.mul(1/normal.norm());
        normal=direction(chosenMatrix,normal);normal=normal.mul(1/normal.norm());
        return new Contact(new WorldCollision.Hit(start.add(delta.mul(nearest)).vector(),normal.vector(),0),chosen.tag,true);
    }
    private Pose pose(Entity entity,long now,long tick){
        if(entity==null)return null;
        Entity current=world==null?entity:world.entity(entity.entityId());
        if(current==null||current.ownerId()==null||current.leaseUntilTick()<=now)return null;
        if(tick<0){Pose pose=poses.get(entity.entityId());return valid(pose,entity,now)?pose:null;}
        Frame frame=history.get(tick);
        if(frame==null||tick>now||now-tick>MAX_POSE_AGE_MILLIS)return null;
        Pose pose=frame.poses.get(entity.entityId());CombatHistory.Fence fence=frame.fences.get(entity.entityId());
        return valid(pose,entity,tick)&&world!=null&&fence!=null&&CombatHistory.matches(fence,world)?pose:null;
    }
    private boolean valid(Pose pose,Entity entity,long now){
        if(pose==null||entity==null||!alive(entity)||entity.ownerId()==null||entity.leaseUntilTick()<=now
            ||now<pose.received||now-pose.received>MAX_POSE_AGE_MILLIS||!pose.lifetime.equals(lifetime(entity)))return false;
        if(pose.fence!=null&&(world==null||!CombatHistory.matches(pose.fence,world)))return false;
        var a=pose.anchor.rotation();var b=entity.components().transform().rotation();
        double rotation=Math.abs(a.x()*b.x()+a.y()*b.y()+a.z()*b.z()+a.w()*b.w());
        return v(pose.anchor.position()).sub(v(entity.components().transform().position())).norm()<=.25&&rotation>=.995;
    }
    private static boolean alive(Entity entity){return entity.components().combat()==null||entity.components().combat().alive();}
    private static Lifetime lifetime(Entity e){return new Lifetime(e.generation(),e.ownerEpoch(),e.ownerId(),e.model(),e.components().combat()==null?-1:e.components().combat().deaths(),e.components().attachment());}
    private static V v(Vector point){return new V(point.x(),point.y(),point.z());}
    private static V point(Object raw,double limit)throws WorldService.Problem{
        if(!(raw instanceof List<?> values)||values.size()!=3)throw new IllegalArgumentException();
        return new V(WorldService.number(values.get(0),-limit,limit),WorldService.number(values.get(1),-limit,limit),WorldService.number(values.get(2),-limit,limit));
    }
    private static double[] matrix(Object raw,double limit)throws WorldService.Problem{
        if(!(raw instanceof List<?> values)||values.size()!=12)throw new IllegalArgumentException();
        double[] result=new double[12];for(int i=0;i<12;i++)result[i]=WorldService.number(values.get(i),-limit,limit);
        V x=column(result,0),y=column(result,1),z=column(result,2);
        if(Math.abs(x.dot(x)-1)>.02||Math.abs(y.dot(y)-1)>.02||Math.abs(z.dot(z)-1)>.02||Math.abs(x.dot(y))>.02||Math.abs(x.dot(z))>.02||Math.abs(y.dot(z))>.02||x.cross(y).dot(z)<.98)throw new IllegalArgumentException();
        // Retain rigid geometry despite floating-point cancellation in script offsets.
        x=x.mul(1/x.norm());y=y.sub(x.mul(x.dot(y)));y=y.mul(1/y.norm());z=x.cross(y);
        V[] basis={x,y,z};for(int c=0;c<3;c++)for(int a=0;a<3;a++)result[c*3+a]=basis[c].at(a);
        return result;
    }
    private static V column(double[] m,int n){return new V(m[n*3],m[n*3+1],m[n*3+2]);}
    private static V origin(double[] m){return column(m,3);}
    private static V direction(double[] m,V p){return column(m,0).mul(p.x).add(column(m,1).mul(p.y)).add(column(m,2).mul(p.z));}
    private static V inverse(double[] m,V p){V relative=p.sub(origin(m));return new V(relative.dot(column(m,0)),relative.dot(column(m,1)),relative.dot(column(m,2)));}
    private static double[] compose(double[] a,double[] b){
        double[] result=new double[12];for(int c=0;c<4;c++){V value=direction(a,column(b,c));if(c==3)value=value.add(origin(a));for(int axis=0;axis<3;axis++)result[c*3+axis]=value.at(axis);}return result;
    }
    private static double clamp(double n,double lo,double hi){return Math.max(lo,Math.min(hi,n));}
    private static double sphere(V p,V d,V center,double radius){
        V q=p.sub(center);double c=q.dot(q)-radius*radius;if(c<=0)return 0;
        double a=d.dot(d),b=q.dot(d),disc=b*b-a*c;if(a<=1e-20||disc<0)return -1;
        double t=(-b-Math.sqrt(disc))/a;return t>=0&&t<=1?t:-1;
    }
    private static double capsule(V p,V d,double half,double radius){
        if(p.sub(new V(0,clamp(p.y,-half,half),0)).norm()<=radius)return 0;
        double best=Double.POSITIVE_INFINITY;
        for(double y:new double[]{-half,half}){double t=sphere(p,d,new V(0,y,0),radius);if(t>=0)best=Math.min(best,t);}
        double a=d.x*d.x+d.z*d.z,b=p.x*d.x+p.z*d.z,c=p.x*p.x+p.z*p.z-radius*radius,disc=b*b-a*c;
        if(a>1e-20&&disc>=0){double t=(-b-Math.sqrt(disc))/a;if(t>=0&&t<=1&&Math.abs(p.y+d.y*t)<=half)best=Math.min(best,t);}
        return Double.isFinite(best)?best:-1;
    }
    /** Exact ray versus the box expanded by a sphere; intervals preserve edge/corner curvature. */
    private static double roundedBox(V p,V d,V half,double radius){
        List<Double> cuts=new ArrayList<>(List.of(0.0,1.0));
        for(int axis=0;axis<3;axis++)if(Math.abs(d.at(axis))>1e-15)for(double bound:new double[]{-half.at(axis),half.at(axis)}){
            double t=(bound-p.at(axis))/d.at(axis);if(t>0&&t<1)cuts.add(t);
        }
        cuts.sort(Double::compare);
        for(int i=0;i<cuts.size()-1;i++){
            double lo=cuts.get(i),hi=cuts.get(i+1),mid=(lo+hi)/2,a=0,b=0,c=-radius*radius;
            for(int axis=0;axis<3;axis++){
                double value=p.at(axis)+d.at(axis)*mid,h=half.at(axis);
                if(value>=-h&&value<=h)continue;
                double q=p.at(axis)-(value<0?-h:h),r=d.at(axis);a+=r*r;b+=q*r;c+=q*q;
            }
            if(a*lo*lo+2*b*lo+c<=1e-14)return lo;
            if(a<=1e-20)continue;
            double disc=b*b-a*c;if(disc<0)continue;
            double t=(-b-Math.sqrt(disc))/a;if(t>=lo-1e-12&&t<=hi+1e-12)return clamp(t,lo,hi);
        }
        return -1;
    }
    Map<String,Object> metadata(){
        Map<String,Long> reasons=new LinkedHashMap<>();
        for(RejectionReason reason:RejectionReason.values())reasons.put(reason.name().toLowerCase(java.util.Locale.ROOT),rejectionReasons.getOrDefault(reason,0L));
        return WorldService.map("models",models.size(),"source","original_yft_ragdoll_primitives","engine_sha256",ENGINE_HASH,
            "max_pose_age_ms",MAX_POSE_AGE_MILLIS,"accepted_poses",accepted,"rejected_poses",rejected,
            "rejection_reasons",reasons,"active_poses",poses.size());
    }
}
