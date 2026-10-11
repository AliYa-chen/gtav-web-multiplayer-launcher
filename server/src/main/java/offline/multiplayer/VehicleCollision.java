package offline.multiplayer;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import offline.multiplayer.WorldRegistry.Entity;
import offline.multiplayer.WorldRegistry.Rotation;
import offline.multiplayer.WorldRegistry.Transform;
import offline.multiplayer.WorldRegistry.Vector;

/** Pristine YFT collision triangles in model space; AABBs are broad phase only. */
final class VehicleCollision {
    private record V(double x,double y,double z) {
        double length(){return Math.hypot(Math.hypot(x,y),z);}
        double distance(V other){return subtract(this,other).length();}
        Vector vector(){return new Vector(x,y,z);}
    }
    record Contact(WorldCollision.Hit hit,boolean verifiedSurface) {}
    private record Triangle(V a,V b,V c,long material) {}
    private record Unknown(double[] bounds) {}
    private record Model(String name,List<Triangle> triangles,List<Unknown> unknown,double[] bounds,String sourceHash) {}
    private final Map<Long,Model> models;
    private final int incompleteModels;
    private final String sourceHash,engineHash;
    private VehicleCollision(Map<Long,Model> models,int incompleteModels,String sourceHash,String engineHash){
        this.models=Map.copyOf(models);this.incompleteModels=incompleteModels;this.sourceHash=sourceHash;this.engineHash=engineHash;
    }
    static VehicleCollision empty(){return new VehicleCollision(Map.of(),0,"","");}
    static VehicleCollision load(Path path)throws IOException{
        if(Files.size(path)>64*1024*1024)throw new IOException("载具碰撞数据过大");
        try{
            Map<String,Object> root=WorldService.object(Main.Json.parse(Files.readString(path),200_000));
            if(WorldService.integer(root.get("version"),1,1)!=1)throw new IOException("无效载具碰撞版本");
            String source=hash(root.get("source_sha256")),engine=hash(root.get("engine_sha256"));
            if(!(root.get("models") instanceof List<?> values) || values.size()>64)throw new IOException("无效载具模型列表");
            Map<Long,Model> models=new LinkedHashMap<>();int incomplete=0,total=0;
            java.util.Set<Long> ids=new java.util.HashSet<>();
            for(Object value:values){
                Map<String,Object> row=WorldService.object(value);
                long id=WorldService.integer(row.get("model"),0,0xffffffffL);
                if(!ids.add(id))throw new IOException("重复载具模型");
                String name=WorldService.text(row.get("name"),64),modelHash=hash(row.get("source_sha256"));
                boolean complete=WorldService.bool(row.get("coverage_complete"));
                if(!(row.get("triangles") instanceof List<?> triangles))throw new IOException("无效载具碰撞三角形");
                total+=triangles.size();if(total>200_000)throw new IOException("载具碰撞三角形过多");
                List<Triangle> parsed=new ArrayList<>();
                double[] bounds={Double.POSITIVE_INFINITY,Double.POSITIVE_INFINITY,Double.POSITIVE_INFINITY,
                    Double.NEGATIVE_INFINITY,Double.NEGATIVE_INFINITY,Double.NEGATIVE_INFINITY};
                for(Object item:triangles){
                    Map<String,Object> triangle=WorldService.object(item);
                    if(!(triangle.get("vertices") instanceof List<?> coordinates) || coordinates.size()!=9)
                        throw new IOException("无效载具三角形顶点");
                    V[] vertices=new V[3];
                    for(int vertex=0;vertex<3;vertex++){
                        double[] p=new double[3];
                        for(int axis=0;axis<3;axis++){
                            p[axis]=WorldService.number(coordinates.get(vertex*3+axis),-100,100);
                            bounds[axis]=Math.min(bounds[axis],p[axis]);bounds[axis+3]=Math.max(bounds[axis+3],p[axis]);
                        }
                        vertices[vertex]=new V(p[0],p[1],p[2]);
                    }
                    if(cross(subtract(vertices[1],vertices[0]),subtract(vertices[2],vertices[0])).length()<1e-9)
                        throw new IOException("退化载具三角形");
                    parsed.add(new Triangle(vertices[0],vertices[1],vertices[2],WorldService.integer(triangle.get("material"),0,0xffffffffL)));
                }
                List<Unknown> unknown=new ArrayList<>();
                if(row.get("unknown_bounds") instanceof List<?> pending)for(Object item:pending){
                    Map<String,Object> bound=WorldService.object(item);
                    if(!(bound.get("bounds") instanceof List<?> raw) || raw.size()!=6)throw new IOException("无效未解析碰撞范围");
                    double[] box=new double[6];for(int axis=0;axis<6;axis++)box[axis]=WorldService.number(raw.get(axis),-100,100);
                    for(int axis=0;axis<3;axis++){
                        if(box[axis]>=box[axis+3])throw new IOException("无效未解析碰撞范围");
                        bounds[axis]=Math.min(bounds[axis],box[axis]);bounds[axis+3]=Math.max(bounds[axis+3],box[axis+3]);
                    }
                    unknown.add(new Unknown(box));
                }
                if(complete && !unknown.isEmpty() || !complete && unknown.isEmpty())throw new IOException("载具碰撞覆盖标记与未解析范围不一致");
                if(!complete)incomplete++;
                if(parsed.isEmpty())throw new IOException("载具碰撞模型没有已验证三角形");
                models.put(id,new Model(name,List.copyOf(parsed),List.copyOf(unknown),bounds,modelHash));
            }
            return new VehicleCollision(models,incomplete,source,engine);
        }catch(WorldService.Problem|IllegalArgumentException exception){throw new IOException("无效载具碰撞数据: "+exception.getMessage(),exception);}
    }
    private static String hash(Object value)throws IOException{
        if(!(value instanceof String text) || !text.matches("[a-f0-9]{64}"))throw new IOException("无效载具碰撞来源摘要");return text;
    }
    boolean hasModel(long model){return models.containsKey(model);}
    /** Seat roots must remain inside the original model's verified collision bounds. */
    boolean containsSeatRoot(Entity vehicle,Vector point){
        Model model=models.get(vehicle.model());if(model==null)return false;
        V local=local(point,vehicle.components().transform());
        double[] coordinates={local.x(),local.y(),local.z()};
        for(int axis=0;axis<3;axis++)
            if(coordinates[axis]<model.bounds[axis]-.05 || coordinates[axis]>model.bounds[axis+3]+.05)return false;
        return true;
    }
    Contact first(Entity entity,WorldCollision.Segment segment){return first(entity,segment,"shot");}
    Contact first(Entity entity,WorldCollision.Segment segment,String purpose){
        Model model=models.get(entity.model());if(model==null)return null;
        Transform transform=entity.components().transform();
        V from=local(segment.from(),transform),to=local(segment.to(),transform),ray=subtract(to,from);
        if(intersects(model.bounds,from,ray)<0)return null;
        double nearest=Double.POSITIVE_INFINITY;Triangle selected=null;
        for(Triangle triangle:model.triangles){
            MaterialCatalog.Material material=MaterialCatalog.byCode(triangle.material);
            if(material!=null && (("shot".equals(purpose)&&material.shootThru()) || ("visibility".equals(purpose)&&material.seeThru())))continue;
            double t=intersect(triangle,from,ray);
            if(t>=0 && t<=1 && t<nearest){nearest=t;selected=triangle;}
        }
        double uncertain=Double.POSITIVE_INFINITY;
        for(Unknown bound:model.unknown){double at=intersects(bound.bounds,from,ray);if(at>=0)uncertain=Math.min(uncertain,at);}
        if(uncertain<=nearest && Double.isFinite(uncertain)){
            if(ray.length()<1e-12)return null;
            V normal=rotate(scale(ray,-1/ray.length()),transform.rotation(),false);
            return new Contact(new WorldCollision.Hit(WorldCollision.interpolate(segment,uncertain),normal.vector(),0),false);
        }
        if(selected==null)return null;
        V normal=cross(subtract(selected.b,selected.a),subtract(selected.c,selected.a));
        normal=scale(normal,(dot(normal,ray)>0?-1:1)/normal.length());
        return new Contact(new WorldCollision.Hit(WorldCollision.interpolate(segment,nearest),rotate(normal,transform.rotation(),false).vector(),selected.material),true);
    }
    Vector nearestPoint(Entity entity,Vector point){
        Model model=models.get(entity.model());if(model==null)return null;
        Transform transform=entity.components().transform();V origin=local(point,transform),nearest=null;double distance=Double.POSITIVE_INFINITY;
        for(Triangle triangle:model.triangles){V candidate=nearest(triangle,origin);double d=candidate.distance(origin);
            if(d<distance){distance=d;nearest=candidate;}}
        V result=world(nearest,transform);
        if(Math.abs(result.x())>16000 || Math.abs(result.y())>16000 || Math.abs(result.z())>16000)return null;
        return result.vector();
    }
    private static V v(Vector point){return new V(point.x(),point.y(),point.z());}
    private static V local(Vector point,Transform transform){return rotate(subtract(v(point),v(transform.position())),transform.rotation(),true);}
    private static V world(V point,Transform transform){return add(rotate(point,transform.rotation(),false),v(transform.position()));}
    private static V rotate(V value,Rotation rotation,boolean inverse){
        double sign=inverse?-1:1,x=rotation.x()*sign,y=rotation.y()*sign,z=rotation.z()*sign,w=rotation.w();
        double tx=2*(y*value.z()-z*value.y()),ty=2*(z*value.x()-x*value.z()),tz=2*(x*value.y()-y*value.x());
        return new V(value.x()+w*tx+y*tz-z*ty,value.y()+w*ty+z*tx-x*tz,value.z()+w*tz+x*ty-y*tx);
    }
    private static double intersects(double[] b,V p,V d){
        double lo=0,hi=1;double[] origin={p.x(),p.y(),p.z()},ray={d.x(),d.y(),d.z()};
        for(int axis=0;axis<3;axis++){
            if(Math.abs(ray[axis])<1e-12){if(origin[axis]<b[axis] || origin[axis]>b[axis+3])return -1;continue;}
            double a=(b[axis]-origin[axis])/ray[axis],z=(b[axis+3]-origin[axis])/ray[axis];
            lo=Math.max(lo,Math.min(a,z));hi=Math.min(hi,Math.max(a,z));if(lo>hi)return -1;
        }
        return lo;
    }
    private static double intersect(Triangle t,V from,V ray){
        V e=subtract(t.b,t.a),f=subtract(t.c,t.a),h=cross(ray,f);double determinant=dot(e,h);
        if(Math.abs(determinant)<1e-10)return -1;
        double inverse=1/determinant;V s=subtract(from,t.a);double u=dot(s,h)*inverse;if(u<0 || u>1)return -1;
        V q=cross(s,e);double v=dot(ray,q)*inverse;if(v<0 || u+v>1)return -1;
        return dot(f,q)*inverse;
    }
    /** Closest point on the actual triangle, including its edge and vertex Voronoi regions. */
    private static V nearest(Triangle t,V p){
        V ab=subtract(t.b,t.a),ac=subtract(t.c,t.a),ap=subtract(p,t.a);
        double d1=dot(ab,ap),d2=dot(ac,ap);if(d1<=0 && d2<=0)return t.a;
        V bp=subtract(p,t.b);double d3=dot(ab,bp),d4=dot(ac,bp);if(d3>=0 && d4<=d3)return t.b;
        double vc=d1*d4-d3*d2;if(vc<=0 && d1>=0 && d3<=0)return add(t.a,scale(ab,d1/(d1-d3)));
        V cp=subtract(p,t.c);double d5=dot(ab,cp),d6=dot(ac,cp);if(d6>=0 && d5<=d6)return t.c;
        double vb=d5*d2-d1*d6;if(vb<=0 && d2>=0 && d6<=0)return add(t.a,scale(ac,d2/(d2-d6)));
        double va=d3*d6-d5*d4;if(va<=0 && d4-d3>=0 && d5-d6>=0)
            return add(t.b,scale(subtract(t.c,t.b),(d4-d3)/((d4-d3)+(d5-d6))));
        double inverse=1/(va+vb+vc);return add(t.a,add(scale(ab,vb*inverse),scale(ac,vc*inverse)));
    }
    private static V add(V a,V b){return new V(a.x()+b.x(),a.y()+b.y(),a.z()+b.z());}
    private static V subtract(V a,V b){return new V(a.x()-b.x(),a.y()-b.y(),a.z()-b.z());}
    private static V scale(V a,double value){return new V(a.x()*value,a.y()*value,a.z()*value);}
    private static double dot(V a,V b){return a.x()*b.x()+a.y()*b.y()+a.z()*b.z();}
    private static V cross(V a,V b){return new V(a.y()*b.z()-a.z()*b.y(),a.z()*b.x()-a.x()*b.z(),a.x()*b.y()-a.y()*b.x());}
    Map<String,Object> metadata(){return WorldService.map("models",models.size(),"incomplete_models",incompleteModels,
        "triangles",models.values().stream().mapToInt(model->model.triangles.size()).sum(),
        "unknown_bounds",models.values().stream().mapToInt(model->model.unknown.size()).sum(),
        "complete_models",models.size()-incompleteModels,"unknown_bounds_policy","block_without_damage_or_attachment",
        "source","pristine_yft_collision_triangles",
        "source_sha256",sourceHash,"engine_sha256",engineHash,"body_components",false);}
}
