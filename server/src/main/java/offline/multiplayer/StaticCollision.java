package offline.multiplayer;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import offline.multiplayer.WorldRegistry.Vector;

/** Read-only world-space triangles extracted from this game's YBN resources. */
final class StaticCollision {
    private record Node(float[] bounds,int from,int to,Node left,Node right) {}
    private final float[] triangles;
    private final int[] materials,order;
    private final Node root;
    private final double[] coverage;
    private StaticCollision(float[] triangles,int[] materials,double[] coverage){
        this.triangles=triangles;this.materials=materials;this.coverage=coverage;
        order=new int[materials.length];for(int i=0;i<order.length;i++)order[i]=i;
        root=order.length==0?null:build(0,order.length);
    }
    static StaticCollision empty(){return new StaticCollision(new float[0],new int[0],new double[6]);}
    static StaticCollision load(Path path)throws IOException{
        try(DataInputStream in=new DataInputStream(new BufferedInputStream(Files.newInputStream(path)))){
            if(!Arrays.equals(in.readNBytes(8),"GTACOL1\n".getBytes(java.nio.charset.StandardCharsets.US_ASCII)))throw new IOException("无效碰撞数据格式");
            double[] coverage=new double[6];for(int i=0;i<6;i++){coverage[i]=in.readDouble();if(!Double.isFinite(coverage[i]))throw new IOException("无效碰撞范围");}
            for(int i=0;i<3;i++)if(coverage[i]>coverage[i+3])throw new IOException("无效碰撞范围");
            int count=in.readInt();if(count<0 || count>8_000_000 || Files.size(path)!=60L+count*40L)throw new IOException("无效碰撞三角形数量");
            float[] triangles=new float[Math.multiplyExact(count,9)];int[] materials=new int[count];
            for(int i=0;i<count;i++){
                for(int j=0;j<9;j++){float f=in.readFloat();if(!Float.isFinite(f)||Math.abs(f)>16000)throw new IOException("无效三角形坐标");triangles[i*9+j]=f;}
                materials[i]=in.readInt();
            }
            return new StaticCollision(triangles,materials,coverage);
        }
    }
    private Node build(int from,int to){
        float[] bounds={Float.POSITIVE_INFINITY,Float.POSITIVE_INFINITY,Float.POSITIVE_INFINITY,
            Float.NEGATIVE_INFINITY,Float.NEGATIVE_INFINITY,Float.NEGATIVE_INFINITY};
        for(int i=from;i<to;i++)for(int v=0;v<3;v++)for(int axis=0;axis<3;axis++){
            float f=triangles[order[i]*9+v*3+axis];bounds[axis]=Math.min(bounds[axis],f);bounds[axis+3]=Math.max(bounds[axis+3],f);
        }
        if(to-from<=16)return new Node(bounds,from,to,null,null);
        int axis=0;for(int i=1;i<3;i++)if(bounds[i+3]-bounds[i]>bounds[axis+3]-bounds[axis])axis=i;
        int mid=(from+to)>>>1;partition(from,to-1,mid,axis);
        return new Node(bounds,from,to,build(from,mid),build(mid,to));
    }
    private float centroid(int item,int axis){int off=item*9+axis;return triangles[off]+triangles[off+3]+triangles[off+6];}
    private void partition(int low,int high,int k,int axis){
        while(low<high){float pivot=centroid(order[(low+high)>>>1],axis);int i=low,j=high;
            while(i<=j){while(centroid(order[i],axis)<pivot)i++;while(centroid(order[j],axis)>pivot)j--;
                if(i<=j){int t=order[i];order[i++]=order[j];order[j--]=t;}}
            if(k<=j)high=j;else if(k>=i)low=i;else return;
        }
    }
    WorldCollision.Hit first(WorldCollision.Segment segment){
        return first(segment,"");
    }
    WorldCollision.Hit first(WorldCollision.Segment segment,String purpose){
        if(root==null)return null;
        double[] ray={segment.to().x()-segment.from().x(),segment.to().y()-segment.from().y(),segment.to().z()-segment.from().z()};
        double[] nearest={1.000001};int[] selected={-1};search(root,segment,ray,nearest,selected,purpose);
        if(selected[0]<0)return null;int at=selected[0]*9;
        double ax=triangles[at+3]-triangles[at],ay=triangles[at+4]-triangles[at+1],az=triangles[at+5]-triangles[at+2];
        double bx=triangles[at+6]-triangles[at],by=triangles[at+7]-triangles[at+1],bz=triangles[at+8]-triangles[at+2];
        double nx=ay*bz-az*by,ny=az*bx-ax*bz,nz=ax*by-ay*bx,norm=Math.sqrt(nx*nx+ny*ny+nz*nz);
        if(norm<1e-12)return null;double sign=nx*ray[0]+ny*ray[1]+nz*ray[2]>0?-1:1;
        return new WorldCollision.Hit(WorldCollision.interpolate(segment,nearest[0]),new Vector(sign*nx/norm,sign*ny/norm,sign*nz/norm),Integer.toUnsignedLong(materials[selected[0]]));
    }
    private void search(Node node,WorldCollision.Segment segment,double[] ray,double[] nearest,int[] selected,String purpose){
        if(!intersects(node.bounds,segment.from(),ray,nearest[0]))return;
        if(node.left!=null){search(node.left,segment,ray,nearest,selected,purpose);search(node.right,segment,ray,nearest,selected,purpose);return;}
        for(int i=node.from;i<node.to;i++){int id=order[i];MaterialCatalog.Material material=MaterialCatalog.byCode(Integer.toUnsignedLong(materials[id]));
            if(material!=null && (("shot".equals(purpose)&&material.shootThru()) || ("visibility".equals(purpose)&&material.seeThru())))continue;
            double t=triangle(id,segment.from(),ray);
            if(t>=.000001 && t<=1 && t<nearest[0]){nearest[0]=t;selected[0]=id;}}
    }
    private static boolean intersects(float[] b,Vector start,double[] d,double nearest){
        double lo=0,hi=nearest;double[] p={start.x(),start.y(),start.z()};
        for(int a=0;a<3;a++){if(Math.abs(d[a])<1e-12){if(p[a]<b[a]||p[a]>b[a+3])return false;continue;}
            double t1=(b[a]-p[a])/d[a],t2=(b[a+3]-p[a])/d[a];lo=Math.max(lo,Math.min(t1,t2));hi=Math.min(hi,Math.max(t1,t2));if(lo>hi)return false;}
        return true;
    }
    private double triangle(int id,Vector p,double[] d){
        int at=id*9;double ex=triangles[at+3]-triangles[at],ey=triangles[at+4]-triangles[at+1],ez=triangles[at+5]-triangles[at+2];
        double fx=triangles[at+6]-triangles[at],fy=triangles[at+7]-triangles[at+1],fz=triangles[at+8]-triangles[at+2];
        double hx=d[1]*fz-d[2]*fy,hy=d[2]*fx-d[0]*fz,hz=d[0]*fy-d[1]*fx,det=ex*hx+ey*hy+ez*hz;
        if(Math.abs(det)<1e-10)return -1;double inverse=1/det,sx=p.x()-triangles[at],sy=p.y()-triangles[at+1],sz=p.z()-triangles[at+2];
        double u=(sx*hx+sy*hy+sz*hz)*inverse;if(u<0||u>1)return -1;
        double qx=sy*ez-sz*ey,qy=sz*ex-sx*ez,qz=sx*ey-sy*ex;
        double v=(d[0]*qx+d[1]*qy+d[2]*qz)*inverse;if(v<0||u+v>1)return -1;
        return (fx*qx+fy*qy+fz*qz)*inverse;
    }
    Map<String,Object> metadata(){return WorldService.map("triangles",materials.length,"bounds",Arrays.stream(coverage).boxed().toList(),
        "complete_world",false,"source","extracted_ybn_triangles");}
}
