"""在限定范围内发现用户指定资源来源的同源公开资源。

使用已经完成的镜像清单，不使用文件名字典，也不尝试认证或绕过访问控制。
"""
import argparse
import concurrent.futures as futures
import hashlib
import html.parser
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from mirror_site import validate_origin

ROOT = Path(__file__).resolve().parents[1]
MIRROR = ROOT / "gta5data"
SNAPSHOT = ROOT / "docs" / "snapshot"
BASE = ""
UA = "curl/8.0 public-mirror-discovery"
TIMEOUT = 25
MAX_WORKERS = 16

known = []
known_paths = set()
homepage_hash = None
lock = threading.Lock()
attempts = []
added = []

def norm_path(path):
    path = urllib.parse.unquote(urllib.parse.urlsplit(path).path)
    if not path.startswith("/"):
        path = "/" + path
    if any(c in path for c in ("\\", ":", "\0")) or ".." in path.split("/"):
        raise ValueError("不安全的资源路径 " + path)
    return path

def target_path(path):
    target = (MIRROR / norm_path(path).lstrip("/")).resolve()
    if not target.is_relative_to(MIRROR.resolve()):
        raise ValueError("资源路径超出 gta5data 目录 " + path)
    return target

def request(path):
    path = norm_path(path)
    url = BASE + urllib.parse.quote(path, safe="/")
    started = time.monotonic()
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            body = res.read()
            out = {"url": url, "path": path, "status": res.status,
                   "content_type": res.headers.get("Content-Type", ""),
                   "bytes": len(body), "body": body,
                   "elapsed_ms": round((time.monotonic() - started) * 1000)}
    except urllib.error.HTTPError as e:
        out = {"url": url, "path": path, "status": e.code,
               "content_type": e.headers.get("Content-Type", ""), "bytes": 0,
               "elapsed_ms": round((time.monotonic() - started) * 1000)}
    except Exception as e:
        out = {"url": url, "path": path, "status": None, "error": str(e), "bytes": 0,
               "elapsed_ms": round((time.monotonic() - started) * 1000)}
    with lock:
        attempts.append({k: v for k, v in out.items() if k != "body"})
    return out

def fallback(result):
    body = result.get("body", b"")
    if hashlib.sha256(body).hexdigest() == homepage_hash:
        return "homepage-sha256"
    text = body[:4096].lower()
    if b'<div id="loading"' in text and b'<canvas' in text:
        return "homepage-signature"
    return None

