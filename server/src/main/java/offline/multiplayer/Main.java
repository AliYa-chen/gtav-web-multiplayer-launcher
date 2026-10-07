package offline.multiplayer;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigDecimal;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** 独立大厅服务及已校验的状态转发；游戏角色同步仍需客户端引擎桥验证。 */
public final class Main {
    private static final String VERSION = "0.1.0-public";
    private static final List<String> CAPABILITIES = List.of("public_session", "chat", "player_state", "shoot_events");
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int MAX_MESSAGE_BYTES = 64 * 1024;
    private static final long MAX_SAFE_INTEGER = 9007199254740991L;
    private static final long MAX_UNSIGNED_INT = 4294967295L;

    private Main() {}

    public static void main(String[] args) {
        try {
            Config config = Config.parse(args);
            if (config == null) return;
            try (Server server = new Server(config)) {
                Runtime.getRuntime().addShutdownHook(new Thread(server::close, "大厅关停"));
                server.run();
            }
        } catch (IllegalArgumentException | IOException exception) {
            System.err.println("多人大厅启动失败：" + exception.getMessage());
            System.exit(1);
        }
    }

    private record Config(String host, int port, int maxClients) {
        static Config parse(String[] args) {
            String host = "0.0.0.0";
            int port = 8787;
            int maxClients = 128;
            for (int index = 0; index < args.length; index++) {
                String argument = args[index];
                if (argument.equals("--help") || argument.equals("-h")) {
                    System.out.println("GTA V 沙盒公共战局服务 " + VERSION + "（Java 17 或更新版本）\n"
                        + "用法：java -jar multiplayer-server.jar [选项]\n"
                        + "  --host 地址          监听地址，默认 0.0.0.0\n"
                        + "  --port 端口          监听端口，默认 8787；0 为系统分配\n"
                        + "  --max-clients 人数   连接上限，默认 128（1–1024）\n"
                        + "所有玩家自动进入同一个公共战局；无需房间码、准备或房主。\n"
                        + "服务端提供聊天与状态转发；角色同步仍需客户端引擎桥验证。\n"
                        + "按 Ctrl+C 停止服务。");
                    return null;
                }
                if (index + 1 >= args.length) throw new IllegalArgumentException("选项缺少值：" + argument);
                String value = args[++index];
                switch (argument) {
                    case "--host" -> {
                        if (value.isBlank()) throw new IllegalArgumentException("监听地址不能为空");
                        host = value;
                    }
                    case "--port" -> port = boundedInteger(value, 0, 65535, "端口");
                    case "--max-clients" -> maxClients = boundedInteger(value, 1, 1024, "连接上限");
                    default -> throw new IllegalArgumentException("未知选项：" + argument);
                }
            }
            return new Config(host, port, maxClients);
        }

        private static int boundedInteger(String value, int min, int max, String name) {
            try {
                int parsed = Integer.parseInt(value);
                if (parsed >= min && parsed <= max) return parsed;
            } catch (NumberFormatException ignored) {}
            throw new IllegalArgumentException(name + "必须为 " + min + "–" + max + " 的整数");
        }
    }

    private static final class Server implements AutoCloseable {
        private final ServerSocket listener;
        private final ThreadPoolExecutor requests;
        private final ScheduledExecutorService maintenance;
        private final Lobby lobby;
        private final AtomicBoolean closed = new AtomicBoolean();
        private final java.util.Set<Socket> sockets = java.util.concurrent.ConcurrentHashMap.newKeySet();
        private final Config config;

        Server(Config config) throws IOException {
            this.config = config;
            listener = new ServerSocket();
            try {
                listener.setReuseAddress(true);
                listener.bind(new InetSocketAddress(config.host(), config.port()), 128);
            } catch (IOException exception) {
                listener.close();
                throw exception;
            }
            lobby = new Lobby(config.maxClients());
            // 请求线程池有界；每个 WebSocket 使用一个读线程及一个发送线程。
            // 大厅锁只保护状态修改和消息入队，绝不等待网络写入。
            requests = new ThreadPoolExecutor(0, config.maxClients() + 16, 30,
                TimeUnit.SECONDS, new java.util.concurrent.SynchronousQueue<>(), runnable -> {
                    Thread thread = new Thread(runnable, "大厅请求");
                    thread.setDaemon(true);
                    return thread;
                });
            maintenance = Executors.newSingleThreadScheduledExecutor(runnable -> {
                Thread thread = new Thread(runnable, "大厅心跳");
                thread.setDaemon(true);
                return thread;
            });
            maintenance.scheduleAtFixedRate(lobby::maintain, 1, 1, TimeUnit.SECONDS);
        }

        void run() throws IOException {
            String displayHost = config.host().contains(":") ? "[" + config.host() + "]" : config.host();
            System.out.println("多人大厅已启动：http://" + displayHost + ":" + listener.getLocalPort()
                + "（WebSocket：/ws，单个 GTA V 公共战局；状态转发已就绪，角色同步需客户端验证）");
            while (!closed.get()) {
                try {
                    Socket socket = listener.accept();
                    socket.setTcpNoDelay(true);
                    socket.setSoTimeout(8000);
                    sockets.add(socket);
                    try {
                        requests.execute(() -> handle(socket));
                    } catch (java.util.concurrent.RejectedExecutionException exception) {
                        // 过载时立即关闭，不在接受连接的线程中等待慢客户端。
                        sockets.remove(socket);
                        socket.close();
                    }
                } catch (IOException exception) {
                    if (!closed.get()) throw exception;
                }
            }
        }

