package offline.multiplayer;

import java.util.Map;

/** 构建获准后可独立运行的环境规则断言；此夹具不读取游戏数据或启动服务器。 */
public final class WorldEnvironmentFixture {
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
    private static long number(Map<?, ?> map, String key) { return ((Number) map.get(key)).longValue(); }
    private static Map<?, ?> part(Map<?, ?> map, String key) { return (Map<?, ?>) map.get(key); }
    public static void main(String[] args) {
        long start = 1_800_000_000_000L;
        WorldEnvironment world = new WorldEnvironment(start);
        Map<String, Object> baseline = world.cut(start);
        check(number(baseline, "revision") == 1, "首个环境修订应为 1");
        check(baseline.equals(world.cut(start + 4_999)), "同一 checkpoint 不得因连接读取时间变化而改写基线");
        check(number(part(baseline, "clock"), "hour") == 12, "公共世界统一从中午开始");
        Map<String, Object> next = world.cut(start + 5_000);
        check(number(next, "revision") == 2, "无实体提交也应形成环境 checkpoint");
        check(number(part(next, "clock"), "minute") == 2 && number(part(next, "clock"), "second") == 30,
            "30 倍游戏时钟换算错误");
        check(number(part(next, "clock"), "anchor_tick") == start + 5_000, "时钟锚点必须使用服务端毫秒");
        Map<String, Object> midnight = world.cut(start + 1_440_000);
        check(number(part(midnight, "clock"), "hour") == 0 && number(part(midnight, "clock"), "minute") == 0,
            "午夜回绕错误");
        Map<?, ?> clear = part(world.cut(start + 900_000), "weather");
        check(clear.get("type").equals("CLEAR") && number(clear, "transition_ms") == 30_000,
            "预报边界必须由服务端统一切换");
        check(number(clear, "anchor_tick") == start + 900_000, "天气过渡起点错误");
        Map<?, ?> rain = part(world.cut(start + 3_600_000), "weather");
        check(rain.get("type").equals("RAIN") && ((Number) rain.get("rain")).doubleValue() == .65,
            "预报应包含统一雨天强度");
        check(number(part(world.cut(start + 6_300_000), "weather"), "anchor_tick") == start + 6_300_000,
            "循环天气应使用新的过渡起点");
        check(part(world.cut(start + 6_300_000), "weather").get("type").equals("EXTRASUNNY"), "预报循环错误");
        try { baseline.put("revision", 0L); throw new AssertionError("环境基线不能被连接写入"); }
        catch (UnsupportedOperationException expected) {}
        try { world.cut(start - 1); throw new AssertionError("不得接受旧世界时间"); }
        catch (IllegalArgumentException expected) {}
        System.out.println("world environment rules: OK");
    }
}
