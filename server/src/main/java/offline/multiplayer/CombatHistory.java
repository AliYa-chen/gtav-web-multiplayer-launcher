package offline.multiplayer;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.Objects;

/** Bounded history of accepted server state; these are protocol limits, not native physics constants. */
final class CombatHistory {
    static final long MAX_REWIND_MILLIS = 250;
    // Millisecond ticks have at most 251 distinct values in the inclusive
    // rewind window. Keep all of them even when many clients publish cuts.
    private static final int MAX_FRAMES = 256;
    private final Deque<WorldRegistry.Snapshot> frames = new ArrayDeque<>();

    record Fence(String worldEpoch, String entityId, long generation, long ownerEpoch,
                 String ownerId, long model, int deaths, WorldRegistry.Attachment attachment,
                 long parentGeneration, long parentOwnerEpoch) {}

    static Fence fence(WorldRegistry.Entity entity, WorldRegistry world) {
        WorldRegistry.Attachment attachment = entity.components().attachment();
        WorldRegistry.Entity parent = attachment == null ? null : world.entity(attachment.entityId());
        return new Fence(world.worldEpoch(), entity.entityId(), entity.generation(), entity.ownerEpoch(),
            entity.ownerId(), entity.model(), entity.components().combat() == null ? -1 : entity.components().combat().deaths(),
            attachment, parent == null ? -1 : parent.generation(), parent == null ? -1 : parent.ownerEpoch());
    }

    static boolean matches(Fence fence, WorldRegistry world) {
        WorldRegistry.Entity current = world.entity(fence.entityId());
        return current != null && fence.equals(fence(current, world));
    }

    void capture(WorldRegistry world, long now) {
        WorldRegistry.Snapshot current = world.snapshot();
        WorldRegistry.Snapshot snapshot = new WorldRegistry.Snapshot(current.worldEpoch(), current.cutRevision(), now,
            current.entities(), current.tombstones());
        if (!frames.isEmpty() && !frames.peekLast().worldEpoch().equals(snapshot.worldEpoch())) frames.clear();
        if (!frames.isEmpty() && frames.peekLast().worldTick() == snapshot.worldTick()) frames.removeLast();
        frames.addLast(snapshot);
        while (frames.size() > MAX_FRAMES || (!frames.isEmpty() && now - frames.peekFirst().worldTick() > MAX_REWIND_MILLIS))
            frames.removeFirst();
    }

    WorldRegistry.Snapshot at(long tick, long now) {
        if (tick > now || now - tick > MAX_REWIND_MILLIS) return null;
        // The supplied time must identify a real server baseline; arbitrary client timestamps cannot choose an interpolated pose.
        for (WorldRegistry.Snapshot frame : frames) if (frame.worldTick() == tick) return frame;
        return null;
    }

    static boolean sameLifetime(WorldRegistry.Entity historical, WorldRegistry.Entity current,
                                WorldRegistry.Snapshot snapshot, WorldRegistry world) {
        if (current == null || !snapshot.worldEpoch().equals(world.worldEpoch())
                || historical.generation() != current.generation() || historical.ownerEpoch() != current.ownerEpoch()
                || historical.model() != current.model() || !Objects.equals(historical.ownerId(), current.ownerId())
                || !Objects.equals(historical.components().attachment(), current.components().attachment())) return false;
        var oldLife = historical.components().combat();
        var life = current.components().combat();
        if (oldLife != null && (life == null || !oldLife.alive() || !life.alive() || oldLife.deaths() != life.deaths())) return false;
        var attachment = historical.components().attachment();
        if (attachment != null) {
            var oldParent = snapshot.entities().stream().filter(e -> e.entityId().equals(attachment.entityId())).findFirst().orElse(null);
            var parent = world.entity(attachment.entityId());
            if (oldParent == null || parent == null || oldParent.generation() != parent.generation()
                    || oldParent.ownerEpoch() != parent.ownerEpoch()) return false;
        }
        return true;
    }

    List<WorldRegistry.Entity> eligible(WorldRegistry.Snapshot snapshot, WorldRegistry world) {
        return snapshot.entities().stream().filter(entity -> sameLifetime(entity, world.entity(entity.entityId()), snapshot, world)).toList();
    }
}
