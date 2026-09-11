#!/usr/bin/env python3
"""A deliberately small, local-only server for Claude and Codex session transcripts."""
from __future__ import annotations

import json, os, re, secrets, socket, sys, threading, time
from collections import deque
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import qr

ROOT = Path(__file__).resolve().parent
PROJECTS = Path.home() / ".claude" / "projects"
CODEX_SESSIONS = Path.home() / ".codex" / "sessions"
CACHE = Path.home() / ".cache" / "claude-session-viewer" / "index.json"
STATIC = {"/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/app.css": "app.css",
          "/demo/style.css": "demo/style.css", "/demo/library.html": "demo/library.html",
          "/demo/transcript.html": "demo/transcript.html", "/demo/search.html": "demo/search.html",
          "/demo/compare.html": "demo/compare.html", "/demo/mobile.html": "demo/mobile.html",
          "/demo/reading-controls.html": "demo/reading-controls.html"}
INDEX_VERSION = 5
INDEX_TTL = 8.0          # serve the in-memory index for this long before rescanning
SEARCH_CAP = 300         # hard ceiling on returned search hits
PAGE_MAX = 500
PORT = 8787
LAN_PORT = PORT + 1      # phones connect here; loopback keeps its own port to itself

# A non-sensitive corpus used only by the checked-in documentation demo.
DEMO_SESSIONS = [
    {"id":"demo:pricing","source":"Codex","file":"","project":"forecasting","cwd":"/work/forecasting","branch":"main","title":"Build a pricing model","count":12,"tools":2,"models":["gpt-5.6"],"start":"2026-09-09T07:12:00Z","end":"2026-09-09T07:38:00Z","size":29400,"mtime":0,"malformed":0,"usage":{"input":12400,"output":836,"cacheRead":8200,"cacheWrite":0}},
    {"id":"demo:launch","source":"Claude","file":"","project":"website","cwd":"/work/website","branch":"launch-copy","title":"Refine the launch page","count":18,"tools":3,"models":["claude-sonnet"],"start":"2026-09-08T09:00:00Z","end":"2026-09-08T10:10:00Z","size":17300,"mtime":0,"malformed":0,"usage":{"input":8300,"output":1211,"cacheRead":4400,"cacheWrite":0}},
]
DEMO_RECORDS = [
    {"_offset":0,"type":"user","timestamp":"2026-09-09T07:12:00Z","message":{"content":"Model three price points for the new Pro plan. Keep the assumptions explicit and show the break-even point."}},
    {"_offset":420,"type":"assistant","timestamp":"2026-09-09T07:14:00Z","message":{"id":"demo-turn-1","model":"gpt-5.6","usage":{"input_tokens":12400,"output_tokens":836,"cache_read_input_tokens":8200,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"## A simple model, with room to revise\n\nI’d start with **$29**, **$39**, and **$49** per seat. At the middle tier, support costs are covered at 74 active accounts while preserving a comfortable gross margin."},{"type":"tool_use","id":"demo-tool","name":"python","input":{"task":"calculate break-even scenarios"}}]}},
    {"_offset":990,"type":"user","timestamp":"2026-09-09T07:15:00Z","message":{"content":[{"type":"tool_result","tool_use_id":"demo-tool","content":"Price $29: 96 accounts\nPrice $39: 74 accounts\nPrice $49: 61 accounts"}]}},
    {"_offset":1240,"type":"assistant","timestamp":"2026-09-09T07:17:00Z","message":{"id":"demo-turn-1","model":"gpt-5.6","content":[{"type":"text","text":"The assumptions worth pressure-testing next are conversion rate, annual-plan mix, and seats per account."}]}},
    {"_offset":1520,"type":"user","timestamp":"2026-09-09T07:20:00Z","message":{"content":"Turn this into a concise decision memo for the product team."}},
    {"_offset":1760,"type":"assistant","timestamp":"2026-09-09T07:22:00Z","message":{"id":"demo-turn-2","model":"gpt-5.6","content":[{"type":"text","text":"## Recommendation\n\nChoose **$39 per seat** as the default. It leaves room to invest in support without relying on aggressive conversion assumptions."}]}},
]
def is_demo(q): return q.get("demo", [""])[0] == "1"