        private void handle(Socket socket) {
            Client client = null;
            boolean upgraded = false;
            try {
                InputStream input = new BufferedInputStream(socket.getInputStream());
                Request request = Request.read(input, socket);
                if (!request.method().equals("GET")) {
                    http(socket, 405, "Method Not Allowed", "text/plain; charset=utf-8", "只支持 GET 请求", Map.of("Allow", "GET"));
                    return;
                }
                String path = request.target().split("\\?", 2)[0];
                if (path.equals("/health") || path.equals("/api/multiplayer")) {
                    http(socket, 200, "OK", "application/json; charset=utf-8", Json.stringify(lobby.snapshot()),
                        Map.of("Access-Control-Allow-Origin", "*"));
                    return;
                }
                if (path.equals("/")) {
                    http(socket, 200, "OK", "text/html; charset=utf-8", "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\">"
                        + "<meta name=\"viewport\" content=\"width=device-width\"><title>GTA V 多人大厅服务</title>"
                        + "<body><h1>GTA V 公共战局服务正在运行</h1><p>请在游戏页面的“多人”中输入本服务器地址。"
                        + "</p><p>输入昵称后自动加入唯一公共战局，支持聊天与状态转发。游戏角色同步仍需客户端引擎桥验证。"
                        + "</p><p>WebSocket 接口：/ws；<a href=\"/health\">服务状态</a></p></body></html>", Map.of());
                    return;
                }
                if (!path.equals("/ws")) {
                    http(socket, 404, "Not Found", "text/plain; charset=utf-8", "页面不存在", Map.of());
                    return;
                }
                validateUpgrade(request);
                client = new Client(socket, input, lobby);
                lobby.register(client);
                String accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1")
                    .digest((request.headers().get("sec-websocket-key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
                        .getBytes(StandardCharsets.US_ASCII)));
                socket.getOutputStream().write(("HTTP/1.1 101 Switching Protocols\r\n"
                    + "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n")
                    .getBytes(StandardCharsets.US_ASCII));
                socket.getOutputStream().flush();
                upgraded = true;
                socket.setSoTimeout(0);
                client.startWriter();
                lobby.sendInitial(client);
                client.readMessages();
            } catch (HttpProblem problem) {
                if (!upgraded) {
                    try {
                        http(socket, problem.status, problem.reason, "text/plain; charset=utf-8", problem.getMessage(),
                            problem.status == 426 ? Map.of("Sec-WebSocket-Version", "13") : Map.of());
                    } catch (IOException ignored) {}
                }
            } catch (Exception exception) {
                if (!(exception instanceof IOException) && !closed.get()) {
                    System.err.println("连接处理异常：" + exception.getClass().getSimpleName() + "：" + exception.getMessage());
                }
            } finally {
                if (client != null) {
                    client.disconnect();
                    lobby.remove(client);
                }
                sockets.remove(socket);
                try { socket.close(); } catch (IOException ignored) {}
            }
        }

        @Override public void close() {
            if (!closed.compareAndSet(false, true)) return;
            try { listener.close(); } catch (IOException ignored) {}
            maintenance.shutdownNow();
            lobby.close();
            for (Socket socket : sockets) {
                try { socket.close(); } catch (IOException ignored) {}
            }
            requests.shutdownNow();
        }
    }

    private record Request(String method, String target, Map<String, String> headers) {
        static Request read(InputStream input, Socket socket) throws IOException, HttpProblem {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            int tail = 0;
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8);
            int previousTimeout = 8000;
            while (bytes.size() < 16 * 1024) {
                long remaining = deadline - System.nanoTime();
                if (remaining <= 0) throw new java.net.SocketTimeoutException("HTTP 握手超过 8 秒");
                int timeout = (int) Math.max(1, TimeUnit.NANOSECONDS.toMillis(remaining));
                if (timeout != previousTimeout) { socket.setSoTimeout(timeout); previousTimeout = timeout; }
                int value = input.read();
                if (value < 0) throw new EOFException();
                if (value > 127 || value == 0) throw badRequest("HTTP 请求头格式错误");
                bytes.write(value);
                tail = (tail << 8) | value;
                if (tail == 0x0d0a0d0a) break;
            }
            if (tail != 0x0d0a0d0a) throw new HttpProblem(431, "Request Header Fields Too Large", "请求头超过 16 KiB 上限");
            String[] lines = bytes.toString(StandardCharsets.US_ASCII).split("\r\n");
            String[] start = lines[0].split(" ");
            if (start.length != 3 || !start[2].equals("HTTP/1.1") || !start[1].startsWith("/"))
                throw badRequest("请使用 HTTP/1.1 和有效的请求路径");
            LinkedHashMap<String, String> headers = new LinkedHashMap<>();
            for (int index = 1; index < lines.length; index++) {
                String line = lines[index];
                int colon = line.indexOf(':');
                if (colon <= 0 || line.length() > 4096) throw badRequest("HTTP 请求头格式错误");
                String name = line.substring(0, colon).toLowerCase(Locale.ROOT);
                if (!name.matches("[a-z0-9!#$%&'*+.^_`|~-]+")) throw badRequest("HTTP 请求头名称错误");
                String value = line.substring(colon + 1).trim();
                for (int at = 0; at < value.length(); at++) {
                    if (value.charAt(at) < 32 && value.charAt(at) != '\t') throw badRequest("HTTP 请求头格式错误");
                }
                if (headers.containsKey(name)) {
                    if (!name.equals("connection")) throw badRequest("不允许重复的 HTTP 请求头");
                    value = headers.get(name) + "," + value;
                }
                headers.put(name, value);
            }
            if (!headers.containsKey("host")) throw badRequest("请求缺少 Host");
            if (headers.containsKey("transfer-encoding") || !headers.getOrDefault("content-length", "0").equals("0"))
                throw badRequest("此接口不接收 HTTP 请求体");
            return new Request(start[0], start[1], headers);
        }
    }

