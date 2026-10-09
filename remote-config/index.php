<?php
declare(strict_types=1);

/*
 * 远程配置入口：https://oss.2t.hk/gtav/。需要 PHP 7.4+ 网站环境，目录首页设为 index.php。
 * 启动器、游戏菜单和服务器状态页共用这份配置；接口不写文件、不修改游戏或战局。
 * 在下面“配置内容”维护公告、线路和已发布下载。请求参数、POST 正文均不会覆盖配置。
 */
const ALLOWED_ORIGINS = [
    '*', // 允许所有来源；如需限制，删除 '*' 并填写完整的来源地址。
];
const ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'OPTIONS'];
const ALLOWED_HEADERS = ['accept', 'authorization', 'content-type', 'x-requested-with'];

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
header('Allow: ' . implode(', ', ALLOWED_METHODS));

$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$headOnly = $method === 'HEAD';

function sendJson(array $payload, int $status = 200, bool $headOnly = false): void
{
    try {
        $body = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
            | JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";
        if (strlen($body) > 256 * 1024) {
            throw new LengthException('Configuration exceeds the client response limit.');
        }
    } catch (Throwable $error) {
        $status = 500;
        $body = '{"status":"fail","code":"config_encoding_failed","msg":"配置内容无法编码，请联系维护者。"}' . "\n";
        error_log('GTAV remote config: JSON encoding failed.');
    }
    http_response_code($status);
    header('Content-Length: ' . strlen($body));
    if (!$headOnly) {
        echo $body;
    }
    exit;
}

$origin = trim((string) ($_SERVER['HTTP_ORIGIN'] ?? ''));
$allowAnyOrigin = in_array('*', ALLOWED_ORIGINS, true);
// 无 Origin 的原生启动器、服务端代理及同源请求无需 CORS；白名单不是身份认证。
if ($origin !== '' || $allowAnyOrigin) {
    if (!$allowAnyOrigin && !in_array($origin, ALLOWED_ORIGINS, true)) {
        sendJson(['status' => 'fail', 'code' => 'origin_not_allowed', 'msg' => '此来源不允许读取配置。'], 403, $headOnly);
    }
    header('Access-Control-Allow-Origin: ' . ($allowAnyOrigin ? '*' : $origin));
    // 公共只读配置不需要 Cookie，也不启用跨域凭据。
    header('Access-Control-Allow-Methods: ' . implode(', ', ALLOWED_METHODS));
    header('Access-Control-Allow-Headers: Accept, Authorization, Content-Type, X-Requested-With');
    header('Access-Control-Max-Age: 86400');
}

if (!in_array($method, ALLOWED_METHODS, true)) {
    sendJson(['status' => 'fail', 'code' => 'method_not_allowed', 'msg' => '此接口只提供只读配置。'], 405, $headOnly);
}
if ($method === 'OPTIONS') {
    $requestedMethod = strtoupper(trim((string) ($_SERVER['HTTP_ACCESS_CONTROL_REQUEST_METHOD'] ?? '')));
    if ($requestedMethod !== '' && !in_array($requestedMethod, ['GET', 'HEAD', 'POST'], true)) {
        sendJson(['status' => 'fail', 'code' => 'preflight_method_not_allowed', 'msg' => '预检请求的方法不受支持。'], 405);
    }
    foreach (explode(',', (string) ($_SERVER['HTTP_ACCESS_CONTROL_REQUEST_HEADERS'] ?? '')) as $requestedHeader) {
        $requestedHeader = strtolower(trim($requestedHeader));
        if ($requestedHeader !== '' && !in_array($requestedHeader, ALLOWED_HEADERS, true)) {
            sendJson(['status' => 'fail', 'code' => 'preflight_header_not_allowed', 'msg' => '预检请求的标头不受支持。'], 400);
        }
    }
    http_response_code(204);
    header('Content-Length: 0');
    exit;
}

function configText($value, int $max, string $field): string
{
    if (!is_string($value) || preg_match('//u', $value) !== 1
        || preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', $value) === 1
        || preg_match_all('/./us', $value) > $max) {
        throw new InvalidArgumentException('Invalid text: ' . $field);
    }
    return $value;
}

function configUrl($value, bool $httpsOnly = true): string
{
    if (!is_string($value) || strlen($value) > 2048 || preg_match('/[\s\x00-\x1F\x7F]/u', $value) !== 0
        || filter_var($value, FILTER_VALIDATE_URL) === false) {
        throw new InvalidArgumentException('Invalid configuration URL.');
    }
    $parts = parse_url($value);
    $schemes = $httpsOnly ? ['https'] : ['http', 'https'];
    if (!is_array($parts) || !in_array(strtolower($parts['scheme'] ?? ''), $schemes, true)
        || empty($parts['host']) || isset($parts['user']) || isset($parts['pass'])) {
        throw new InvalidArgumentException('Unsafe configuration URL.');
    }
    return $value;
}