index_lock = threading.Lock()
index_data = None

# The LAN listener is off until asked for, and even then only answers requests
# carrying this one-shot key — an open port alone reveals nothing.
share = {"server": None, "thread": None, "key": secrets.token_urlsafe(9), "url": None, "error": None}
share_lock = threading.Lock()

# ---------------------------------------------------------------- text helpers

def text_of(content):
    if isinstance(content, str): return content
    if not isinstance(content, list): return ""
    return "\n".join(str(x.get("text", "")) for x in content if isinstance(x, dict) and x.get("type") == "text")

def short(s, n=180):
    s = re.sub(r"\s+", " ", s or "").strip()
    return s[:n - 1] + "…" if len(s) > n else s

def parse_line(line):
    try: return json.loads(line)
    except (ValueError, UnicodeDecodeError): return None

NOISE = ("caveat: the messages below", "<system-reminder>", "<command-name>", "<local-command-stdout>",
         "<command-message>", "[request interrupted by user", "<environment_context>", "<user_instructions>")

def usable_title(text):
    """First user message that is actually something the person typed."""
    if not text: return ""
    stripped = text.lstrip()
    low = stripped[:60].lower()
    if any(low.startswith(n) for n in NOISE): return ""
    return short(stripped)

def title_of(record):
    # ai-title has varied between a text value and nested message/content.
    for value in (record.get("aiTitle"), record.get("title"), record.get("text"), record.get("value"), record.get("customTitle")):
        if isinstance(value, str) and value.strip(): return value.strip()
    msg = record.get("message", {})
    return text_of(msg.get("content")) if isinstance(msg, dict) else ""

# ------------------------------------------------------------------ summaries

def claude_summary(path):
    stat = path.stat()
    first = last = cwd = branch = sid = title = None
    count = bad = tools = 0
    models = []
    usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
    with path.open("rb") as f:
        for raw in f:
            record = parse_line(raw)
            if not isinstance(record, dict): bad += 1; continue
            typ = record.get("type")
            stamp = record.get("timestamp")
            if stamp and first is None: first = stamp
            if stamp: last = stamp
            cwd = cwd or record.get("cwd")
            branch = branch or record.get("gitBranch")
            sid = sid or record.get("sessionId") or path.stem
            if typ in ("user", "assistant"): count += 1
            if typ == "assistant":
                msg = record.get("message", {})
                u = msg.get("usage", {}) if isinstance(msg, dict) else {}
                usage["input"] += u.get("input_tokens", 0) or 0
                usage["output"] += u.get("output_tokens", 0) or 0
                usage["cacheRead"] += u.get("cache_read_input_tokens", 0) or 0
                usage["cacheWrite"] += u.get("cache_creation_input_tokens", 0) or 0
                model = msg.get("model") if isinstance(msg, dict) else None
                if model and model not in models: models.append(model)
                content = msg.get("content") if isinstance(msg, dict) else None
                if isinstance(content, list):
                    tools += sum(1 for b in content if isinstance(b, dict) and b.get("type") == "tool_use")
            if typ == "user" and not title and not record.get("isMeta"):
                title = usable_title(text_of(record.get("message", {}).get("content"))) or None
            if typ == "ai-title":
                ai_title = title_of(record)
                if ai_title: title = ai_title
    return {"id": "claude:" + (sid or path.stem), "source": "Claude", "file": str(path), "project": path.parent.name,
            "cwd": cwd or "Unknown project", "branch": branch or "", "title": title or "Untitled session",
            "count": count, "tools": tools, "models": models, "start": first, "end": last,
            "size": stat.st_size, "mtime": stat.st_mtime, "malformed": bad, "usage": usage}

