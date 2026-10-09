package offline.multiplayer;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import offline.multiplayer.WorldRegistry.Entity;
import offline.multiplayer.WorldRegistry.Kind;
import offline.multiplayer.WorldRegistry.Vector;

/**
 * Population simulation ownership policy, evaluated against confirmed world positions.
 * This class only returns decisions: the service applies the Registry transactions and
 * sends ready offers. A car and its NPC occupants always share one simulation owner.
 */
public final class WorldOwnership {
    public static final double ENTER_RADIUS = 300;
    public static final double LEAVE_RADIUS = 400;

    private WorldOwnership() {}

    public record PendingOffer(String ownerId, long deadline) {}
    /** A null owner means release these leases and keep the last confirmed transforms. */
    public record Decision(String anchorId, List<String> entityIds, String ownerId) {
        public Decision { entityIds = List.copyOf(entityIds); }
    }

    /**
     * Retain an eligible current owner within 400 m, even when another player is closer.
     * New owners must be within 300 m. The distance gap prevents boundary oscillation;
     * invalid or expired player leases are never retained. Pending ready offers with a
     * valid lease count as existing ownership and are not reissued on every service tick.
     */
    public static List<Decision> decide(long now, Collection<Entity> snapshot,
                                        Set<String> managedEntityIds, Set<String> participants,
                                        Map<String, PendingOffer> pendingOffers) {
        Objects.requireNonNull(snapshot); Objects.requireNonNull(managedEntityIds);
        Objects.requireNonNull(participants); Objects.requireNonNull(pendingOffers);
        Map<String, Entity> entities = new HashMap<>();
        Map<String, Entity> players = new TreeMap<>();
        for (Entity entity : snapshot) {
            entities.put(entity.entityId(), entity);
            if (entity.playerId() != null && participants.contains(entity.playerId())
                    && entity.playerId().equals(entity.ownerId()) && entity.leaseUntilTick() > now
                    && alive(entity)) players.put(entity.playerId(), entity);
        }

        Map<String, List<Entity>> groups = new TreeMap<>();
        for (String id : new TreeSet<>(managedEntityIds)) {
            Entity entity = entities.get(id);
            if (entity == null || entity.playerId() != null || entity.kind() == Kind.OBJECT) continue;
            Entity anchor = entity;
            if (entity.components().attachment() != null) {
                anchor = entities.get(entity.components().attachment().entityId());
                // A different subsystem's vehicle also owns its attached NPC simulation.
                if (anchor == null || !managedEntityIds.contains(anchor.entityId())) continue;
            }
            if (groups.containsKey(anchor.entityId())) continue;
            List<Entity> group = new ArrayList<>(); group.add(anchor);
            if (anchor.kind() == Kind.VEHICLE) {
                for (Map.Entry<String, String> seat : anchor.components().vehicle().seats().entrySet()) {
                    Entity occupant = entities.get(seat.getValue());
                    if (occupant != null && occupant.playerId() == null && occupant.kind() == Kind.PED
                            && occupant.components().attachment() != null
                            && anchor.entityId().equals(occupant.components().attachment().entityId())
                            && seat.getKey().equals(occupant.components().attachment().seat())) group.add(occupant);
                }
            }
            group.sort(Comparator.comparing(Entity::entityId));
            groups.put(anchor.entityId(), group);
        }

        List<Decision> decisions = new ArrayList<>();
        for (Map.Entry<String, List<Entity>> entry : groups.entrySet()) {
            Entity anchor = entities.get(entry.getKey()); List<Entity> group = entry.getValue();
            String owner = selectOwner(now, anchor, group, entities, players);
            boolean changed = false;
            for (Entity member : group) {
                PendingOffer pending = pendingOffers.get(member.entityId());
                if (owner == null) {
                    changed |= member.ownerId() != null || pending != null;
                } else {
                    changed |= !owner.equals(member.ownerId()) || member.leaseUntilTick() <= now;
                    // A stale offer must be cleared/replaced, not silently mark a new owner ready.
                    changed |= pending != null && (!owner.equals(pending.ownerId()) || pending.deadline() <= now);
                }
            }
            if (changed) decisions.add(new Decision(anchor.entityId(),
                group.stream().map(Entity::entityId).toList(), owner));
        }
        return List.copyOf(decisions);
    }

    private static String selectOwner(long now, Entity anchor, List<Entity> group,
                                      Map<String, Entity> entities, Map<String, Entity> players) {
        if (anchor.kind() == Kind.PED && !alive(anchor)) return null;
        if (anchor.kind() == Kind.VEHICLE) {
            Entity driver = entities.get(anchor.components().vehicle().seats().get("driver"));
            if (driver != null && driver.playerId() != null) {
                // Never hand a player-driven car or its NPC passengers to a bystander.
                return players.containsKey(driver.playerId()) ? driver.playerId() : null;
            }
        }
        String retained = retainedOwner(now, anchor, anchor, players);
        if (retained != null) return retained;
        // Repair a partially assigned group without needlessly transferring its ready NPCs.
        if (anchor.ownerId() == null) for (Entity member : group) {
            retained = retainedOwner(now, member, anchor, players);
            if (retained != null) return retained;
        }
        String owner = null; double nearest = ENTER_RADIUS;
        for (Map.Entry<String, Entity> player : players.entrySet()) {
            double distance = position(anchor).distance(position(player.getValue()));
            if (distance <= nearest && (owner == null || distance < nearest)) {
                owner = player.getKey(); nearest = distance;
            }
        }
        return owner;
    }

    private static String retainedOwner(long now, Entity member, Entity anchor, Map<String, Entity> players) {
        if (member.ownerId() == null) return null;
        Entity player = players.get(member.ownerId());
        return member.leaseUntilTick() > now && player != null
            && position(anchor).distance(position(player)) <= LEAVE_RADIUS ? member.ownerId() : null;
    }
    private static boolean alive(Entity entity) {
        return entity.components().combat() != null && entity.components().combat().alive();
    }
    private static Vector position(Entity entity) { return entity.components().transform().position(); }
}
