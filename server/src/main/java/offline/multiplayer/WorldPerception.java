package offline.multiplayer;

import java.util.ArrayDeque;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import offline.multiplayer.WorldRegistry.Entity;
import offline.multiplayer.WorldRegistry.Kind;
import offline.multiplayer.WorldRegistry.Vector;

/** Bounded, server-directed NPC sight queries; an unobserved ray is never clear. */
final class WorldPerception {
    static final double SIGHT_RADIUS = 60;
    static final long REFRESH_MILLIS = 500, VALID_MILLIS = 1_000, MEMORY_MILLIS = 10_000;
    private static final double POSITION_TOLERANCE = .75, EYE_HEIGHT = 1.5;
    private static final int MAX_CONTACTS = 512, MAX_PER_TICK = 8, MAX_PER_SECOND = 64;

    record Contact(boolean visible, Vector lastSeenPosition, long seenAt) {}
    private record Identity(String npcId, long npcGeneration, String owner, long ownerEpoch,
                            String targetId, long targetGeneration, String targetOwner, long targetOwnerEpoch) {
        static Identity of(Entity npc, Entity target) {
            return new Identity(npc.entityId(), npc.generation(), npc.ownerId(), npc.ownerEpoch(),
                target.entityId(), target.generation(), target.ownerId(), target.ownerEpoch());
        }
    }
    private record Sample(Vector origin, Vector target, long at) {
        boolean matches(Entity npc, Entity victim, long now) {
            return now >= at && now - at < VALID_MILLIS
                && origin.distance(position(npc)) <= POSITION_TOLERANCE
                && target.distance(position(victim)) <= POSITION_TOLERANCE;
        }
    }
    private static final class Track {
        final Identity identity;
        String query;
        Sample pending, clear;
        Vector lastSeen;
        boolean knownBlocked;
        long seenAt = -1, requestedAt = -REFRESH_MILLIS;
        Track(Identity identity) { this.identity = identity; }
    }

    private final WorldCollision collision;
    private final Map<String, Track> tracks = new LinkedHashMap<>();
    private final ArrayDeque<Long> recentQueries = new ArrayDeque<>();
    private long lastTick, budgetTick = -1, queries, confirmed, blocked, unknown, throttled;
    private int tickQueries;

    WorldPerception(WorldCollision collision) { this.collision = Objects.requireNonNull(collision); }

    synchronized Contact observe(Entity npc, Entity target, long now) {
        advance(now);
        Track track = current(npc, target, now, true);
        if (track == null) { unknown++; return new Contact(false, null, -1); }
        WorldCollision.Segment ray = inspect(track, npc, target, now);
        if (ray != null && track.query == null && now - track.requestedAt >= REFRESH_MILLIS) {
            if (takeBudget(now)) {
                track.requestedAt = now;
                track.knownBlocked = false;
                track.pending = new Sample(position(npc), position(target), now);
                track.query = collision.submit(npc.ownerId(), "visibility", List.of(ray), now);
                queries++;
                // Static-only misses return null in the shared collision API, not proof of visibility.
                if (track.query == null) { track.pending = null; track.clear = null; }
                else resolve(track, npc, target, now);
            } else throttled++;
        }
        return contact(track, now);
    }

    /** Rechecks existing evidence for shooting without scheduling another native query. */
    synchronized boolean visible(Entity npc, Entity target, long now) {
        advance(now);
        Track track = current(npc, target, now, false);
        if (track == null) return false;
        inspect(track, npc, target, now);
        return track.clear != null;
    }

    synchronized void retain(Set<String> npcIds) {
        Objects.requireNonNull(npcIds);
        var iterator = tracks.entrySet().iterator();
        while (iterator.hasNext()) {
            var entry = iterator.next();
            if (!npcIds.contains(entry.getKey())) { cancel(entry.getValue()); iterator.remove(); }
        }
    }