def codex_text(content):
    if isinstance(content, str): return content
    if not isinstance(content, list): return ""
    return "\n".join(str(x.get("text", "")) for x in content
                     if isinstance(x, dict) and x.get("type") in ("input_text", "output_text", "text"))

def codex_summary(path):
    stat = path.stat(); sid = path.stem
    cwd = model = first = last = title = None
    count = bad = tools = 0
    usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
    with path.open("rb") as f:
        for raw in f:
            r = parse_line(raw)
            if not isinstance(r, dict): bad += 1; continue
            stamp = r.get("timestamp")
            if stamp and first is None: first = stamp
            if stamp: last = stamp
            p = r.get("payload") if isinstance(r.get("payload"), dict) else {}
            kind = r.get("type")
            if kind == "session_meta":
                cwd = cwd or p.get("cwd"); sid = p.get("session_id") or sid
                model = model or p.get("model")
            elif kind == "turn_context":
                model = model or p.get("model")
            elif kind == "event_msg" and p.get("type") == "token_count":
                total = (p.get("info") or {}).get("total_token_usage") or {}
                if total:
                    usage = {"input": total.get("input_tokens", 0) or 0, "output": total.get("output_tokens", 0) or 0,
                             "cacheRead": total.get("cached_input_tokens", 0) or 0,
                             "cacheWrite": total.get("cache_write_input_tokens", 0) or 0}
            elif kind == "response_item":
                ptype = p.get("type")
                if ptype == "message" and p.get("role") in ("user", "assistant"):
                    count += 1
                    if p.get("role") == "user" and not title:
                        title = usable_title(codex_text(p.get("content"))) or None
                elif ptype in ("function_call", "custom_tool_call", "local_shell_call"):
                    tools += 1
    return {"id": "codex:" + sid, "source": "Codex", "file": str(path), "project": path.parent.name,
            "cwd": cwd or "Unknown project", "branch": "", "title": title or "Untitled Codex session",
            "count": count, "tools": tools, "models": [model] if model else [], "start": first, "end": last,
            "size": stat.st_size, "mtime": stat.st_mtime, "malformed": bad, "usage": usage}

def summarize(path):
    return codex_summary(path) if str(path).startswith(str(CODEX_SESSIONS)) else claude_summary(path)

# ----------------------------------------------------- codex → claude shapes

def codex_tool_args(p):
    raw = p.get("arguments") if p.get("arguments") is not None else p.get("input")
    if isinstance(raw, str):
        try: return json.loads(raw)
        except ValueError: return {"input": raw}
    return raw if isinstance(raw, dict) else {"input": raw}

def normalize_codex(r, session):
    """Reshape a Codex rollout record into the Claude record shape the reader understands."""
    p = r.get("payload") if isinstance(r.get("payload"), dict) else {}
    base = {"timestamp": r.get("timestamp"), "cwd": session.get("cwd"), "sessionId": session["id"], "_raw": r}
    if r.get("type") == "response_item":
        ptype = p.get("type")
        if ptype == "message" and p.get("role") in ("user", "assistant"):
            return {**base, "type": p["role"],
                    "message": {"role": p["role"], "content": [{"type": "text", "text": codex_text(p.get("content"))}]}}
        if ptype in ("function_call", "custom_tool_call", "local_shell_call"):
            return {**base, "type": "assistant", "message": {"role": "assistant", "content": [
                {"type": "tool_use", "id": p.get("call_id") or p.get("id") or "", "name": p.get("name") or ptype,
                 "input": codex_tool_args(p)}]}}
        if ptype in ("function_call_output", "custom_tool_call_output", "local_shell_call_output"):
            out = p.get("output")
            return {**base, "type": "user", "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": p.get("call_id") or p.get("id") or "",
                 "content": codex_text(out) if not isinstance(out, str) else out}]}}
    return {**base, "type": "codex-bookkeeping"}