class Refs(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(); self.refs = []
    def handle_starttag(self, tag, attrs):
        for k, v in attrs:
            if k.lower() in ("href", "src", "action", "poster") and v:
                self.refs.append(v)

def same_origin_refs(path, body, content_type):
    if not ("text/" in content_type or "javascript" in content_type or path.endswith((".js", ".css", ".html", ".xml", ".webmanifest"))):
        return set()
    try: text = body.decode("utf-8", "ignore")
    except Exception: return set()
    p = Refs()
    try: p.feed(text)
    except Exception: pass
    p.refs += re.findall(r"(?:['\"])(/[^'\"\\\\?#\s]+|https?://[^'\"\\\\?#\s]+)", text)
    out = set()
    source = urllib.parse.urlsplit(BASE)
    for ref in p.refs:
        try:
            u = urllib.parse.urljoin(BASE + path, ref)
            s = urllib.parse.urlsplit(u)
            if s.scheme != source.scheme or s.netloc.lower() != source.netloc.lower():
                continue
            clean = norm_path(s.path)
        except ValueError:
            continue
        if clean and clean not in known_paths:
            out.add(clean)
    return out

def save_addition(result, provenance):
    path, body = result["path"], result["body"]
    if path in known_paths or fallback(result): return False
    target = target_path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists(): return False
    target.write_bytes(body)
    item = {"path": path, "url": result["url"], "bytes": len(body),
            "sha256": hashlib.sha256(body).hexdigest(), "content_type": result["content_type"],
            "provenance": provenance}
    with lock:
        added.append(item); known_paths.add(path)
    return True

def run_batch(paths, provenance):
    refs = set()
    with futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        for result in pool.map(request, sorted(set(paths))):
            if result.get("status") == 200 and "body" in result:
                is_dir = result["path"].endswith("/")
                if not is_dir: save_addition(result, provenance)
                refs.update(same_origin_refs(result["path"], result["body"], result["content_type"]))
    return refs

def main(argv=None):
    global BASE, known, known_paths, homepage_hash, attempts, added, MAX_WORKERS
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', default=os.environ.get('GTA5DATA_SOURCE_URL'), type=validate_origin,
                        help='资源来源的 HTTP(S) 根地址；也可使用 GTA5DATA_SOURCE_URL 环境变量')
    parser.add_argument('--workers', type=int, default=16, help='并发请求数量，默认为 16')
    args = parser.parse_args(argv)
    if not args.origin:
        parser.error('请通过 --origin 或 GTA5DATA_SOURCE_URL 指定资源来源地址')
    if args.workers < 1:
        parser.error('并发请求数量必须大于 0')
    BASE, MAX_WORKERS = args.origin, args.workers
    manifest = SNAPSHOT / 'manifest-sha256.json'
    homepage = ROOT / 'archive' / 'original' / 'homepage.html'
    missing = [str(path.relative_to(ROOT)) for path in (manifest, homepage) if not path.is_file()]
    if not MIRROR.is_dir():
        missing.insert(0, 'gta5data/')
    if missing:
        parser.error('缺少本地资源快照或采集参考：' + '、'.join(missing)
                     + '；请先准备 gta5data 资源，Git 仓库不包含游戏数据')
    try:
        known = json.loads(manifest.read_text(encoding='utf-8'))
        known_paths = {norm_path(item['path']) for item in known}
        homepage_hash = hashlib.sha256(homepage.read_bytes()).hexdigest()
    except (OSError, ValueError, TypeError, KeyError) as exc:
        parser.error('无法读取本地采集清单或首页参考：' + str(exc))
    attempts, added = [], []
    SNAPSHOT.mkdir(parents=True, exist_ok=True)

    # 检查常见公开资源入口，以及根页面资源中可见的构建引用。
    standard = [
        "/robots.txt", "/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml",
        "/favicon.ico", "/favicon.png", "/apple-touch-icon.png", "/site.webmanifest",
        "/manifest.webmanifest", "/manifest.json", "/browserconfig.xml", "/humans.txt",
        "/security.txt", "/.well-known/security.txt",
    ]
    builds = sorted({p.split("/")[2] for p in known_paths if p.startswith("/b/") and p.count("/") >= 2})
    scripts = [p for p in known_paths if p.endswith((".js", ".css", ".html"))]
    maps = [p + ".map" for p in scripts]
    for b in builds:
        standard += [f"/b/{b}/manifest.json", f"/b/{b}/manifest.webmanifest", f"/b/{b}/sw.js", f"/b/{b}/service-worker.js"]

    # 对已知路径的每个目录只发起一次 GET，检查可见的目录列表或索引页。
    dirs = sorted({p.rsplit("/", 1)[0] + "/" for p in known_paths if p.count("/") >= 2})
    new_refs = run_batch(standard + maps, "conventional-or-runtime-derived")
    new_refs.update(run_batch(dirs, "known-directory-listing-check"))

    # 只跟踪新发现的同源引用，直到不再出现新引用或达到轮数上限。
    rounds = 0
    while new_refs and rounds < 4:
        todo = {p for p in new_refs if p not in known_paths}
        new_refs = run_batch(todo, "reachable-same-origin-reference") if todo else set()
        rounds += 1

    attempts.sort(key=lambda x: x["path"])
    added.sort(key=lambda x: x["path"])
    status_counts = {}
    for x in attempts: status_counts[str(x.get("status"))] = status_counts.get(str(x.get("status")), 0) + 1
    report = {
        "base": BASE, "run_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "user_agent": UA, "network_concurrency": MAX_WORKERS,
        "known_input_paths": len(known), "known_derived_directories": len(dirs),
        "build_ids": builds, "attempt_count": len(attempts), "status_counts": status_counts,
        "added_count": len(added), "added_bytes": sum(x["bytes"] for x in added),
        "attempts": attempts,
        "coverage": ["robots、站点地图、图标、Web 清单与 .well-known 安全说明", "运行脚本的 source-map 候选文件", "构建目录内的 manifest 和 service-worker 候选文件", f"对 {len(known)} 条已知路径派生的每个目录进行一次带结尾斜杠的请求", "从成功返回的文本响应中提取同源引用"],
        "limits": ["不进行认证、凭据使用、访问控制绕过、参数模糊测试或盲目文件名字典枚举。", "目录没有返回文件列表，并不能证明其中不存在未公开链接的子资源。", "仅嵌在二进制资源中的引用，或无法从已检查文本响应中识别的动态引用，不在本次发现范围内。", "只保存未命中已知首页兜底的成功 HTTP 响应；非 200 响应仅记录，不下载。"],
    }
    (SNAPSHOT / "discovery-added.json").write_text(json.dumps(added, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (SNAPSHOT / "discovery-report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (ROOT / "docs" / "公开资源发现报告.md").write_text(
        "# 公开资源发现报告\n\n"
        f"- 输入清单：{len(known)} 条路径；派生目录：{len(dirs)} 个。\n"
        f"- 请求数量：{len(attempts)}；HTTP 状态统计：{status_counts}。\n"
        f"- 新增资源：{len(added)} 个文件，共 {sum(x['bytes'] for x in added)} 字节。\n"
        "- 范围：常见资源发现入口、source-map 与构建候选文件、每个已知目录，以及可达的同源文本引用。\n"
        "- 限制：不探测认证或私有资源，不进行盲目字典枚举；未提供目录列表不能证明没有未链接的子资源。\n\n"
        "完整请求记录见 [发现报告](snapshot/discovery-report.json)，新增资源见 [新增清单](snapshot/discovery-added.json)。\n"
        "原始采集清单见 [SHA256 清单](snapshot/manifest-sha256.json)，以上记录均保存在 `docs/snapshot/`。\n",
        encoding="utf-8")
    print('公开资源发现完成；报告已保存到 docs/公开资源发现报告.md')
    print(json.dumps({"attempts": len(attempts), "status_counts": status_counts, "added": added}, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