function configTitle($value): string
{
    $value = configText($value, 160, 'i18n.oltitle');
    if (preg_match('/[<>\r\n\t]/', $value) === 1) {
        throw new InvalidArgumentException('Invalid translated title.');
    }
    if (preg_match('/^[a-z][a-z0-9+.-]*:/i', $value) === 1) {
        configUrl($value);
    }
    return $value;
}

function publishedDownloads(array $candidates): stdClass
{
    // 返回 JSON 对象 {}，不能用空数组 []；桌面启动器按 Map 读取 downloads。
    $downloads = new stdClass();
    foreach ($candidates as $platform => $entry) {
        if (!preg_match('/^[a-z0-9_]{1,40}$/', (string) $platform) || !is_array($entry)) {
            throw new InvalidArgumentException('Invalid download platform.');
        }
        $url = $entry['url'] ?? '';
        // 未上传的包不显示按钮。不得用示例地址或全零 SHA-256 冒充已发布文件。
        if ($url === '') {
            continue;
        }
        $url = configUrl($url);
        $hash = $entry['sha256'] ?? '';
        if (!is_string($hash) || !preg_match('/^[a-f0-9]{64}$/i', $hash) || $hash === str_repeat('0', 64)) {
            throw new InvalidArgumentException('Missing real download SHA-256.');
        }
        $downloads->{$platform} = ['url' => $url, 'sha256' => strtolower($hash)];
    }
    return $downloads;
}

// ── 配置内容：维护者只需要修改这一段 ──
$site = 'https://gtav.2t.hk';
$latestVersion = '0.2.12';
$releaseNotes = "启动器 0.2.12 加入中文、English 和跟随系统；游戏网页与局域网证书引导页自动使用同一语言，已经打开的页面同步更新。原游戏菜单语言在下次进入游戏时生效。配套服务端 0.4.2 补充公共出生区步行导航、卡住恢复、尸体清理与人口补充。所有适配由启动器和服务端完成，原游戏资源保持只读。当前仍为实验版，macOS 包为开发签名、未公证。";
$servers = [
    ['id' => 'main', 'name' => '公共战局', 'role' => '主线路', 'address' => 'gtaserver.2t.hk:47485',
        'health_url' => 'https://gtaserver.2t.hk:47485/47485/health',
        'region' => 'CN',
        'i18n' => ['zh-CN' => ['name' => '公共战局', 'role' => '主线路'],
            'en' => ['name' => 'Public Session', 'role' => 'Main']]],
    ['id' => 'experimental', 'name' => '实验战局', 'role' => '实验线路', 'address' => 'gtaserver.2t.hk:47486',
        'health_url' => 'https://gtaserver.2t.hk:47486/47486/health',
        'region' => 'CN',
        'i18n' => ['zh-CN' => ['name' => '实验战局', 'role' => '实验线路'],
            'en' => ['name' => 'Experimental Session', 'role' => 'Experimental']]],
];
// health_url 使用游戏服务器域名的 HTTPS 反向代理；status_url 是网页，不是健康接口。
$announcements = [
    [
        'title' => '欢迎来到 GTA V 公共战局',
        'body' => "使用启动器选择自己的游戏资源目录，进入游戏后按 O 加入公共战局。\n所有玩家需连接同一条线路；不同端口是独立战局。",
        'date' => '2026-10-09',
        'url' => $site,
    ],
    [
        'title' => '实验功能说明',
        'body' => "共同世界同步仍在测试中，步行导航和警力派遣目前限定公共出生区附近。\n若遇到同步异常，可记录双方操作与发生时间后反馈。",
        'date' => '2026-10-09',
        'url' => $site,
    ],
];
$translations = [
    'zh-CN' => ['oltitle' => $site, 'release_notes' => $releaseNotes, 'announcements' => $announcements],
    'en' => [
        'oltitle' => $site,
        'release_notes' => 'Launcher 0.2.12 adds Chinese and English throughout the launcher, game pages and LAN certificate guide. Select a language in Settings; open pages follow automatically. Native game menus use the chosen language on the next game entry. Server 0.4.2 adds pedestrian navigation, stuck recovery, corpse cleanup and population refill near the public spawn area. Original game resources remain read-only. Experimental release; the macOS development build is not notarized.',
        'announcements' => [
            ['title' => 'Welcome to the GTA V public session',
                'body' => "Select your own game resources folder in the launcher, then press O in game to join.\nPlayers must use the same server; each port has a separate session.",
                'date' => '2026-10-09', 'url' => $site],
            ['title' => 'Experimental features',
                'body' => "Shared world synchronization is still being tested. Pedestrian navigation and police dispatch currently cover the public spawn area.\nIf synchronization fails, report both players' actions and the time it occurred.",
                'date' => '2026-10-09', 'url' => $site],
        ],
    ],
];
$downloadCandidates = [
    'macos_arm64' => [
        'url' => 'https://oss.2t.hk/gtav/GTA5Data-Launcher-macOS-arm64-v0.2.12-development.zip',
        'sha256' => 'fdb1b1f888994967ee4cece4822d03a9d9d4bd940a71709f6c4baaa4ccb469c7',
    ],
    'windows_x64' => [
        'url' => 'https://oss.2t.hk/gtav/GTA5Data-Launcher-Windows-x64-v0.2.12.exe',
        'sha256' => 'a06b610965da839bc6160ebdc137fc5d9baa46db89d58e594d69ef7a1b9bd8a8',
    ],
];
// ── 配置内容结束 ──