# ---------------------------------------------------------------------- index

def load_index(force=False):
    global index_data
    with index_lock:
        if index_data and not force and time.time() - index_data.get("built", 0) < INDEX_TTL:
            return index_data
        files = ((list(PROJECTS.rglob("*.jsonl")) if PROJECTS.exists() else []) +
                 (list(CODEX_SESSIONS.rglob("*.jsonl")) if CODEX_SESSIONS.exists() else []))
        cached = {}
        if index_data:
            cached = {x["file"]: x for x in index_data["sessions"]}
        else:
            try:
                saved = json.loads(CACHE.read_text())
                if saved.get("version") == INDEX_VERSION:
                    cached = {x["file"]: x for x in saved.get("sessions", [])}
            except (OSError, ValueError): pass
        sessions = []
        for path in files:
            try: st = path.stat()
            except OSError: continue
            old = cached.get(str(path))
            if old and old.get("mtime") == st.st_mtime and old.get("size") == st.st_size:
                sessions.append(old); continue
            try: sessions.append(summarize(path))
            except OSError: continue
        sessions.sort(key=lambda x: x.get("end") or x.get("start") or "", reverse=True)
        index_data = {"version": INDEX_VERSION, "sessions": sessions, "built": time.time()}
        try:
            CACHE.parent.mkdir(parents=True, exist_ok=True)
            CACHE.write_text(json.dumps(index_data, ensure_ascii=False))
        except OSError: pass
        return index_data

def get_session(sid):
    data = load_index()
    for s in data["sessions"]:
        if s["id"] == sid: return s
    if time.time() - data.get("built", 0) < INDEX_TTL: return None
    for s in load_index(force=True)["sessions"]:   # a brand new session may post-date the cache
        if s["id"] == sid: return s
    return None

# ----------------------------------------------------------------- transcript

def read_page(session, limit=120, byte_offset=None):
    """Read up to `limit` records starting at a byte offset (0 when omitted)."""
    path = session["file"]; is_codex = session.get("source") == "Codex"
    records = []; bad = 0; start = byte_offset or 0; cursor = start; incomplete_final_line = False
    try: total = os.path.getsize(path)
    except OSError: total = 0
    try:
        with open(path, "rb") as f:
            if start: f.seek(start)
            while len(records) < limit:
                pos = f.tell(); raw = f.readline()
                if not raw: break
                # Writers can expose the final JSONL record before its newline
                # has been flushed.  Even valid JSON is held until its newline:
                # otherwise that newline would become a malformed next record.
                if not raw.endswith(b"\n"):
                    cursor = pos
                    incomplete_final_line = True
                    break
                rec = parse_line(raw)
                if not isinstance(rec, dict):
                    bad += 1
                    continue
                if is_codex: rec = normalize_codex(rec, session)
                rec["_offset"] = pos
                records.append(rec)
            if not incomplete_final_line:
                cursor = f.tell()
    except OSError: pass
    return {"records": records, "start": start, "next": cursor if cursor < total and not incomplete_final_line else None,
            "cursor": cursor, "malformed": bad, "size": total}

def offset_before(path, before, limit):
    """Byte offset of the record `limit` lines above `before` — powers 'load earlier'."""
    window = deque(maxlen=limit)
    try:
        with open(path, "rb") as f:
            while True:
                pos = f.tell()
                if pos >= before: break
                if not f.readline(): break
                window.append(pos)
    except OSError: return 0
    return window[0] if window else 0

# -------------------------------------------------------------------- search

