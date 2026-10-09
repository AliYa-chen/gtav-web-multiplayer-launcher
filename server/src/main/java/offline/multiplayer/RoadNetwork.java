package offline.multiplayer;

import java.io.BufferedInputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.TreeSet;

/** Installed-game vehicle centrelines. Never used as wall collision or a ped navmesh. */
final class RoadNetwork {
    static final int DISABLED = 1, WATER = 2, HIGHWAY = 4, NO_GPS = 8, TUNNEL = 16,
        OFF_ROAD = 32, NO_LEFT = 64, LEFT_ONLY = 128, NO_RIGHT = 256, NO_BIG_VEHICLES = 512;
    private static final int NODE_BYTES = 24, LINK_BYTES = 20;
    private static final double CELL = 64, MAX_SNAP = 1_000;
    private static final int MAX_VISITED = 20_000;

    record Point(double x, double y, double z) {
        Point {
            if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(z)
                || Math.abs(x) > 100_000 || Math.abs(y) > 100_000 || Math.abs(z) > 100_000)
                throw new IllegalArgumentException("Road point must be finite and within world bounds");
        }
        double distance(Point other) {
            return Math.sqrt(square(x - other.x) + square(y - other.y) + square(z - other.z));
        }
    }
    record Node(Point position, int flags, int speedClass, int special, int density, long streetHash) {}
    record Link(int fromNode, int toNode, double width, int lanesIn, int lanesOut, int flags) {}
    record Snap(int linkIndex, int fromNode, int toNode, Point position, double fraction, double distance) {}
    record Route(List<Point> points, double length, boolean reached, int visited, String reason) {
        Route { points = List.copyOf(points); }
    }
    private record Arc(int target, double length) {}
    private record Open(int node, double distance, double estimate) implements Comparable<Open> {
        @Override public int compareTo(Open other) {
            int order = Double.compare(estimate, other.estimate);
            return order == 0 ? Integer.compare(node, other.node) : order;
        }
    }

    private final Node[] nodes;
    private final Link[] links;
    private final List<Arc>[] adjacency;
    private final Map<Long, int[]> cells;
    private final int activeLinks;
    private final String sourceSha;

    @SuppressWarnings("unchecked")
    private RoadNetwork(Node[] nodes, Link[] links, String sourceSha) {
        this.nodes = nodes;
        this.links = links;
        this.sourceSha = sourceSha;
        this.adjacency = (List<Arc>[]) new List<?>[nodes.length];
        for (int i = 0; i < nodes.length; i++) adjacency[i] = new ArrayList<>();
        Map<Long, List<Integer>> index = new HashMap<>();
        int usable = 0;
        for (int i = 0; i < links.length; i++) {
            Link link = links[i];
            // In/Out fields are preserved exactly. Their orientation relative to
            // the authoring reference order is not established in this build.
            // Never invent the direction of a one-way street.
            if (!usable(link)) continue;
            Point a = nodes[link.fromNode].position, b = nodes[link.toNode].position;
            double length = a.distance(b);
            int minX = cell(Math.min(a.x, b.x)), maxX = cell(Math.max(a.x, b.x));
            int minY = cell(Math.min(a.y, b.y)), maxY = cell(Math.max(a.y, b.y));
            if (length < .001 || (long) (maxX - minX + 1) * (maxY - minY + 1) > 4096) continue;
            adjacency[link.fromNode].add(new Arc(link.toNode, length));
            adjacency[link.toNode].add(new Arc(link.fromNode, length));
            usable++;
            for (int x = minX; x <= maxX; x++) for (int y = minY; y <= maxY; y++)
                index.computeIfAbsent(key(x, y), ignored -> new ArrayList<>()).add(i);
        }
        this.activeLinks = usable;
        Map<Long, int[]> packed = new HashMap<>();
        index.forEach((key, value) -> packed.put(key, value.stream().mapToInt(Integer::intValue).toArray()));
        this.cells = Map.copyOf(packed);
    }

    static RoadNetwork empty() { return new RoadNetwork(new Node[0], new Link[0], ""); }

    static RoadNetwork load(Path path) throws IOException {
        long size = Files.size(path);
        if (size < 48) throw new IOException("Truncated road network header");
        try (DataInputStream input = new DataInputStream(new BufferedInputStream(Files.newInputStream(path)))) {
            if (!Arrays.equals(input.readNBytes(8), "GTAROAD1".getBytes(java.nio.charset.StandardCharsets.US_ASCII)))
                throw new IOException("Unsupported road network format");
            int nodeCount = input.readInt(), linkCount = input.readInt();
            if (nodeCount < 1 || nodeCount > 1_000_000 || linkCount < 1 || linkCount > 4_000_000
                || size != 48L + (long) nodeCount * NODE_BYTES + (long) linkCount * LINK_BYTES)
                throw new IOException("Invalid road network record counts or size");
            String sourceSha = HexFormat.of().formatHex(input.readNBytes(32));
            Node[] nodes = new Node[nodeCount];
            for (int i = 0; i < nodeCount; i++) {
                float x = input.readFloat(), y = input.readFloat(), z = input.readFloat();
                int flags = input.readInt(), speed = input.readUnsignedByte(), special = input.readUnsignedByte();
                int density = input.readUnsignedByte(), reserved = input.readUnsignedByte();
                long street = Integer.toUnsignedLong(input.readInt());
                if (!Float.isFinite(x) || !Float.isFinite(y) || !Float.isFinite(z)
                    || Math.abs(x) > 100_000 || Math.abs(y) > 100_000 || Math.abs(z) > 100_000
                    || (flags & ~8191) != 0 || density > 15 || reserved != 0)
                    throw new IOException("Invalid road node " + i);
                nodes[i] = new Node(new Point(x, y, z), flags, speed, special, density, street);
            }
            Link[] links = new Link[linkCount];
            for (int i = 0; i < linkCount; i++) {
                int a = input.readInt(), b = input.readInt();
                float width = input.readFloat();
                int lanesIn = input.readUnsignedShort(), lanesOut = input.readUnsignedShort(), flags = input.readInt();
                if (a < 0 || a >= nodeCount || b < 0 || b >= nodeCount || !Float.isFinite(width)
                    || Math.abs(width) > 1_000 || (flags & ~31) != 0)
                    throw new IOException("Invalid road link " + i);
                links[i] = new Link(a, b, width, lanesIn, lanesOut, flags);
            }
            return new RoadNetwork(nodes, links, sourceSha);
        }
    }

    int nodeCount() { return nodes.length; }
    int linkCount() { return links.length; }
    int activeLinkCount() { return activeLinks; }
    Node node(int index) { return nodes[index]; }
    Link link(int index) { return links[index]; }

    /** GTA heading for this two-way link's from-to tangent; this chooses one legal direction. */
    double heading(Snap snap) {
        Link link = links[snap.linkIndex];
        Point a = nodes[link.fromNode].position, b = nodes[link.toNode].position;
        return (Math.toDegrees(Math.atan2(-(b.x - a.x), b.y - a.y)) + 360) % 360;
    }

    private boolean usable(Link link) {
        if ((link.flags & 16) != 0 || link.lanesIn == 0 || link.lanesOut == 0) return false;
        // Turn restrictions need an incoming-edge state. Until native semantics
        // are verified, exclude those junctions rather than route through them.
        int excluded = DISABLED | WATER | NO_GPS | NO_LEFT | LEFT_ONLY | NO_RIGHT;
        return (nodes[link.fromNode].flags & excluded) == 0 && (nodes[link.toNode].flags & excluded) == 0;
    }

    /** Nearest usable segment in 3D, preserving bridge/tunnel road-reference height. */
    Snap nearest(Point position, double maxDistance) {
        if (!Double.isFinite(maxDistance) || maxDistance <= 0 || maxDistance > MAX_SNAP)
            throw new IllegalArgumentException("Road snap distance must be in (0, 1000]");
        TreeSet<Integer> candidates = new TreeSet<>();
        for (int x = cell(position.x - maxDistance); x <= cell(position.x + maxDistance); x++)
            for (int y = cell(position.y - maxDistance); y <= cell(position.y + maxDistance); y++) {
                int[] values = cells.get(key(x, y));
                if (values != null) for (int value : values) candidates.add(value);
            }
        Snap best = null;
        double bestDistance = maxDistance;
        for (int index : candidates) {
            Link link = links[index];
            Point a = nodes[link.fromNode].position, b = nodes[link.toNode].position;
            double dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
            double fraction = Math.max(0, Math.min(1, ((position.x - a.x) * dx + (position.y - a.y) * dy
                + (position.z - a.z) * dz) / (dx * dx + dy * dy + dz * dz)));
            Point point = new Point(a.x + fraction * dx, a.y + fraction * dy, a.z + fraction * dz);
            double distance = point.distance(position);
            if (distance <= bestDistance && (best == null || distance < bestDistance || index < best.linkIndex)) {
                bestDistance = distance;
                best = new Snap(index, link.fromNode, link.toNode, point, fraction, distance);
            }
        }
        return best;
    }

    /** Bounded A* over verified two-way road links; failed routes never become straight-line movement. */
    Route route(Point start, Point destination, double snapDistance, int maxVisited) {
        if (maxVisited < 1 || maxVisited > MAX_VISITED)
            throw new IllegalArgumentException("Road route budget must be in [1, 20000]");
        if (activeLinks == 0) return failed("unavailable", 0);
        Snap first = nearest(start, snapDistance), last = nearest(destination, snapDistance);
        if (first == null || last == null) return failed("off_road", 0);
        if (first.linkIndex == last.linkIndex)
            return new Route(List.of(first.position, last.position), first.position.distance(last.position), true, 0, "ok");
        double[] distance = new double[nodes.length];
        Arrays.fill(distance, Double.POSITIVE_INFINITY);
        int[] previous = new int[nodes.length];
        Arrays.fill(previous, -1);
        boolean[] closed = new boolean[nodes.length];
        PriorityQueue<Open> queue = new PriorityQueue<>();
        for (int node : new int[]{first.fromNode, first.toNode}) {
            distance[node] = first.position.distance(nodes[node].position);
            queue.add(new Open(node, distance[node], distance[node] + nodes[node].position.distance(last.position)));
        }
        int visited = 0, endNode = -1;
        double best = Double.POSITIVE_INFINITY;
        while (!queue.isEmpty()) {
            Open current = queue.poll();
            if (current.estimate >= best) break;
            if (closed[current.node] || current.distance != distance[current.node]) continue;
            if (visited >= maxVisited) return failed("route_budget", visited);
            closed[current.node] = true;
            visited++;
            if (current.node == last.fromNode || current.node == last.toNode) {
                double total = current.distance + nodes[current.node].position.distance(last.position);
                if (total < best) { best = total; endNode = current.node; }
            }
            for (Arc arc : adjacency[current.node]) {
                if (closed[arc.target]) continue;
                double next = current.distance + arc.length;
                if (next >= distance[arc.target]) continue;
                distance[arc.target] = next;
                previous[arc.target] = current.node;
                queue.add(new Open(arc.target, next, next + nodes[arc.target].position.distance(last.position)));
            }
        }
        if (endNode < 0) return failed("disconnected", visited);
        List<Point> path = new ArrayList<>();
        path.add(last.position);
        for (int node = endNode; node != -1; node = previous[node]) path.add(nodes[node].position);
        path.add(first.position);
        Collections.reverse(path);
        List<Point> distinct = new ArrayList<>();
        for (Point point : path)
            if (distinct.isEmpty() || point.distance(distinct.get(distinct.size() - 1)) > .001) distinct.add(point);
        return new Route(distinct, best, true, visited, "ok");
    }

    /** A bounded, deterministic road-following course for ambient traffic. */
    Route cruise(Point start, double headingDegrees, double snapDistance, double wantedDistance, int seed) {
        if (!Double.isFinite(headingDegrees) || !Double.isFinite(wantedDistance)
            || wantedDistance <= 0 || wantedDistance > 500)
            throw new IllegalArgumentException("Invalid road cruise request");
        if (activeLinks == 0) return failed("unavailable", 0);
        Snap snap = nearest(start, snapDistance);
        if (snap == null) return failed("off_road", 0);
        double angle = Math.toRadians(headingDegrees), dx = -Math.sin(angle), dy = Math.cos(angle);
        Point a = nodes[snap.fromNode].position, b = nodes[snap.toNode].position;
        double score = (b.x - a.x) * dx + (b.y - a.y) * dy;
        int first = score > 0 || score == 0 && (seed & 1) == 0 ? snap.toNode : snap.fromNode;
        int second = first == snap.toNode ? snap.fromNode : snap.toNode;
        Route preferred = cruiseFrom(snap, first, second, wantedDistance, seed, dx, dy);
        if (preferred.length >= Math.min(12, wantedDistance)) return preferred;
        Route alternative = cruiseFrom(snap, second, first, wantedDistance, seed, dx, dy);
        return alternative.length > preferred.length ? alternative : preferred;
    }

    private Route cruiseFrom(Snap start, int current, int previous, double wantedDistance, int seed,
                             double forwardX, double forwardY) {
        List<Point> points = new ArrayList<>(); points.add(start.position);
        Point point = start.position;
        double length = 0;
        var visited = new HashSet<Integer>(); visited.add(previous);
        for (int budget = 0; budget < 128; budget++) {
            Point destination = nodes[current].position;
            double segment = point.distance(destination);
            if (length + segment >= wantedDistance && segment > .001) {
                double fraction = (wantedDistance - length) / segment;
                points.add(interpolate(point, destination, fraction));
                return new Route(points, wantedDistance, true, visited.size(), "ok");
            }
            if (segment > .001) {
                forwardX = destination.x - point.x; forwardY = destination.y - point.y;
                points.add(destination); length += segment;
            }
            if (!visited.add(current)) break;
            Arc next = null; double best = -Double.MAX_VALUE; int bestTie = 0;
            for (Arc arc : adjacency[current]) {
                if (visited.contains(arc.target)) continue;
                Point candidate = nodes[arc.target].position;
                double candidateScore = ((candidate.x - destination.x) * forwardX
                    + (candidate.y - destination.y) * forwardY) / arc.length;
                int tie = Integer.rotateLeft(arc.target ^ seed, 11);
                if (next == null || candidateScore > best || candidateScore == best && tie < bestTie) {
                    next = arc; best = candidateScore; bestTie = tie;
                }
            }
            if (next == null) break;
            previous = current; current = next.target; point = destination;
        }
        return length > 1 ? new Route(points, length, true, visited.size(), "ok") : failed("road_end", visited.size());
    }

    private static Point interpolate(Point a, Point b, double fraction) {
        return new Point(a.x + (b.x - a.x) * fraction, a.y + (b.y - a.y) * fraction,
            a.z + (b.z - a.z) * fraction);
    }

    Map<String, Object> metadata() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("model", "installed_vehicle_centrelines");
        result.put("available", activeLinks > 0);
        result.put("nodes", nodeCount()); result.put("links", linkCount()); result.put("routable_links", activeLinks);
        result.put("source_sha256", sourceSha);
        result.put("routing_policy", "two_way_enabled_road_links_without_unverified_turns");
        result.put("ped_navmesh", false); result.put("terrain_collision", false);
        return Map.copyOf(result);
    }

    private static Route failed(String reason, int visited) { return new Route(List.of(), 0, false, visited, reason); }
    private static double square(double value) { return value * value; }
    private static int cell(double value) { return (int) Math.floor(value / CELL); }
    private static long key(int x, int y) { return ((long) x << 32) ^ (y & 0xFFFFFFFFL); }
}