    private static void validateUpgrade(Request request) throws HttpProblem {
        Map<String, String> headers = request.headers();
        if (!headers.getOrDefault("upgrade", "").equalsIgnoreCase("websocket")
                || Arrays.stream(headers.getOrDefault("connection", "").split(","))
                    .noneMatch(value -> value.trim().equalsIgnoreCase("upgrade")))
            throw badRequest("请使用 WebSocket 连接 /ws");
        if (!headers.getOrDefault("sec-websocket-version", "").equals("13"))
            throw new HttpProblem(426, "Upgrade Required", "只支持 WebSocket 版本 13");
        try {
            String key = headers.get("sec-websocket-key");
            if (key == null || Base64.getDecoder().decode(key).length != 16) throw new IllegalArgumentException();
        } catch (IllegalArgumentException exception) {
            throw badRequest("WebSocket 密钥格式错误");
        }
        // 大厅允许局域网及公网地址、不同端口的游戏页面；不使用浏览器凭据。
        // 非浏览器测试客户端可省略 Origin；浏览器的 Origin 必须是 HTTP(S) 页面。
        if (headers.containsKey("origin")) {
            try {
                URI origin = new URI(headers.get("origin"));
                if (!("http".equalsIgnoreCase(origin.getScheme()) || "https".equalsIgnoreCase(origin.getScheme()))
                        || origin.getHost() == null || origin.getUserInfo() != null || origin.getQuery() != null
                        || origin.getFragment() != null || origin.getPort() < -1 || origin.getPort() > 65535
                        || !(origin.getPath().isEmpty() || origin.getPath().equals("/")))
                    throw new IllegalArgumentException();
            } catch (Exception exception) {
                throw new HttpProblem(403, "Forbidden", "请从通过 HTTP 或 HTTPS 打开的游戏页面连接大厅");
            }
        }
    }

    private static HttpProblem badRequest(String message) { return new HttpProblem(400, "Bad Request", message); }

    private static final class HttpProblem extends Exception {
        final int status;
        final String reason;
        HttpProblem(int status, String reason, String message) { super(message); this.status = status; this.reason = reason; }
    }

