package offline.multiplayer;

import java.io.BufferedInputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;

/** Server pedestrian paths through verified, ordinary shared edges of local YNV polygons. */
public final class PedNavigation {
    private static final double CELL = 32, PORTAL_EPSILON = .041;
    private static final int MAX_TRIANGLES = 500_000;
    private final Triangle[] triangles;
    private final Map<Long, int[]> cells;
    private final double[] bounds;
    private final int links;

    public record Point(double x, double y, double z) {
        public Point {
            if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(z)
                    || Math.max(Math.max(Math.abs(x), Math.abs(y)), Math.abs(z)) > 16000)
                throw new IllegalArgumentException("Invalid pedestrian navigation coordinate");
        }
        public double distance(Point p) { return Math.hypot(Math.hypot(x-p.x,y-p.y),z-p.z); }
    }
    public record Snap(Point position, int polygonId, double distance) {}
    /** Points start and finish on the mesh; each intervening point is on a shared portal. */
    public record Route(List<Point> points, boolean reached, String reason) {
        public Route { points = List.copyOf(points); }
    }
    private record Triangle(int area, int sourcePolygon, int flags, Point[] vertices, int[] adjacent, Point center) {}
    private record Open(int triangle, double cost, double estimate) {}

    private PedNavigation(Triangle[] triangles, Map<Long, int[]> cells, double[] bounds, int links) {
        this.triangles=triangles; this.cells=cells; this.bounds=bounds; this.links=links;
    }
    public static PedNavigation empty() { return new PedNavigation(new Triangle[0],Map.of(),new double[0],0); }
    public int polygonCount() { return triangles.length; }

    public static PedNavigation load(Path path) throws IOException {
        long size=Files.size(path);
        if (size<60 || size>60L+60L*MAX_TRIANGLES) throw new IOException("Invalid pedestrian navigation file size");
        try (DataInputStream in=new DataInputStream(new BufferedInputStream(Files.newInputStream(path)))) {
            if (!Arrays.equals(in.readNBytes(8),"GTAPNAV1".getBytes(StandardCharsets.US_ASCII)))
                throw new IOException("Unsupported pedestrian navigation format");
            double[] bounds=new double[6];
            for(int i=0;i<6;i++) {
                bounds[i]=in.readDouble();
                if(!Double.isFinite(bounds[i]) || Math.abs(bounds[i])>16000) throw new IOException("Invalid navigation bounds");
            }
            for(int i=0;i<3;i++)if(bounds[i]>=bounds[i+3])throw new IOException("Inverted navigation bounds");
            int count=in.readInt();
            if(count<1 || count>MAX_TRIANGLES || size!=60L+60L*count)throw new IOException("Invalid navigation triangle count");
            Triangle[] triangles=new Triangle[count];
            Map<Long,List<Integer>> grid=new HashMap<>(); int links=0;
            for(int id=0;id<count;id++) {
                int area=in.readInt(),polygon=in.readInt(),flags=in.readInt();
                if(area<0 || area>=10000 || polygon<0 || polygon>32767 || flags<0 || flags>0x1fffff)
                    throw new IOException("Invalid source navigation identity");
                Point[] vertices=new Point[3];
                for(int v=0;v<3;v++)vertices[v]=new Point(in.readFloat(),in.readFloat(),in.readFloat());
                if(Math.abs(cross(vertices[0],vertices[1],vertices[2]))<1e-7)
                    throw new IOException("Degenerate navigation triangle");
                int[] adjacent=new int[3];
                for(int v=0;v<3;v++) {
                    adjacent[v]=in.readInt();
                    if(adjacent[v]<-1 || adjacent[v]>=count || adjacent[v]==id)throw new IOException("Invalid navigation adjacency");
                    if(adjacent[v]>=0)links++;
                }
                Point center=new Point((vertices[0].x+vertices[1].x+vertices[2].x)/3,
                    (vertices[0].y+vertices[1].y+vertices[2].y)/3,(vertices[0].z+vertices[1].z+vertices[2].z)/3);
                triangles[id]=new Triangle(area,polygon,flags,vertices,adjacent,center);
                int minX=cell(Math.min(vertices[0].x,Math.min(vertices[1].x,vertices[2].x)));
                int maxX=cell(Math.max(vertices[0].x,Math.max(vertices[1].x,vertices[2].x)));
                int minY=cell(Math.min(vertices[0].y,Math.min(vertices[1].y,vertices[2].y)));
                int maxY=cell(Math.max(vertices[0].y,Math.max(vertices[1].y,vertices[2].y)));
                if(maxX-minX>32 || maxY-minY>32)throw new IOException("Navigation triangle spans excessive cells");
                for(int x=minX;x<=maxX;x++)for(int y=minY;y<=maxY;y++)
                    grid.computeIfAbsent(key(x,y),unused->new ArrayList<>()).add(id);
            }
            for(Triangle triangle:triangles)for(int side=0;side<3;side++)if(triangle.adjacent[side]>=0) {
                Triangle next=triangles[triangle.adjacent[side]];
                if(!sharedEdge(triangle.vertices[side],triangle.vertices[(side+1)%3],next))
                    throw new IOException("Navigation link does not share its declared portal");
            }
            Map<Long,int[]> cells=new HashMap<>();
            grid.forEach((key,ids)->cells.put(key,ids.stream().mapToInt(Integer::intValue).toArray()));
            return new PedNavigation(triangles,Collections.unmodifiableMap(cells),bounds,links);
        } catch(IllegalArgumentException error) {
            throw new IOException("Invalid pedestrian navigation geometry",error);
        }
    }

    public Snap nearest(Point point,double maxSnap) {
        if(!Double.isFinite(maxSnap) || maxSnap<0 || maxSnap>100)throw new IllegalArgumentException("Invalid navigation snap radius");
        int minX=cell(point.x-maxSnap),maxX=cell(point.x+maxSnap),minY=cell(point.y-maxSnap),maxY=cell(point.y+maxSnap);
        Snap best=null;
        // A triangle may be present in several cells; nearest-point calculation
        // is bounded to the local grid and does not scan the entire city mesh.
        java.util.HashSet<Integer> visited=new java.util.HashSet<>();
        for(int x=minX;x<=maxX;x++)for(int y=minY;y<=maxY;y++) {
            int[] ids=cells.get(key(x,y));if(ids==null)continue;
            for(int id:ids)if(visited.add(id)) {
                Point closest=closest(point,triangles[id]);double distance=point.distance(closest);
                if(distance<=maxSnap && (best==null || distance<best.distance-1e-9
                        || Math.abs(distance-best.distance)<=1e-9 && id<best.polygonId))best=new Snap(closest,id,distance);
            }
        }
        return best;
    }

    public Route route(Point from,Point to,double maxSnap,int maxVisited) {
        return route(from,to,maxSnap,maxVisited,-1,-1);
    }

    /** Try a genuinely different first portal after a stalled route; no safe bypass means wait. */
    public Route detour(Point from,Point to,double maxSnap,int maxVisited) {
        Route original=route(from,to,maxSnap,maxVisited);
        if(!original.reached || original.points.size()<2)return failure("no_detour");
        Snap start=nearest(from,maxSnap);Triangle first=triangles[start.polygonId];
        if(nearest(to,maxSnap).polygonId==start.polygonId)return failure("no_detour");
        Point portal=original.points.get(1);
        for(int side=0;side<3;side++)if(first.adjacent[side]>=0
                && midpoint(first.vertices[side],first.vertices[(side+1)%3]).distance(portal)<1e-5) {
            Route alternate=route(from,to,maxSnap,maxVisited,start.polygonId,first.adjacent[side]);
            return alternate.reached ? alternate : failure("no_detour");
        }
        return failure("no_detour");
    }

    private Route route(Point from,Point to,double maxSnap,int maxVisited,int blockedFrom,int blockedTo) {
        if(maxVisited<1 || maxVisited>MAX_TRIANGLES)throw new IllegalArgumentException("Invalid navigation search budget");
        if(triangles.length==0)return failure("no_navigation");
        Snap start=nearest(from,maxSnap),finish=nearest(to,maxSnap);
        if(start==null || finish==null)return failure("outside_navigation");
        if(start.polygonId==finish.polygonId)return new Route(distinct(List.of(start.position,finish.position)),true,"arrived");
        Map<Integer,Double> costs=new HashMap<>();
        Map<Integer,Integer> parents=new HashMap<>(),sides=new HashMap<>();
        PriorityQueue<Open> open=new PriorityQueue<>(Comparator.comparingDouble(Open::estimate).thenComparingInt(Open::triangle));
        Point destination=triangles[finish.polygonId].center;
        costs.put(start.polygonId,0.);open.add(new Open(start.polygonId,0,triangles[start.polygonId].center.distance(destination)));
        int visits=0;boolean reached=false;
        while(!open.isEmpty()) {
            Open current=open.remove();
            if(current.cost>costs.getOrDefault(current.triangle,Double.POSITIVE_INFINITY)+1e-9)continue;
            if(++visits>maxVisited)return failure("visit_budget");
            if(current.triangle==finish.polygonId){reached=true;break;}
            Triangle triangle=triangles[current.triangle];
            for(int side=0;side<3;side++) {
                int next=triangle.adjacent[side];if(next<0)continue;
                if(current.triangle==blockedFrom && next==blockedTo || current.triangle==blockedTo && next==blockedFrom)continue;
                double cost=current.cost+triangle.center.distance(triangles[next].center);
                if(cost+1e-9>=costs.getOrDefault(next,Double.POSITIVE_INFINITY))continue;
                costs.put(next,cost);parents.put(next,current.triangle);sides.put(next,side);
                open.add(new Open(next,cost,cost+triangles[next].center.distance(destination)));
            }
        }
        if(!reached)return failure("no_route");
        List<Point> portals=new ArrayList<>();
        for(int next=finish.polygonId;next!=start.polygonId;) {
            int previous=parents.get(next),side=sides.get(next);
            Point a=triangles[previous].vertices[side],b=triangles[previous].vertices[(side+1)%3];
            portals.add(midpoint(a,b));next=previous;
        }
        Collections.reverse(portals);portals.add(0,start.position);portals.add(finish.position);
        return new Route(distinct(portals),true,"arrived");
    }

    /** Select a reproducible reachable destination, then route through ordinary portals. */
    public Route wander(Point from,long seed,double range) {
        if(!Double.isFinite(range) || range<1 || range>100)throw new IllegalArgumentException("Invalid wander radius");
        if(triangles.length==0)return failure("no_navigation");
        Snap start=nearest(from,4);if(start==null)return failure("outside_navigation");
        List<Integer> queue=new ArrayList<>();java.util.HashSet<Integer> visited=new java.util.HashSet<>();
        queue.add(start.polygonId);visited.add(start.polygonId);int selected=-1;long best=0;
        for(int head=0;head<queue.size() && head<6000;head++) {
            int id=queue.get(head);Triangle triangle=triangles[id];double distance=from.distance(triangle.center);
            if(distance>=Math.min(3,range/2) && distance<=range) {
                long score=mix(seed^id);
                if(selected<0 || Long.compareUnsigned(score,best)>0){selected=id;best=score;}
            }
            for(int neighbor:triangle.adjacent)if(neighbor>=0 && visited.add(neighbor)
                    && from.distance(triangles[neighbor].center)<=range+5)queue.add(neighbor);
        }
        if(selected<0)return failure("no_wander_destination");
        return route(from,triangles[selected].center,4,6000);
    }

    public Map<String,Object> status() {
        Map<String,Object> result=new LinkedHashMap<>();
        result.put("available",triangles.length>0);result.put("source","local_ynv_polygons");
        result.put("navigation_triangles",triangles.length);result.put("directed_links",links);
        result.put("bounds",Arrays.stream(bounds).boxed().toList());result.put("coverage_complete",false);
        result.put("special_traversal",false);result.put("dynamic_obstacles",false);
        return Collections.unmodifiableMap(result);
    }

    private static Route failure(String reason){return new Route(List.of(),false,reason);}
    private static List<Point> distinct(List<Point> points) {
        List<Point> out=new ArrayList<>();for(Point p:points)if(out.isEmpty() || out.get(out.size()-1).distance(p)>1e-5)out.add(p);return out;
    }
    private static long mix(long value){value=(value^(value>>>30))*0xbf58476d1ce4e5b9L;value=(value^(value>>>27))*0x94d049bb133111ebL;return value^(value>>>31);}
    private static int cell(double coordinate){return (int)Math.floor(coordinate/CELL);}
    private static long key(int x,int y){return ((long)x<<32)^(y&0xffffffffL);}
    private static Point midpoint(Point a,Point b){return new Point((a.x+b.x)/2,(a.y+b.y)/2,(a.z+b.z)/2);}
    private static double cross(Point a,Point b,Point c){return (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);}
    private static boolean sharedEdge(Point a,Point b,Triangle next) {
        for(int side=0;side<3;side++) {
            Point c=next.vertices[side],d=next.vertices[(side+1)%3];
            if(a.distance(c)<=PORTAL_EPSILON && b.distance(d)<=PORTAL_EPSILON
                    || a.distance(d)<=PORTAL_EPSILON && b.distance(c)<=PORTAL_EPSILON)return true;
        }
        return false;
    }
    private static Point closest(Point p,Triangle triangle) {
        // Closest point on a 3D triangle (vertex, edge and face Voronoi regions).
        Point a=triangle.vertices[0],b=triangle.vertices[1],c=triangle.vertices[2];
        double[] ab=sub(b,a),ac=sub(c,a),ap=sub(p,a);double d1=dot(ab,ap),d2=dot(ac,ap);
        if(d1<=0 && d2<=0)return a;
        double[] bp=sub(p,b);double d3=dot(ab,bp),d4=dot(ac,bp);if(d3>=0 && d4<=d3)return b;
        double vc=d1*d4-d3*d2;if(vc<=0 && d1>=0 && d3<=0)return along(a,ab,d1/(d1-d3));
        double[] cp=sub(p,c);double d5=dot(ab,cp),d6=dot(ac,cp);if(d6>=0 && d5<=d6)return c;
        double vb=d5*d2-d1*d6;if(vb<=0 && d2>=0 && d6<=0)return along(a,ac,d2/(d2-d6));
        double va=d3*d6-d5*d4;if(va<=0 && d4-d3>=0 && d5-d6>=0)return along(b,sub(c,b),(d4-d3)/((d4-d3)+(d5-d6)));
        double sum=va+vb+vc,v=vb/sum,w=vc/sum;
        return new Point(a.x+ab[0]*v+ac[0]*w,a.y+ab[1]*v+ac[1]*w,a.z+ab[2]*v+ac[2]*w);
    }
    private static double[] sub(Point a,Point b){return new double[]{a.x-b.x,a.y-b.y,a.z-b.z};}
    private static double dot(double[] a,double[] b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
    private static Point along(Point a,double[] v,double t){return new Point(a.x+v[0]*t,a.y+v[1]*t,a.z+v[2]*t);}
}