try {
    configUrl($site);
    if (!preg_match('/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/D', $latestVersion)) {
        throw new InvalidArgumentException('Invalid launcher version.');
    }
    configText($releaseNotes, 8192, 'release_notes');
    if (count($servers) < 1 || count($servers) > 32 || count($announcements) > 24) {
        throw new InvalidArgumentException('Invalid configuration size.');
    }
    $ids = [];
    foreach ($servers as $server) {
        if (!is_array($server) || !isset($server['id'], $server['name'], $server['role'], $server['address'])
            || !is_string($server['id']) || !is_string($server['address'])) {
            throw new InvalidArgumentException('Missing required server fields.');
        }
        if (!preg_match('/^[a-z0-9][a-z0-9_-]{0,63}$/i', $server['id']) || isset($ids[$server['id']])) {
            throw new InvalidArgumentException('Invalid or duplicate server ID.');
        }
        $ids[$server['id']] = true;
        if (!preg_match('/^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):([0-9]{1,5})$/i', $server['address'], $match)
            || (int) $match[1] < 1 || (int) $match[1] > 65535) {
            throw new InvalidArgumentException('Invalid server address.');
        }
        configUrl('http://' . $server['address'] . '/health', false);
        if (trim(configText($server['name'], 80, 'server.name')) === '') {
            throw new InvalidArgumentException('Empty server name.');
        }
        configText($server['role'], 80, 'server.role');
        if (array_key_exists('region', $server)) {
            configText($server['region'], 64, 'server.region');
        }
        foreach ($server['i18n'] ?? [] as $locale => $translation) {
            if (!in_array($locale, ['zh-CN', 'en'], true) || !is_array($translation)
                || trim(configText($translation['name'] ?? '', 80, 'server.i18n.name')) === '') {
                throw new InvalidArgumentException('Invalid server translation.');
            }
            configText($translation['role'] ?? '', 80, 'server.i18n.role');
            if (array_key_exists('region', $translation)) {
                configText($translation['region'], 64, 'server.i18n.region');
            }
        }
        if (isset($server['health_url'])) {
            configUrl($server['health_url'], false);
        }
    }
    foreach ($announcements as $announcement) {
        if (!is_array($announcement) || !isset($announcement['title'], $announcement['body'])) {
            throw new InvalidArgumentException('Missing required announcement fields.');
        }
        if (trim(configText($announcement['title'], 120, 'announcement.title')) === '') {
            throw new InvalidArgumentException('Empty announcement title.');
        }
        configText($announcement['body'], 4096, 'announcement.body');
        if (isset($announcement['date'])) {
            configText($announcement['date'], 40, 'announcement.date');
        }
        if (isset($announcement['url'])) {
            configUrl($announcement['url']);
        }
    }
    foreach ($translations as $locale => $translation) {
        if (!in_array($locale, ['zh-CN', 'en'], true) || !is_array($translation)
            || !is_array($translation['announcements'] ?? null) || count($translation['announcements']) > 24) {
            throw new InvalidArgumentException('Invalid configuration translation.');
        }
        configTitle($translation['oltitle']);
        configText($translation['release_notes'], 8192, 'i18n.release_notes');
        foreach ($translation['announcements'] as $announcement) {
            if (!is_array($announcement) || trim(configText($announcement['title'] ?? '', 120, 'i18n.announcement.title')) === '') {
                throw new InvalidArgumentException('Invalid translated announcement.');
            }
            configText($announcement['body'] ?? '', 4096, 'i18n.announcement.body');
            if (isset($announcement['date'])) { configText($announcement['date'], 40, 'i18n.announcement.date'); }
            if (isset($announcement['url'])) { configUrl($announcement['url']); }
        }
    }
    $config = [
        'schema_version' => 1,
        'oltitle' => $site,
        'website' => $site,
        // server 与 servers 返回同一完整线路目录，保留可选地区与翻译字段。
        'server' => $servers,
        'servers' => $servers,
        'announcements' => $announcements,
        'i18n' => $translations,
        'update' => ['latest_version' => $latestVersion, 'release_notes' => $releaseNotes,
            'downloads' => publishedDownloads($downloadCandidates)],
    ];
    sendJson($config, 200, $headOnly);
} catch (Throwable $error) {
    // 错误细节只写服务器日志；不把路径、配置或运行时信息泄漏给客户端。
    error_log('GTAV remote config: configuration validation failed.');
    sendJson(['status' => 'fail', 'code' => 'config_invalid', 'msg' => '配置暂时不可用，请稍后重试。'], 500, $headOnly);
}
