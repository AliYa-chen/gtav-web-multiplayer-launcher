package offline.multiplayer;

/** Supported native phGtaExplosionInst/phInstBehaviorExplosionGta arithmetic.
 * The coefficients, lifetime and growth parameters come from explosion.ymt.
 * Server elapsed time replaces frame/substep elapsed time; no fixed damage
 * tick or synthetic effect lifetime is added to the source data.
 */
final class ExplosionExposure {
    private ExplosionExposure() {}

    static double damage(ExplosionCatalog.Rule rule,double distance,boolean player,double seconds) {
        if (!Double.isFinite(distance) || distance<0 || !Double.isFinite(seconds) || seconds<0)
            throw new IllegalArgumentException("Invalid explosion exposure");
        float centre=(float)rule.damageAtCentre();
        float edge=rule.bUseDistanceDamageCalc()?(float)rule.damageAtEdge():centre;
        float fraction=Math.min(1f,(float)distance/(float)rule.endRadius());
        float amount=(centre-edge)*(1f-fraction)+edge;
        if(rule.continuous())amount=amount*30f*2f*(float)seconds;
        return amount*(float)(player?rule.networkPlayerModifier():rule.networkPedModifier());
    }

    static final class Cloud {
        private final ExplosionCatalog.Rule rule;
        private float radius=.001f,speed,remaining;
        Cloud(ExplosionCatalog.Rule rule) {
            if(!rule.continuous() || rule.endRadius()<=0 || rule.directedLifeTime()<=0)
                throw new IllegalArgumentException("Unsupported continuous explosion");
            this.rule=rule;speed=(float)rule.initSpeed();remaining=(float)rule.directedLifeTime();
        }
        double radius(){return radius;}
        boolean active(){return radius<(float)rule.endRadius();}
        void advance(double seconds) {
            if(!Double.isFinite(seconds) || seconds<0)throw new IllegalArgumentException("Invalid exposure step");
            float dt=(float)seconds,previous=speed;
            speed+=speed*(float)rule.decayFactor()*dt;
            radius+=speed*dt;
            if(remaining>0){
                remaining-=dt;
                if(radius>=(float)rule.endRadius()){
                    speed=previous;radius=(float)rule.endRadius()-.001f;
                }else if(remaining<=0)remaining=.001f;
            }
        }
    }
}
