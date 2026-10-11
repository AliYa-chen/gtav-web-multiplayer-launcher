package offline.multiplayer;

import java.util.Set;

/** Ordinary bullet hit-part branch from the supported CPedDamageCalculator. */
final class HitPartDamage {
    private static final Set<Integer> LIMBS=Set.of(14201,18905,28252,36864,40269,45509,
        51826,52301,57005,58271,63931,61163);
    private HitPartDamage() {}

    static double apply(WeaponPhysics.Physics weapon,double damage,double distance,int bone,
                        boolean playerVictim,boolean playerAttack,boolean ordinaryHead) {
        if(weapon==null||!Double.isFinite(damage)||damage<=0)return 0;
        float amount=(float)damage;
        if(LIMBS.contains(bone)) {
            double modifier=weapon.networkHitLimbsDamageModifier();
            return modifier<0?0:amount*(float)modifier;
        }
        // The network branch treats the neck (39317) as torso, not head.
        // Extra critical damage is only computed for ordinary player bullets.
        if(bone!=31086||!playerAttack||!ordinaryHead||!"BULLET".equals(weapon.damageType()))return amount;
        float minimum=(float)(playerVictim?weapon.minHeadShotDistancePlayer():weapon.minHeadShotDistanceAI());
        float maximum=(float)(playerVictim?weapon.maxHeadShotDistancePlayer():weapon.maxHeadShotDistanceAI());
        float extra=(float)(playerVictim?weapon.headShotDamageModifierPlayer():weapon.headShotDamageModifierAI());
        if(minimum<0||maximum<minimum||extra<0)return 0;
        float at=(float)distance;
        if(at<minimum)return amount*(1f+extra);
        // Keep the native strict comparisons, including its exact minimum boundary.
        if(at>minimum&&at<maximum)return amount*(1f+extra*Math.max(0f,Math.min(1f,1f-(at-minimum)/(maximum-minimum))));
        return amount;
    }

}
