package offline.multiplayer;

import java.util.Map;
import java.util.LinkedHashMap;

/** Generated original flags; no meshes, textures or animation data. Supported
 * base/DLC sources have no lightly-armoured or bulletproof face components. */
final class PedProtectionCatalog {
    private PedProtectionCatalog() {}
    static final int BULLETPROOF_HITS = 2;
    private static final Map<Long,Map<Integer,Integer>> RULES = create();
    private static Map<Long,Map<Integer,Integer>> create() {
        Map<Long,Map<Integer,Integer>> rules = new LinkedHashMap<>();
        rules.put(3349113128L, Map.of()); // a_f_y_beach_01: 1 original head props
        rules.put(664399832L, Map.of()); // a_f_y_business_01: 0 original head props
        rules.put(2185745201L, Map.of()); // a_f_y_hipster_01: 0 original head props
        rules.put(2633130371L, Map.of()); // a_f_y_topless_01: 0 original head props
        rules.put(3523131524L, Map.of(0, 135201)); // a_m_y_beach_01: 2 original head props
        rules.put(3382649284L, Map.of()); // a_m_y_business_01: 0 original head props
        rules.put(587703123L, Map.of()); // a_m_y_hipster_01: 4 original head props
        rules.put(2627665880L, Map.of(16, 209953, 17, 209953, 18, 209921, 38, 197121)); // mp_f_freemode_01: 39 original head props
        rules.put(1885233650L, Map.of(16, 209953, 17, 209953, 18, 209953, 39, 197121)); // mp_m_freemode_01: 40 original head props
        rules.put(1581098148L, Map.of()); // s_m_y_cop_01: 1 original head props
        return Map.copyOf(rules);
    }
    static int headFlags(long model,int drawable) {
        return RULES.getOrDefault(model,Map.of()).getOrDefault(drawable,0);
    }
}
