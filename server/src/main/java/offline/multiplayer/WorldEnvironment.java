package offline.multiplayer;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 服务端公共天气/时钟。只接受服务端单调时钟，不提供客户端写入口。
 * 时钟以 checkpoint 为锚点，所有连接（包括晚加入）读取同一组事实。
 */
final class WorldEnvironment {
    static final long CHECKPOINT_MILLIS = 5_000;
    static final long WEATHER_PERIOD_MILLIS = 15 * 60_000;
    static final long WEATHER_TRANSITION_MILLIS = 30_000;
    static final int GAME_SECONDS_PER_REAL_SECOND = 30;
    private static final long DAY_SECONDS = 24 * 60 * 60;
    private static final long INITIAL_SECONDS = 12 * 60 * 60;
    private record Weather(String type, double rain, double wind) {}
    private static final Weather[] FORECAST = {
        new Weather("EXTRASUNNY", 0, .2), new Weather("CLEAR", 0, .2),
        new Weather("CLOUDS", 0, .35), new Weather("OVERCAST", 0, .45),
        new Weather("RAIN", .65, .55), new Weather("CLEARING", 0, .3),
        new Weather("CLEAR", 0, .2)
    };
    private final long startedTick;

    WorldEnvironment(long startedTick) {
        if (startedTick < 0 || startedTick > 9_007_199_254_740_991L)
            throw new IllegalArgumentException("世界环境起点必须是有效服务端时间");
        this.startedTick = startedTick;
    }

    /** 同一 checkpoint 的完整不可变值；环境修订号独立于实体事务修订号。 */
    Map<String, Object> cut(long worldTick) {
        if (worldTick < startedTick || worldTick > 9_007_199_254_740_991L)
            throw new IllegalArgumentException("世界环境时间不可早于起点");
        long elapsed = worldTick - startedTick;
        long checkpoint = elapsed / CHECKPOINT_MILLIS;
        long anchorTick = startedTick + checkpoint * CHECKPOINT_MILLIS;
        long seconds = (INITIAL_SECONDS + (anchorTick - startedTick) * GAME_SECONDS_PER_REAL_SECOND / 1_000) % DAY_SECONDS;
        long forecast = elapsed / WEATHER_PERIOD_MILLIS;
        Weather weather = FORECAST[(int) (forecast % FORECAST.length)];
        return map("revision", checkpoint + 1,
            "weather", map("type", weather.type(), "rain", weather.rain(), "wind", weather.wind(),
                "transition_ms", forecast == 0 ? 0L : WEATHER_TRANSITION_MILLIS,
                "anchor_tick", startedTick + forecast * WEATHER_PERIOD_MILLIS),
            "clock", map("hour", seconds / 3_600, "minute", seconds / 60 % 60, "second", seconds % 60,
                "paused", false, "rate", GAME_SECONDS_PER_REAL_SECOND, "anchor_tick", anchorTick));
    }

    private static Map<String, Object> map(Object... values) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (int index = 0; index < values.length; index += 2) result.put((String) values[index], values[index + 1]);
        return java.util.Collections.unmodifiableMap(result);
    }
}
