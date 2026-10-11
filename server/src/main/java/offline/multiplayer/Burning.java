package offline.multiplayer;

import java.util.ArrayList;
import java.util.List;

/** Prepared engine fire arithmetic, not yet connected to CombatWorld. Geometry,
 * ownership, immunity, water and
 * entity-generation checks belong to the caller; no client-supplied damage,
 * heat, lifetime or pickup quantity is accepted here. See docs/fire-authority.md.
 */
final class Burning {
    private Burning() {}
    static final String ENGINE_SHA256 = "11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0";
    static final float DAMAGE_PER_SECOND = 18.75f;
    static final float EXPLOSION_RADIUS_RATIO = .38f;

    enum Ignition { NONE, NEAR_FIRE, EXPLOSION }

    /** Call only after the native blast contact/occlusion requirements pass.
     * distance is the PED entity-origin distance, not its closest body surface.
     * The supported PSO omits bCanSetPlayerOnFire and bIgnoreRatioCheckForFire;
     * both corresponding native parser defaults are false.
     */
    static Ignition explosionIgnition(ExplosionCatalog.Rule rule, WeaponPhysics.Physics weapon,
            boolean player, double elapsedSeconds, double distance, double scale) {
        finiteNonnegative(elapsedSeconds); finiteNonnegative(distance); finiteNonnegative(scale);
        if (rule == null || (float)elapsedSeconds > .1f) return Ignition.NONE;
        if (weapon != null && "FIRE".equals(weapon.damageType()) || "EXP_TAG_DIR_FLAME".equals(rule.tag()))
            return Ignition.NEAR_FIRE;
        if (player || !rule.bCanSetPedOnFire()) return Ignition.NONE;
        float radius = (float)rule.endRadius() * (float)scale * EXPLOSION_RADIUS_RATIO;
        return (float)distance <= radius ? Ignition.EXPLOSION : Ignition.NONE;
    }

    static int scanIntervalMillis(boolean fast) { return fast ? 50 : 500; }

    /** Native first scan jitter uses the low sixteen bits of rand(). */
    static int firstScanDelayMillis(int randomValue) { return (int)((randomValue & 65535) * 0x1p-16f * 500f); }

    /** Native multiply-with-carry random arithmetic, seeded by the server.
     * This reproduces the distributions and sampling order without allowing
     * clients to choose a fire count, duration or position.
     */
    static final class NativeRandom {
        private long state;
        NativeRandom(long seed) { state = seed; }
        int next() {
            state = (state & 0xffffffffL) * 1557985959L + (state >>> 32);
            return (int)state;
        }
        float unit() { return (next() & 0x7fffff) * 0x1p-23f; }
        float between(float minimum, float maximum) { return unit() * (maximum - minimum) + minimum; }
        int between(int minimum, int maximum) { return minimum + (next() & 0x7fffffff) % (maximum - minimum + 1); }
    }

    record SurfaceSeed(List<Double> from, List<Double> to, float lifetime, float strength,
            float peakTime, float fuel, float burnRate) {}

    /** Original CVfxExplosion map-fire candidates for player weapon blasts.
     * Each candidate still requires a verified two-metre downward contact and
     * the source-to-contact obstruction test before becoming a shared fire.
     * The separate vehicle-wreck explosion placement branch is not used here.
     */
    static List<SurfaceSeed> surfaceSeeds(ExplosionCatalog.Rule explosion, WeaponPhysics.Physics weapon,
            List<Double> origin, NativeRandom random) {
        if (explosion == null || random == null || origin == null || origin.size() != 3
                || origin.stream().anyMatch(v -> v == null || !Double.isFinite(v) || Math.abs(v) > 16000))
            throw new IllegalArgumentException("Invalid fire source");
        FireCatalog.Rule rule = FireCatalog.byExplosion(explosion.tag());
        if (rule == null) return List.of();
        int count = random.between(rule.countMin(), rule.countMax());
        if (count == 0) return List.of();
        // Native code first samples the table values, then its first-point
        // branch replaces and reuses lifetime/strength for all following points.
        random.between(rule.lifeMin(), rule.lifeMax());
        random.between(rule.strengthMin(), rule.strengthMax());
        float peak = random.between(rule.peakMin(), rule.peakMax());
        float lifetime = 0f, strength = 0f;
        var result = new ArrayList<SurfaceSeed>();
        boolean fireDamage = weapon != null && "FIRE".equals(weapon.damageType());
        for (int index = 0; index < count; index++) {
            float x = origin.get(0).floatValue(), y = origin.get(1).floatValue(), z = origin.get(2).floatValue() + .05f;
            float range;
            if (index == 0) {
                lifetime = random.unit() * 5f + 20f;
                strength = 1f; range = 0f;
            } else range = random.between(rule.rangeMin(), rule.rangeMax());
            if (fireDamage) {
                // The supported native binary places FIRE candidates in Y/Z;
                // do not silently substitute the usual horizontal ring.
                float angle = (float)index / (float)count * (float)(Math.PI * 2) - (float)Math.PI;
                y += range * (float)Math.sin(angle); z += range * (float)Math.cos(angle);
            } else if (index != 0) {
                float angle = random.unit() * (float)(Math.PI * 2) - (float)Math.PI;
                range = random.between(rule.rangeMin(), rule.rangeMax());
                x += range * (float)Math.cos(angle); y += range * (float)Math.sin(angle);
            }
            result.add(new SurfaceSeed(List.of((double)x, (double)y, (double)z),
                    List.of((double)x, (double)y, (double)(z - 2f)), lifetime, strength, peak, rule.fuel(), rule.burnRate()));
        }
        return List.copyOf(result);
    }