    private static void http(Socket socket, int status, String reason, String contentType, String body,
                             Map<String, String> additional) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        StringBuilder headers = new StringBuilder("HTTP/1.1 " + status + " " + reason + "\r\n"
            + "Content-Type: " + contentType + "\r\nContent-Length: " + bytes.length
            + "\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n");
        additional.forEach((name, value) -> headers.append(name).append(": ").append(value).append("\r\n"));
        OutputStream output = socket.getOutputStream();
        output.write(headers.append("\r\n").toString().getBytes(StandardCharsets.US_ASCII));
        output.write(bytes);
        output.flush();
    }

    private static final class Lobby {
        private final Object lock = new Object();
        private final LinkedHashMap<String, Client> clients = new LinkedHashMap<>();
        private final LinkedHashMap<String, Room> rooms = new LinkedHashMap<>();
        private final int maxClients;
        private final Room publicRoom;
        private long shotEventsReceived;
        private boolean closed;

        Lobby(int maxClients) {
            this.maxClients = maxClients;
            publicRoom = new Room("PUBLIC", "GTA V 公共战局", maxClients);
            rooms.put(publicRoom.id, publicRoom);
        }

        void register(Client client) throws HttpProblem {
            synchronized (lock) {
                if (closed) throw new HttpProblem(503, "Service Unavailable", "大厅服务正在关闭");
                if (clients.size() >= maxClients) throw new HttpProblem(503, "Service Unavailable", "大厅连接人数已达上限，请稍后重试");
                clients.put(client.id, client);
            }
        }

        void sendInitial(Client client) {
            synchronized (lock) {
                client.send(object("type", "welcome", "protocol", 1, "client_id", client.id, "capabilities", CAPABILITIES,
                    "public_session", true, "server_version", VERSION, "room", roomState(publicRoom).get("room")));
            }
        }

        Map<String, Object> snapshot() {
            synchronized (lock) {
                long statePlayers = publicRoom.members.values().stream().filter(client -> client.lastState != null).count();
                return object("protocol", 1, "server_version", VERSION, "clients", clients.size(), "players", publicRoom.members.size(), "state_players", statePlayers,
                    "shot_events_received", shotEventsReceived, "rooms", 1,
                    "public_session", true, "capabilities", CAPABILITIES, "map", "gta5", "game_sync", false, "state_transport", true);
            }
        }

        void process(Client client, Map<String, Object> message) {
            synchronized (lock) {
                if (closed || !clients.containsKey(client.id) || client.closed.get()) return;
                try {
                    String type = string(message.get("type"), "消息类型", 40, false);
                    switch (type) {
                        case "hello" -> {
                            fields(message, List.of("type", "name"));
                            client.name = string(message.get("name"), "昵称", 24, false);
                            client.send(object("type", "profile", "client_id", client.id, "name", client.name));
                            joinPublic(client);
                        }
                        case "list_rooms" -> client.send(roomList());
                        case "create_room", "set_ready", "launch" -> throw problem("public_session_only", "所有玩家共用一个公共战局，无需建房、准备或开始");
                        case "join_room" -> {
                            fields(message, List.of("type", "room_id"));
                            if (!"PUBLIC".equals(message.get("room_id"))) throw problem("public_session_only", "只能加入 PUBLIC 公共战局");
                            joinPublic(client);
                        }
                        case "leave_room" -> { fields(message, List.of("type")); leaveRoom(client, true); }
                        case "chat" -> {
                            fields(message, List.of("type", "text"));
                            Room room = requireRoom(client);
                            String text = string(message.get("text"), "聊天内容", 500, true);
                            broadcast(room, object("type", "chat", "room_id", room.id, "sender_id", client.id,
                                "name", client.name, "text", text, "time", Instant.now().toString()));
                        }
                        case "player_state" -> playerState(client, message);
                        case "shot_event" -> shotEvent(client, message);
                        default -> throw problem("unknown_type", "不支持的消息类型：" + type);
                    }
                } catch (LobbyProblem problem) {
                    client.error(problem.code, problem.getMessage());
                }
            }
        }

        private void joinPublic(Client client) {
            publicRoom.members.put(client.id, client);
            client.roomId = publicRoom.id;
            client.ready = false;
            broadcastRoom(publicRoom);
            client.send(worldState(publicRoom));
        }

        private void playerState(Client client, Map<String, Object> message) throws LobbyProblem {
            Room room = requireLaunchedRoom(client);
            fields(message, List.of("type", "seq", "position", "heading", "model", "health", "weapon", "shooting"));
            long sequence = longInteger(message.get("seq"), 0, MAX_SAFE_INTEGER, "状态序号");
            List<Double> position = coordinates(message.get("position"), "角色坐标");
            double heading = finiteNumber(message.get("heading"), 0, 360, "角色朝向");
            long model = longInteger(message.get("model"), 0, MAX_UNSIGNED_INT, "角色模型");
            int health = integer(message.get("health"), 0, 1000, "本地角色生命值");
            long weapon = longInteger(message.get("weapon"), 0, MAX_UNSIGNED_INT, "当前武器");
            Object shooting = message.get("shooting");
            if (!(shooting instanceof Boolean)) throw problem("invalid_message", "射击状态必须为 true 或 false");
            if (sequence <= client.lastStateSequence) throw problem("stale_seq", "角色状态序号必须严格递增");
            if (!client.stateRate.take()) throw problem("rate_limited", "角色状态更新过快，持续更新上限为每秒 30 次");
            Map<String, Object> state = object("seq", sequence, "position", position, "heading", heading,
                "model", model, "health", health, "weapon", weapon, "shooting", shooting);
            client.lastStateSequence = sequence;
            client.lastState = state;
            broadcast(room, object("type", "player_state", "room_id", room.id, "player_id", client.id,
                "state", state, "time", Instant.now().toString()));
        }

        private void shotEvent(Client client, Map<String, Object> message) throws LobbyProblem {
            Room room = requireLaunchedRoom(client);
            fields(message, List.of("type", "seq", "origin", "target", "weapon"));
            long sequence = longInteger(message.get("seq"), 0, MAX_SAFE_INTEGER, "射击序号");
            List<Double> origin = coordinates(message.get("origin"), "射击起点");
            List<Double> target = coordinates(message.get("target"), "射击目标点");
            long weapon = longInteger(message.get("weapon"), 0, MAX_UNSIGNED_INT, "射击武器");
            if (sequence <= client.lastShotSequence) throw problem("stale_seq", "射击事件序号必须严格递增");
            if (!client.shotRate.take()) throw problem("rate_limited", "射击事件过快，持续发送上限为每秒 30 次");
            Map<String, Object> event = object("seq", sequence, "origin", origin, "target", target, "weapon", weapon);
            client.lastShotSequence = sequence;
            shotEventsReceived++;
            // 只转发射击数据，不接受命中、击杀或其他玩家生命值的权威声明。
            broadcast(room, object("type", "shot_event", "room_id", room.id, "player_id", client.id,
                "event", event, "time", Instant.now().toString()));
        }

        private Room requireLaunchedRoom(Client client) throws LobbyProblem {
            return requireRoom(client);
        }

        private void fields(Map<String, Object> message, List<String> allowed) throws LobbyProblem {
            if (message.keySet().stream().anyMatch(key -> !allowed.contains(key)))
                throw problem("invalid_message", "消息包含不允许的字段");
        }

        private Room requireRoom(Client client) throws LobbyProblem {
            Room room = rooms.get(client.roomId);
            if (room == null) throw problem("not_in_room", "请先发送昵称加入公共战局");
            return room;
        }

        private void leaveRoom(Client client, boolean notify) {
            Room room = rooms.get(client.roomId);
            client.roomId = null;
            client.ready = false;
            client.lastState = null;
            if (room != null) {
                room.members.remove(client.id);
                broadcastRoom(room);
            }
            if (notify) client.send(object("type", "room_state", "room", null));
        }

        void remove(Client client) {
            synchronized (lock) {
                if (clients.remove(client.id) == null) return;
                leaveRoom(client, false);
            }
        }

        private Map<String, Object> roomList() {
            List<Object> list = new ArrayList<>();
            for (Room room : rooms.values()) list.add(object("id", room.id, "name", room.name, "map", "gta5",
                "max_players", room.capacity, "players", room.members.size(), "phase", "launched", "host_id", null));
            return object("type", "room_list", "rooms", list);
        }

        private Map<String, Object> roomState(Room room) {
            List<Object> members = new ArrayList<>();
            for (Client client : room.members.values()) members.add(object("id", client.id, "name", client.name, "ready", client.ready));
            return object("type", "room_state", "room", object("id", room.id, "name", room.name, "map", "gta5",
                "max_players", room.capacity, "phase", "launched", "host_id", null, "members", members));
        }

        private Map<String, Object> worldState(Room room) {
            List<Object> states = new ArrayList<>();
            for (Client client : room.members.values()) {
                if (client.lastState != null) states.add(object("player_id", client.id, "state", client.lastState));
            }
            return object("type", "world_state", "room_id", room.id, "states", states);
        }

        private void broadcastRoom(Room room) { broadcast(room, roomState(room)); }

        private void broadcast(Room room, Map<String, Object> message) {
            byte[] frame = textFrame(message);
            for (Client client : room.members.values()) client.enqueue(frame, false);
        }

        void maintain() {
            List<Client> current;
            synchronized (lock) { current = new ArrayList<>(clients.values()); }
            long now = System.nanoTime();
            for (Client client : current) {
                if (client.closed.get()) continue;
                long writingSince = client.writingSince;
                if (writingSince != 0 && now - writingSince > TimeUnit.SECONDS.toNanos(5)) {
                    client.disconnect();
                    continue;
                }
                synchronized (client.heartbeatLock) {
                    if (client.pingSentAt != 0) {
                        if (now - client.pingSentAt > TimeUnit.SECONDS.toNanos(15)) client.disconnect();
                    } else if (now - client.lastPongAt > TimeUnit.SECONDS.toNanos(15)) {
                        client.ping = ByteBuffer.allocate(8).putLong(RANDOM.nextLong()).array();
                        client.pingSentAt = now;
                        client.enqueue(frame(9, client.ping), false);
                    }
                }
            }
        }

        void close() {
            List<Client> current;
            synchronized (lock) {
                closed = true;
                current = new ArrayList<>(clients.values());
                clients.clear();
                publicRoom.members.clear();
            }
            current.forEach(Client::disconnect);
        }
    }

    private static final class Room {
        final String id;
        final String name;
        final int capacity;
        final LinkedHashMap<String, Client> members = new LinkedHashMap<>();
        Room(String id, String name, int capacity) {
            this.id = id; this.name = name; this.capacity = capacity;
        }
    }

    private static final class Client {
        final Socket socket;
        final InputStream input;
        final Lobby lobby;
        final String id = java.util.UUID.randomUUID().toString();
        final AtomicBoolean closed = new AtomicBoolean();
        final ArrayBlockingQueue<Outbound> outgoing = new ArrayBlockingQueue<>(128);
        final CountDownLatch disconnected = new CountDownLatch(1);
        final Object heartbeatLock = new Object();
        final TokenBucket messageRate = new TokenBucket(80, 160);
        final TokenBucket stateRate = new TokenBucket(30, 60);
        final TokenBucket shotRate = new TokenBucket(30, 30);
        volatile long writingSince;
        long lastPongAt = System.nanoTime();
        long pingSentAt;
        byte[] ping;
        String name = "玩家 " + id.substring(0, 4).toUpperCase(Locale.ROOT);
        String roomId;
        boolean ready;
        boolean closing;
        long lastStateSequence = -1;
        long lastShotSequence = -1;
        Map<String, Object> lastState;

        Client(Socket socket, InputStream input, Lobby lobby) { this.socket = socket; this.input = input; this.lobby = lobby; }

        void startWriter() {
            Thread thread = new Thread(() -> {
                try {
                    OutputStream output = socket.getOutputStream();
                    while (!closed.get()) {
                        Outbound item = outgoing.poll(1, TimeUnit.SECONDS);
                        if (item == null) continue;
                        writingSince = System.nanoTime();
                        output.write(item.bytes());
                        output.flush();
                        writingSince = 0;
                        if (item.closeAfter()) break;
                    }
                } catch (IOException | InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                } finally { disconnect(); }
            }, "大厅发送-" + id.substring(0, 8));
            thread.setDaemon(true);
            thread.start();
        }

        void send(Map<String, Object> message) { enqueue(textFrame(message), false); }
        void error(String code, String message) { send(object("type", "error", "code", code, "message", message)); }

        void enqueue(byte[] bytes, boolean closeAfter) {
            if (!closed.get() && !outgoing.offer(new Outbound(bytes, closeAfter))) {
                // 队列满代表客户端不能及时读取。关 socket 让读线程退出并移除玩家；
                // 不在广播中递归修改大厅，防止新状态之后又发送旧状态。
                disconnect();
            }
        }

        void readMessages() throws IOException {
            ByteArrayOutputStream fragmented = null;
            try {
                while (!closed.get()) {
                    int first = readByte(input);
                    int second = readByte(input);
                    boolean fin = (first & 0x80) != 0;
                    int opcode = first & 15;
                    if ((first & 0x70) != 0 || (second & 0x80) == 0) throw protocol(1002, "帧格式错误或客户端未使用掩码");
                    long length = second & 127;
                    if (length == 126) {
                        length = ((long) readByte(input) << 8) | readByte(input);
                        if (length < 126) throw protocol(1002, "帧长度编码错误");
                    } else if (length == 127) {
                        length = 0;
                        for (int index = 0; index < 8; index++) {
                            int value = readByte(input);
                            if (index == 0 && (value & 128) != 0) throw protocol(1002, "帧长度编码错误");
                            length = (length << 8) | value;
                        }
                        if (length < 65536) throw protocol(1002, "帧长度编码错误");
                    }
                    boolean control = opcode >= 8;
                    if (control && (!fin || length > 125)) throw protocol(1002, "控制帧格式错误");
                    if (opcode != 0 && opcode != 1 && opcode != 2 && opcode != 8 && opcode != 9 && opcode != 10)
                        throw protocol(1002, "不支持的帧类型");
                    if (length > MAX_MESSAGE_BYTES) throw protocol(1009, "消息超过 64 KiB 上限");
                    if (opcode == 2) throw protocol(1003, "大厅只接收文本消息");
                    if (!control && ((opcode == 0 && fragmented == null) || (opcode != 0 && fragmented != null)))
                        throw protocol(1002, "分片消息顺序错误");
                    byte[] mask = readExact(input, 4);
                    byte[] payload = readExact(input, (int) length);
                    for (int index = 0; index < payload.length; index++) payload[index] ^= mask[index & 3];
                    if (opcode == 8) {
                        validateClose(payload);
                        beginClose(payload);
                        break;
                    }
                    if (opcode == 9) { enqueue(frame(10, payload), false); continue; }
                    if (opcode == 10) {
                        synchronized (heartbeatLock) {
                            if (pingSentAt != 0 && Arrays.equals(payload, ping)) {
                                pingSentAt = 0;
                                lastPongAt = System.nanoTime();
                                ping = null;
                            }
                        }
                        continue;
                    }
                    if (opcode == 1 && !fin) fragmented = new ByteArrayOutputStream();
                    if (fragmented != null) {
                        if (fragmented.size() + payload.length > MAX_MESSAGE_BYTES) throw protocol(1009, "分片消息超过 64 KiB 上限");
                        fragmented.write(payload);
                        if (!fin) continue;
                        payload = fragmented.toByteArray();
                        fragmented = null;
                    }
                    String text = utf8(payload);
                    if (!messageRate.take()) { error("rate_limited", "消息发送过快，请稍后重试"); continue; }
                    try {
                        Object parsed = Json.parse(text);
                        if (!(parsed instanceof Map<?, ?>)) throw new IllegalArgumentException("消息必须是 JSON 对象");
                        @SuppressWarnings("unchecked") Map<String, Object> message = (Map<String, Object>) parsed;
                        lobby.process(this, message);
                    } catch (IllegalArgumentException exception) {
                        error("invalid_json", "消息不是有效的 JSON 对象：" + exception.getMessage());
                    }
                }
            } catch (ProtocolProblem problem) {
                ByteArrayOutputStream reason = new ByteArrayOutputStream();
                reason.write(problem.code >> 8);
                reason.write(problem.code & 255);
                reason.write(problem.getMessage().getBytes(StandardCharsets.UTF_8));
                beginClose(reason.toByteArray());
            } finally {
                if (closing) {
                    try { disconnected.await(750, TimeUnit.MILLISECONDS); }
                    catch (InterruptedException exception) { Thread.currentThread().interrupt(); }
                }
            }
        }

        private void beginClose(byte[] payload) { closing = true; enqueue(frame(8, payload), true); }

        void disconnect() {
            if (!closed.compareAndSet(false, true)) return;
            try { socket.shutdownInput(); } catch (IOException ignored) {}
            try { socket.shutdownOutput(); } catch (IOException ignored) {}
            try { socket.close(); } catch (IOException ignored) {}
            outgoing.clear();
            disconnected.countDown();
        }
    }

    private record Outbound(byte[] bytes, boolean closeAfter) {}

    /** 全连接限流由读线程使用；状态/射击限流在大厅锁内使用。 */
    private static final class TokenBucket {
        private final double rate;
        private final double capacity;
        private double tokens;
        private long updated = System.nanoTime();

        TokenBucket(double rate, double capacity) { this.rate = rate; this.capacity = capacity; this.tokens = capacity; }

        boolean take() {
            long now = System.nanoTime();
            tokens = Math.min(capacity, tokens + (now - updated) / 1_000_000_000.0 * rate);
            updated = now;
            if (tokens < 1) return false;
            tokens -= 1;
            return true;
        }
    }

    private static byte[] textFrame(Map<String, Object> value) { return frame(1, Json.stringify(value).getBytes(StandardCharsets.UTF_8)); }

    private static byte[] frame(int opcode, byte[] payload) {
        ByteArrayOutputStream output = new ByteArrayOutputStream(payload.length + 10);
        output.write(0x80 | opcode);
        if (payload.length < 126) output.write(payload.length);
        else if (payload.length <= 65535) {
            output.write(126); output.write(payload.length >> 8); output.write(payload.length & 255);
        } else {
            output.write(127);
            for (int shift = 56; shift >= 0; shift -= 8) output.write((int) (((long) payload.length >> shift) & 255));
        }
        output.writeBytes(payload);
        return output.toByteArray();
    }

    private static int readByte(InputStream input) throws IOException {
        int value = input.read();
        if (value < 0) throw new EOFException();
        return value;
    }

    private static byte[] readExact(InputStream input, int length) throws IOException {
        byte[] bytes = input.readNBytes(length);
        if (bytes.length != length) throw new EOFException();
        return bytes;
    }

    private static String utf8(byte[] bytes) throws ProtocolProblem {
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException exception) { throw protocol(1007, "消息必须是有效的 UTF-8 文本"); }
    }

    private static void validateClose(byte[] payload) throws ProtocolProblem {
        if (payload.length == 1) throw protocol(1002, "关闭帧格式错误");
        if (payload.length >= 2) {
            int code = ((payload[0] & 255) << 8) | (payload[1] & 255);
            if (!((code >= 1000 && code <= 1014 && code != 1004 && code != 1005 && code != 1006)
                    || (code >= 3000 && code <= 4999))) throw protocol(1002, "关闭状态码无效");
            utf8(Arrays.copyOfRange(payload, 2, payload.length));
        }
    }

    private static ProtocolProblem protocol(int code, String message) { return new ProtocolProblem(code, message); }
    private static final class ProtocolProblem extends Exception {
        final int code;
        ProtocolProblem(int code, String message) { super(message); this.code = code; }
    }

    private static LobbyProblem problem(String code, String message) { return new LobbyProblem(code, message); }
    private static final class LobbyProblem extends Exception {
        final String code;
        LobbyProblem(String code, String message) { super(message); this.code = code; }
    }

    private static String string(Object value, String name, int limit, boolean multiline) throws LobbyProblem {
        if (!(value instanceof String)) throw problem("invalid_message", name + "必须是文本");
        String text = ((String) value).strip();
        if (text.isEmpty() || text.codePointCount(0, text.length()) > limit)
            throw problem("invalid_message", name + "必须为 1–" + limit + " 个字符");
        for (int index = 0; index < text.length(); index++) {
            char valueAt = text.charAt(index);
            if (Character.isISOControl(valueAt) && !(multiline && (valueAt == '\n' || valueAt == '\t')))
                throw problem("invalid_message", name + "包含不可使用的控制字符");
        }
        return text;
    }

    private static int integer(Object value, int min, int max, String name) throws LobbyProblem {
        if (value instanceof BigDecimal decimal) {
            try {
                int parsed = decimal.intValueExact();
                if (parsed >= min && parsed <= max) return parsed;
            } catch (ArithmeticException ignored) {}
        }
        throw problem("invalid_message", name + "必须为 " + min + "–" + max + " 的整数");
    }

    private static long longInteger(Object value, long min, long max, String name) throws LobbyProblem {
        if (value instanceof BigDecimal decimal) {
            try {
                long parsed = decimal.longValueExact();
                if (parsed >= min && parsed <= max) return parsed;
            } catch (ArithmeticException ignored) {}
        }
        throw problem("invalid_message", name + "必须为 " + min + "–" + max + " 的整数");
    }

    private static double finiteNumber(Object value, double min, double max, String name) throws LobbyProblem {
        if (value instanceof BigDecimal decimal) {
            double parsed = decimal.doubleValue();
            if (Double.isFinite(parsed) && decimal.compareTo(BigDecimal.valueOf(min)) >= 0
                    && decimal.compareTo(BigDecimal.valueOf(max)) <= 0) return parsed;
        }
        throw problem("invalid_message", name + "必须为 " + min + "–" + max + " 的有限数值");
    }

    private static List<Double> coordinates(Object value, String name) throws LobbyProblem {
        if (!(value instanceof List<?> list) || list.size() != 3)
            throw problem("invalid_message", name + "必须包含三个坐标值");
        List<Double> result = new ArrayList<>(3);
        for (Object coordinate : list) result.add(finiteNumber(coordinate, -16000, 16000, name));
        return result;
    }

    private static Map<String, Object> object(Object... pairs) {
        LinkedHashMap<String, Object> result = new LinkedHashMap<>();
        for (int index = 0; index < pairs.length; index += 2) result.put((String) pairs[index], pairs[index + 1]);
        return result;
    }

    /** 仅用于大厅协议的小型严格 JSON 实现：限制深度、数值长度并拒绝重复键。 */
    private static final class Json {
        private final String input;
        private int position;
        private Json(String input) { this.input = input; }

        static Object parse(String input) {
            Json parser = new Json(input);
            Object result = parser.value(0);
            parser.space();
            if (parser.position != input.length()) throw parser.fail("对象后存在多余内容");
            return result;
        }

        private Object value(int depth) {
            if (depth > 16) throw fail("JSON 嵌套过深");
            space();
            if (position >= input.length()) throw fail("缺少内容");
            char start = input.charAt(position);
            if (start == '"') return quoted();
            if (start == '{') {
                position++;
                LinkedHashMap<String, Object> result = new LinkedHashMap<>();
                space();
                if (take('}')) return result;
                do {
                    space();
                    if (position >= input.length() || input.charAt(position) != '"') throw fail("对象键必须是文本");
                    String key = quoted();
                    if (result.containsKey(key)) throw fail("对象包含重复键");
                    space();
                    expect(':');
                    result.put(key, value(depth + 1));
                    if (result.size() > 128) throw fail("对象字段过多");
                    space();
                    if (take('}')) return result;
                    expect(',');
                } while (true);
            }
            if (start == '[') {
                position++;
                ArrayList<Object> result = new ArrayList<>();
                space();
                if (take(']')) return result;
                do {
                    result.add(value(depth + 1));
                    if (result.size() > 256) throw fail("数组元素过多");
                    space();
                    if (take(']')) return result;
                    expect(',');
                } while (true);
            }
            if (start == 't') { literal("true"); return true; }
            if (start == 'f') { literal("false"); return false; }
            if (start == 'n') { literal("null"); return null; }
            return number();
        }

        private BigDecimal number() {
            int start = position;
            take('-');
            if (take('0')) {
                if (position < input.length() && digit(input.charAt(position))) throw fail("数值不能包含前导零");
            } else {
                if (position >= input.length() || input.charAt(position) < '1' || input.charAt(position) > '9') throw fail("数值格式错误");
                while (position < input.length() && digit(input.charAt(position))) position++;
            }
            if (take('.')) {
                int decimals = position;
                while (position < input.length() && digit(input.charAt(position))) position++;
                if (decimals == position) throw fail("数值缺少小数位");
            }
            if (position < input.length() && (input.charAt(position) == 'e' || input.charAt(position) == 'E')) {
                position++;
                if (!take('+')) take('-');
                int exponent = position;
                while (position < input.length() && digit(input.charAt(position))) position++;
                if (exponent == position || position - exponent > 4) throw fail("数值指数格式错误");
            }
            if (position - start > 100) throw fail("数值过长");
            try {
                BigDecimal number = new BigDecimal(input.substring(start, position));
                if (Math.abs((long) number.scale()) > 1000 || !Double.isFinite(number.doubleValue())) throw fail("数值超过允许范围");
                return number;
            } catch (NumberFormatException exception) { throw fail("数值格式错误"); }
        }

        private String quoted() {
            expect('"');
            StringBuilder result = new StringBuilder();
            boolean ended = false;
            while (position < input.length()) {
                char character = input.charAt(position++);
                if (character == '"') { ended = true; break; }
                if (character < 32) throw fail("文本包含未转义的控制字符");
                if (character == '\\') {
                    if (position >= input.length()) throw fail("转义格式错误");
                    char escape = input.charAt(position++);
                    character = switch (escape) {
                        case '"', '\\', '/' -> escape;
                        case 'b' -> '\b';
                        case 'f' -> '\f';
                        case 'n' -> '\n';
                        case 'r' -> '\r';
                        case 't' -> '\t';
                        case 'u' -> unicode();
                        default -> throw fail("不支持的转义字符");
                    };
                }
                result.append(character);
            }
            if (!ended) throw fail("文本缺少结束引号");
            for (int index = 0; index < result.length(); index++) {
                char character = result.charAt(index);
                if (Character.isHighSurrogate(character)) {
                    if (++index >= result.length() || !Character.isLowSurrogate(result.charAt(index))) throw fail("Unicode 代理字符不完整");
                } else if (Character.isLowSurrogate(character)) throw fail("Unicode 代理字符不完整");
            }
            return result.toString();
        }

        private char unicode() {
            if (position + 4 > input.length()) throw fail("Unicode 转义不完整");
            int result = 0;
            for (int index = 0; index < 4; index++) {
                int digit = Character.digit(input.charAt(position++), 16);
                if (digit < 0) throw fail("Unicode 转义格式错误");
                result = (result << 4) | digit;
            }
            return (char) result;
        }

        private void literal(String value) {
            if (!input.startsWith(value, position)) throw fail("值格式错误");
            position += value.length();
        }
        private void space() {
            while (position < input.length()) {
                char value = input.charAt(position);
                if (value != ' ' && value != '\t' && value != '\n' && value != '\r') return;
                position++;
            }
        }
        private boolean take(char value) {
            if (position < input.length() && input.charAt(position) == value) { position++; return true; }
            return false;
        }
        private void expect(char value) { if (!take(value)) throw fail("缺少“" + value + "”"); }
        private static boolean digit(char value) { return value >= '0' && value <= '9'; }
        private IllegalArgumentException fail(String message) { return new IllegalArgumentException(message); }

        static String stringify(Object value) {
            StringBuilder output = new StringBuilder();
            write(output, value);
            return output.toString();
        }

        private static void write(StringBuilder output, Object value) {
            if (value == null) { output.append("null"); return; }
            if (value instanceof String text) {
                output.append('"');
                for (int index = 0; index < text.length(); index++) {
                    char character = text.charAt(index);
                    switch (character) {
                        case '"' -> output.append("\\\"");
                        case '\\' -> output.append("\\\\");
                        case '\n' -> output.append("\\n");
                        case '\r' -> output.append("\\r");
                        case '\t' -> output.append("\\t");
                        default -> {
                            if (character < 32) output.append(String.format(Locale.ROOT, "\\u%04x", (int) character));
                            else output.append(character);
                        }
                    }
                }
                output.append('"');
            } else if (value instanceof Boolean || value instanceof Number) output.append(value);
            else if (value instanceof Map<?, ?> map) {
                output.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    if (!first) output.append(',');
                    first = false;
                    write(output, entry.getKey().toString());
                    output.append(':');
                    write(output, entry.getValue());
                }
                output.append('}');
            } else if (value instanceof Iterable<?> items) {
                output.append('[');
                boolean first = true;
                for (Object item : items) {
                    if (!first) output.append(',');
                    first = false;
                    write(output, item);
                }
                output.append(']');
            } else throw new IllegalArgumentException("不支持的 JSON 值类型");
        }
    }
}
