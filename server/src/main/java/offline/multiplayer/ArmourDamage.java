package offline.multiplayer;

/** Ordinary-ammunition branch of the supported native CPedDamageCalculator.
 * Special ammunition, outfit component protection and critical-hit flags are
 * separate native inputs; they are not fabricated by this server helper.
 */
final class ArmourDamage {
    private ArmourDamage() {}
    record Result(double healthDamage, double armour, double armourLost) {}

    static Result weapon(double damage, WorldRegistry.Entity victim, long weapon) {
        double armour = victim.components().combat().armour();
        if (armour == 0) return new Result(damage, 0, 0);
        var ped = PedDamageCatalog.byModel(victim.model());
        var physics = WeaponPhysics.byHash(weapon);
        if (ped == null || physics == null) throw new IllegalArgumentException("Unsupported character armour metadata");
        boolean penetrating = java.util.Arrays.asList(physics.weaponFlags().split(" ")).contains("ArmourPenetrating");
        return ordinary(damage, armour, ped.armourEfficiency(), penetrating);
    }

    static Result ordinary(double damage, double armour, double efficiency, boolean penetrating) {
        if (!Double.isFinite(damage) || damage < 0 || !Double.isFinite(armour) || armour < 0
                || !Double.isFinite(efficiency) || efficiency < 0)
            throw new IllegalArgumentException("Invalid original armour calculation input");
        // Retain single-precision operations from the supported WASM body.
        float raw = (float)damage, remaining = (float)armour, lost = 0;
        if (remaining > 0 && !penetrating) {
            float factor = (float)efficiency;
            if (remaining * factor >= raw && factor > 0) {
                raw /= factor;
                lost = raw;
                remaining -= lost;
            } else {
                raw -= Math.max(remaining * factor - remaining, 0f);
                lost = remaining;
                remaining = 0;
            }
        }
        return new Result(Math.max(raw - lost, 0f), remaining, lost);
    }
}
