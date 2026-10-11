package offline.multiplayer;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/** Generated from supported original health/personality metadata; contains no geometry. */
public final class PedHealthCatalog {
    private PedHealthCatalog() {}
    public static final String ENGINE_SOURCE_SHA256 = "11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0";
    public static final String PED_SOURCE_SHA256 = "abec57fa062f8a5e43bc7844281ae6cabc3e77175954e7c538738f7cb78d5ffe";
    public static final String PERSONALITY_SOURCE_SHA256 = "cd69d45312dcea7f6f43d410201b0f23b0e77cbcdab1ba123ed6c1b0060ca2d0";
    public static final String HEALTH_SOURCE_SHA256 = "e263508d7c5f20a27eae4e395bd35300f5536b2aa95c6b237c6a7b2a2769cd76";
    public record Rule(int initialHealth, int dyingThreshold, double armour) {
        /** Native fatal injury is strictly below the threshold, so equality remains one live unit. */
        public int effectiveHealth() { return initialHealth - dyingThreshold + 1; }
    }
    private static final Map<Long, Rule> RULES = create();
    private static Map<Long, Rule> create() {
        Map<Long, Rule> rules = new LinkedHashMap<>();
        rules.put(3349113128L, new Rule(150, 100, 0.0)); // a_f_y_beach_01
        rules.put(664399832L, new Rule(150, 100, 0.0)); // a_f_y_business_01
        rules.put(2185745201L, new Rule(150, 100, 0.0)); // a_f_y_hipster_01
        rules.put(2633130371L, new Rule(150, 100, 0.0)); // a_f_y_topless_01
        rules.put(3523131524L, new Rule(175, 100, 0.0)); // a_m_y_beach_01
        rules.put(3382649284L, new Rule(175, 100, 0.0)); // a_m_y_business_01
        rules.put(587703123L, new Rule(150, 100, 0.0)); // a_m_y_hipster_01
        rules.put(2627665880L, new Rule(175, 100, 0.0)); // mp_f_freemode_01
        rules.put(1885233650L, new Rule(200, 100, 0.0)); // mp_m_freemode_01
        rules.put(1581098148L, new Rule(200, 100, 0.0)); // s_m_y_cop_01
        return Collections.unmodifiableMap(rules);
    }
    public static Rule byModel(long model) { return RULES.get(model); }
}