def snippet(text, needle, width=220):
    flat = re.sub(r"\s+", " ", text).strip()
    i = flat.lower().find(needle)
    if i < 0: return short(flat, width)
    lead = max(0, i - width // 3)
    piece = flat[lead:lead + width]
    return ("…" if lead else "") + piece + ("…" if lead + width < len(flat) else "")

def record_text(rec, is_codex):
    """(role, text) for a raw record, or None when it holds no prose."""
    if is_codex:
        p = rec.get("payload") if isinstance(rec.get("payload"), dict) else {}
        if rec.get("type") == "response_item" and p.get("type") == "message" and p.get("role") in ("user", "assistant"):
            return p["role"], codex_text(p.get("content"))
        return None
    typ = rec.get("type")
    if typ not in ("user", "assistant"): return None
    msg = rec.get("message")
    return (typ, text_of(msg.get("content"))) if isinstance(msg, dict) else None

def search(needle, role="any", limit=SEARCH_CAP):
    """Substring search across every indexed transcript, newest session first."""
    lower = needle.lower()
    probe = lower.encode() if lower.isascii() and '"' not in lower and "\\" not in lower else None
    groups = []; total = 0
    for s in load_index()["sessions"]:
        if total >= limit: break
        is_codex = s.get("source") == "Codex"
        hits = []
        try:
            with open(s["file"], "rb") as f:
                while total + len(hits) < limit:
                    pos = f.tell(); raw = f.readline()
                    if not raw: break
                    if probe is not None and probe not in raw.lower(): continue
                    rec = parse_line(raw)
                    if not isinstance(rec, dict): continue
                    found = record_text(rec, is_codex)
                    if not found: continue
                    who, value = found
                    if role != "any" and who != role: continue
                    if lower in value.lower():
                        hits.append({"role": who, "offset": pos, "timestamp": rec.get("timestamp"),
                                     "text": snippet(value, lower)})
        except OSError: continue
        if hits:
            total += len(hits)
            groups.append({"id": s["id"], "title": s["title"], "cwd": s["cwd"], "source": s.get("source", "Claude"),
                           "start": s.get("start"), "hits": hits})
    return {"groups": groups, "total": total, "capped": total >= limit}

# -------------------------------------------------------------------- export

def export_markdown(session, write):
    is_codex = session.get("source") == "Codex"
    head = [f"# {session['title']}", "", f"- Source: {session.get('source', 'Claude')}",
            f"- Project: {session['cwd']}"]
    if session.get("branch"): head.append(f"- Branch: {session['branch']}")
    if session.get("start"): head.append(f"- Started: {session['start']}")
    if session.get("models"): head.append(f"- Model: {', '.join(session['models'])}")
    write("\n".join(head) + "\n")
    with open(session["file"], "rb") as f:
        for raw in f:
            rec = parse_line(raw)
            if not isinstance(rec, dict): continue
            if is_codex: rec = normalize_codex(rec, session)
            if rec.get("type") not in ("user", "assistant"): continue
            content = rec.get("message", {}).get("content")
            body = text_of(content)
            if rec["type"] == "user" and (not body or any(n in body.lower()[:60] for n in NOISE)): continue
            if body:
                write("\n\n## " + ("You" if rec["type"] == "user" else "Assistant") + "\n\n" + body)
            if rec["type"] == "assistant" and isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_use":
                        args = json.dumps(block.get("input", {}), ensure_ascii=False, indent=2)
                        write(f"\n\n<details><summary>Tool: <code>{block.get('name', 'tool')}</code></summary>\n\n"
                              f"```json\n{args}\n```\n\n</details>")
    write("\n")

# --------------------------------------------------------------------- share

def lan_address():
    """This machine's address on the local network, or None when offline.

    Connecting a UDP socket only asks the routing table which interface would be
    used; no packet is sent and nothing leaves the machine.
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.0.2.1", 9))          # TEST-NET-1, reserved and unroutable
        address = probe.getsockname()[0]
    except OSError:
        return None
    finally:
        probe.close()
    return None if address.startswith("127.") else address

def share_state():
    return {"enabled": share["server"] is not None, "url": share["url"],
            "port": LAN_PORT, "error": share["error"],
            "qr": qr.svg(share["url"]) if share["url"] else None}

def start_sharing():
    with share_lock:
        if share["server"]: return share_state()
        share["error"] = None
        address = lan_address()
        if not address:
            share["error"] = "This machine has no local network address right now."
            return share_state()
        try:
            server = ThreadingHTTPServer(("0.0.0.0", LAN_PORT), Handler)
        except OSError as exc:
            share["error"] = f"Could not open port {LAN_PORT}: {exc}"
            return share_state()
        server.lan = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        share.update(server=server, thread=thread, url=f"http://{address}:{LAN_PORT}/?k={share['key']}")
        return share_state()

def stop_sharing():
    with share_lock:
        server = share["server"]
        if server:
            server.shutdown()
            server.server_close()
        share.update(server=None, thread=None, url=None, error=None)
        return share_state()

# -------------------------------------------------------------------- server

class Handler(SimpleHTTPRequestHandler):
    server_version = "SessionViewer"

    def log_message(self, fmt, *args): pass

    @property
    def shared(self):
        return getattr(self.server, "lan", False)

    def permitted(self):
        """Loopback is trusted; the LAN listener needs the key from the QR code."""
        if not self.shared: return True
        key = share["key"]
        if parse_qs(urlparse(self.path).query).get("k", [""])[0] == key:
            self.grant_cookie = True
            return True
        return f"viewer_key={key}" in (self.headers.get("Cookie") or "")

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        # Without this the browser caches app.css/app.js heuristically and an edit
        # needs a hard reload to show up. "no-cache" still allows a cheap 304.
        if not getattr(self, "cached", False):
            self.send_header("Cache-Control", "no-cache")
        if getattr(self, "grant_cookie", False):
            self.send_header("Set-Cookie", f"viewer_key={share['key']}; Path=/; SameSite=Lax; Max-Age=86400")
        super().end_headers()

    def deny(self):
        body = (b"<!doctype html><meta charset=utf-8><title>Session Viewer</title>"
                b"<body style='font:16px system-ui;padding:3rem;max-width:32rem'>"
                b"<h1>Not your link</h1><p>This viewer only answers requests that carry the key "
                b"from the QR code shown on the host machine.</p>")
        self.send_response(403)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def json(self, value, status=200):
        payload = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.cached = True
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def arg(self, q, name, default=None, cast=str, lo=None, hi=None):
        try: value = cast(q[name][0])
        except (KeyError, IndexError, TypeError, ValueError): return default
        if lo is not None: value = max(lo, value)
        if hi is not None: value = min(hi, value)
        return value

    def session_or_404(self, q):
        s = get_session(self.arg(q, "id", ""))
        if not s: self.json({"error": "Session not found"}, 404)
        return s

    def do_POST(self):
        if self.shared: return self.deny()   # sharing is controlled from the host only
        parsed = urlparse(self.path); path = parsed.path; q = parse_qs(parsed.query)
        if is_demo(q) and path == "/api/share/start": return self.json({"enabled": True, "url": "http://192.168.1.12:8788/?k=demo-key", "port": LAN_PORT, "error": None, "qr": qr.svg("http://192.168.1.12:8788/?k=demo-key")})
        if is_demo(q) and path == "/api/share/stop": return self.json({"enabled": False, "url": None, "error": None, "qr": None})
        if path == "/api/share/start": return self.json(start_sharing())
        if path == "/api/share/stop": return self.json(stop_sharing())
        return self.json({"error": "Unknown endpoint"}, 404)

    def do_GET(self):
        if not self.permitted(): return self.deny()
        parsed = urlparse(self.path); q = parse_qs(parsed.query)
        route = getattr(self, "api_" + parsed.path[5:].replace("-", "_"), None) if parsed.path.startswith("/api/") else None
        try:
            if parsed.path.startswith("/api/"):
                if route is None: return self.json({"error": "Unknown endpoint"}, 404)
                return route(q)
            name = STATIC.get(parsed.path)
            if not name: return self.send_error(404, "Not found")
            self.path = "/" + name
            return super().do_GET()
        except BrokenPipeError:
            pass
        except Exception as exc:                      # never take the server down for one bad request
            try: self.json({"error": f"{type(exc).__name__}: {exc}"}, 500)
            except Exception: pass

    def do_HEAD(self):
        if not self.permitted(): return self.deny()
        name = STATIC.get(urlparse(self.path).path)
        if not name: return self.send_error(404, "Not found")
        self.path = "/" + name
        return super().do_HEAD()

    def api_share(self, q):
        if is_demo(q): return self.json({"enabled": False, "url": None, "port": LAN_PORT, "error": None, "qr": None})
        # A phone reading over the LAN gets no sharing controls of its own.
        if self.shared: return self.json({"enabled": True, "remote": True, "url": None, "qr": None, "error": None})
        return self.json(share_state())

    def api_index(self, q):
        if is_demo(q): return self.json({"version": INDEX_VERSION, "sessions": DEMO_SESSIONS, "built": time.time()})
        return self.json(load_index(force=self.arg(q, "refresh") == "1"))

    def api_session(self, q):
        if is_demo(q):
            session = next((s for s in DEMO_SESSIONS if s["id"] == self.arg(q, "id", "")), None)
            if not session: return self.json({"error": "Session not found"}, 404)
            return self.json({"session": session, "records": DEMO_RECORDS, "start": 0, "next": None, "cursor": 2100, "malformed": 0, "size": 2100})
        s = self.session_or_404(q)
        if not s: return
        limit = self.arg(q, "limit", 120, int, 1, PAGE_MAX)
        before = self.arg(q, "before", None, int, 0)
        offset = self.arg(q, "offset", None, int, 0)
        if before is not None: offset = offset_before(s["file"], before, limit)
        return self.json({"session": s, **read_page(s, limit=limit, byte_offset=offset)})

    def api_tail(self, q):
        if is_demo(q): return self.json({"records": [], "start": 2100, "next": None, "cursor": 2100, "malformed": 0, "size": 2100})
        s = self.session_or_404(q)
        if not s: return
        return self.json(read_page(s, limit=PAGE_MAX, byte_offset=self.arg(q, "offset", 0, int, 0)))

    def api_search(self, q):
        if is_demo(q): return self.json({"groups": [{"id":"demo:pricing","title":"Build a pricing model","cwd":"/work/forecasting","source":"Codex","start":"2026-09-09T07:12:00Z","hits":[{"role":"assistant","offset":420,"timestamp":"2026-09-09T07:14:00Z","text":"…show the break-even point. At the middle tier, support costs are covered…"}]}],"total":1,"capped":False})
        needle = self.arg(q, "q", "").strip()
        if len(needle) < 2: return self.json({"groups": [], "total": 0, "capped": False})
        role = self.arg(q, "role", "any")
        return self.json(search(needle, role if role in ("user", "assistant") else "any"))

    def api_export(self, q):
        s = self.session_or_404(q)
        if not s: return
        filename = re.sub(r"[^A-Za-z0-9._-]", "_", s["title"])[:70].strip("_") or s["id"].replace(":", "-")
        self.send_response(200)
        self.send_header("Content-Type", "text/markdown; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}.md"')
        self.end_headers()
        try: export_markdown(s, lambda text: self.wfile.write(text.encode("utf-8")))
        except (OSError, BrokenPipeError): pass

if __name__ == "__main__":
    os.chdir(ROOT)
    print(f"Session Viewer → http://127.0.0.1:{PORT}", flush=True)
    if "--lan" in sys.argv:
        state = start_sharing()
        if state["url"]:
            print(f"\nOn this network → {state['url']}\n", flush=True)
            print(qr.text_art(state["url"]), flush=True)
        else:
            print("Sharing unavailable:", state["error"], flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