    /** Map-fire radius and fuel progression after its contact is authorized.
     * Native flag-controlled script immortality and engine script modifiers
     * are unavailable to public clients and are not accepted as inputs.
     */
    static final class Ground {
        private final float lifetime, strength, peakTime, burnRate;
        private float age, radius, fuel;
        private boolean extinguished;
        Ground(SurfaceSeed seed) {
            if (seed == null) throw new IllegalArgumentException("Missing ground fire");
            finiteNonnegative(seed.lifetime); finiteNonnegative(seed.strength); finiteNonnegative(seed.peakTime);
            finiteNonnegative(seed.fuel); finiteNonnegative(seed.burnRate);
            if (seed.lifetime == 0) throw new IllegalArgumentException("Invalid ground fire lifetime");
            lifetime = seed.lifetime; strength = seed.strength; peakTime = seed.peakTime;
            fuel = seed.fuel; burnRate = seed.burnRate;
        }
        boolean active() { return !extinguished && age <= lifetime; }
        double radius() { return active() ? radius : 0d; }
        double ageSeconds() { return age; }
        double fuel() { return fuel; }
        double remainingSeconds() { return active() ? Math.max(0f, lifetime - age) : 0d; }
        void extinguish() { extinguished = true; radius = 0; }
        void advance(double seconds) {
            finiteNonnegative(seconds);
            if (!active()) return;
            age += (float)seconds;
            if (!active()) { radius = 0; return; }
            fuel = Math.max(0f, fuel - burnRate * (float)seconds);
            float decline = lifetime * .7f;
            radius = age > decline ? (1f - (age - decline) / (lifetime - decline)) * strength
                    : age < peakTime ? age / peakTime * strength : strength;
        }
    }

    /** The near-fire test narrows the native world bounding box horizontally
     * to its central third. Pass the actual, validated native box, not a union
     * of independently posed hit shapes or an invented movement capsule.
     */
    static boolean intersectsPedBox(double[] minimum, double[] maximum, double[] centre, double radius) {
        if (minimum == null || maximum == null || centre == null || minimum.length != 3
                || maximum.length != 3 || centre.length != 3) throw new IllegalArgumentException("Invalid fire bounds");
        finiteNonnegative(radius);
        float distanceSquared = 0f;
        for (int axis = 0; axis < 3; axis++) {
            if (!Double.isFinite(minimum[axis]) || !Double.isFinite(maximum[axis]) || !Double.isFinite(centre[axis])
                    || minimum[axis] > maximum[axis]) throw new IllegalArgumentException("Invalid fire bounds");
            float lo = (float)minimum[axis], hi = (float)maximum[axis], p = (float)centre[axis];
            float inset = axis == 2 ? 0f : (hi - lo) * (1f / 3f);
            lo += inset; hi -= inset;
            float distance = p < lo ? lo - p : p > hi ? p - hi : 0f;
            distanceSquared += distance * distance;
        }
        return distanceSquared <= (float)radius * (float)radius;
    }

    static final class Heat {
        private float value;
        double value() { return value; }
        void clear() { value = 0f; }
        void cool(double seconds, boolean burning) {
            finiteNonnegative(seconds);
            value = burning ? 1f : clamp(value - .15f * (float)seconds);
        }
        /** Each confirmed scheduled proximity scan adds heat. The ordinary
         * PED ratio is exactly one. Fire-resistant PEDs (native P_TYPE 21)
         * use the overlap depth divided by their native physics radius.
         */
        boolean hit(boolean resistant, double fireRadius, double pedRadius, double horizontalDistance) {
            finiteNonnegative(fireRadius); finiteNonnegative(pedRadius); finiteNonnegative(horizontalDistance);
            if (pedRadius == 0) throw new IllegalArgumentException("Invalid PED radius");
            float ratio = resistant ? clamp(Math.max(.001f,
                    (float)fireRadius + (float)pedRadius - (float)horizontalDistance) / (float)pedRadius) : 1f;
            float increment = .5f / (resistant ? 1.25f : 1f) * ratio * ratio;
            value = clamp(value + increment);
            return value >= 1f;
        }
    }

    /** Continuous server-clock integration of an already-authorized body fire.
     * Native default effect-duration modifier is one; script overrides are not
     * accepted from clients. Repeated ignition must not replace an active body.
     */
    static final class Body {
        private double remaining;
        Body(boolean player, Ignition ignition) {
            if (ignition == null || ignition == Ignition.NONE) throw new IllegalArgumentException("Missing ignition");
            remaining = player ? ignition == Ignition.EXPLOSION ? 7d : 2d : 10d;
        }
        boolean active() { return remaining > 0; }
        double remainingSeconds() { return remaining; }
        void extinguish() { remaining = 0; }
        double advance(double seconds) {
            finiteNonnegative(seconds);
            double elapsed = Math.min(seconds, remaining);
            remaining = Math.max(0, remaining - elapsed);
            return DAMAGE_PER_SECOND * elapsed;
        }
    }

    /** CTaskComplexOnFire's separate NPC terminal branch. Input booleans must
     * come from validated native task/physics state, never a requested damage.
     */
    static boolean terminalNpc(boolean player, boolean hasSubtask, int subtaskType,
            boolean usingMainPhysicsInstance, boolean suppressTerminalDamage) {
        return !player && hasSubtask && subtaskType != 392 && subtaskType != 404 && subtaskType != 411
                && !usingMainPhysicsInstance && !suppressTerminalDamage;
    }

    private static float clamp(float value) { return Math.max(0f, Math.min(1f, value)); }
    private static void finiteNonnegative(double value) {
        if (!Double.isFinite(value) || value < 0 || value > Float.MAX_VALUE)
            throw new IllegalArgumentException("Invalid fire input");
    }
}