    synchronized Map<String, Object> status() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("authority", "server_directed_leased_geometry");
        value.put("sight_radius", SIGHT_RADIUS);
        value.put("tracked_contacts", tracks.size());
        value.put("pending_queries", tracks.values().stream().filter(t -> t.query != null).count());
        value.put("queries", queries);
        value.put("visible_results", confirmed);
        value.put("blocked_results", blocked);
        value.put("unknown_observations", unknown);
        value.put("throttled_queries", throttled);
        value.put("confirmation_valid_ms", VALID_MILLIS);
        value.put("memory_ms", MEMORY_MILLIS);
        return Collections.unmodifiableMap(value);
    }

    private Track current(Entity npc, Entity target, long now, boolean create) {
        if (npc == null) return null;
        Track track = tracks.get(npc.entityId());
        if (!active(npc, now) || npc.playerId() != null || npc.lastInputSequence() < 0
            || !active(target, now) || npc.entityId().equals(target.entityId())) {
            if (track != null) { cancel(track); tracks.remove(npc.entityId()); }
            return null;
        }
        Identity identity = Identity.of(npc, target);
        if (track != null && !track.identity.equals(identity)) {
            cancel(track); tracks.remove(npc.entityId()); track = null;
        }
        if (track == null && create) {
            if (tracks.size() >= MAX_CONTACTS) {
                var iterator = tracks.entrySet().iterator();
                var first = iterator.next(); cancel(first.getValue()); iterator.remove();
            }
            track = new Track(identity); tracks.put(npc.entityId(), track);
        }
        return track;
    }

    /** Static blockers override every cached result, while missing data remains unknown. */
    private WorldCollision.Segment inspect(Track track, Entity npc, Entity target, long now) {
        expireMemory(track, now);
        Vector from = eye(position(npc)), to = eye(position(target));
        if (from == null || to == null || from.distance(to) < .001
            || position(npc).distance(position(target)) > SIGHT_RADIUS) {
            cancel(track); track.clear = null; track.knownBlocked = false; return null;
        }
        WorldCollision.Segment ray = new WorldCollision.Segment(from, to, 0);
        if (collision.first(ray, "visibility") != null) {
            cancel(track); track.clear = null; track.knownBlocked = true; blocked++; return null;
        }
        if (!collision.enabled(npc.ownerId())) {
            cancel(track); track.clear = null; track.knownBlocked = false; return null;
        }
        if (track.clear != null && !track.clear.matches(npc, target, now)) track.clear = null;
        if (track.pending != null && !track.pending.matches(npc, target, now)) {
            cancel(track); track.clear = null; track.knownBlocked = false;
        }
        resolve(track, npc, target, now);
        return ray;
    }

    private void resolve(Track track, Entity npc, Entity target, long now) {
        if (track.query == null) return;
        WorldCollision.Result result = collision.take(track.query);
        if (result == null) return;
        Sample sample = track.pending;
        track.query = null; track.pending = null;
        // New failed/blocked evidence always revokes an older clear result.
        track.clear = null; track.knownBlocked = false;
        if (!result.complete() || result.hits().size() != 1 || sample == null
            || !sample.matches(npc, target, now)) return;
        if (result.hits().get(0) != null) { track.knownBlocked = true; blocked++; return; }
        track.clear = sample; track.lastSeen = sample.target; track.seenAt = sample.at; confirmed++;
    }

    private Contact contact(Track track, long now) {
        expireMemory(track, now);
        if (track.clear == null && !track.knownBlocked) unknown++;
        return new Contact(track.clear != null, track.lastSeen, track.seenAt);
    }

    private static void expireMemory(Track track, long now) {
        if (track.lastSeen != null && now - track.seenAt >= MEMORY_MILLIS) {
            track.lastSeen = null; track.seenAt = -1;
        }
    }

    private void cancel(Track track) {
        if (track.query != null) collision.discard(track.query);
        track.query = null; track.pending = null;
    }

    private boolean takeBudget(long now) {
        if (budgetTick != now) { budgetTick = now; tickQueries = 0; }
        while (!recentQueries.isEmpty() && now - recentQueries.peekFirst() >= 1_000) recentQueries.removeFirst();
        if (tickQueries >= MAX_PER_TICK || recentQueries.size() >= MAX_PER_SECOND) return false;
        tickQueries++; recentQueries.addLast(now); return true;
    }

    private void advance(long now) {
        if (now < 0 || now < lastTick) throw new IllegalArgumentException("Perception requires monotonic server time");
        lastTick = now;
    }

    private static boolean active(Entity entity, long now) {
        return entity != null && entity.kind() == Kind.PED && entity.components() != null
            && entity.components().combat() != null && entity.components().combat().alive()
            && entity.ownerId() != null && entity.leaseUntilTick() > now
            && (entity.playerId() == null || entity.playerId().equals(entity.ownerId()));
    }
    private static Vector position(Entity entity) { return entity.components().transform().position(); }
    private static Vector eye(Vector position) {
        // Refuse unrepresentable eye points instead of overflowing Registry coordinate bounds.
        return position.z() + EYE_HEIGHT > 16_000 ? null
            : new Vector(position.x(), position.y(), position.z() + EYE_HEIGHT);
    }
}
