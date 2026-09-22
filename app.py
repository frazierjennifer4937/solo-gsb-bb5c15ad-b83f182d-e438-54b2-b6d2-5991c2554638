#!/usr/bin/env python3
"""配置变更回放台 (Config Change Replay Station)

用户为命名资源提交带版本号的变更事件，系统按资源串联事件、
检测版本冲突，并提供回放数据与 JSON 导出。
"""
import json
import os
import sqlite3
from datetime import datetime, timezone

from flask import Flask, Response, g, jsonify, render_template, request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH", os.path.join(BASE_DIR, "data", "replay.db"))
PORT = int(os.environ.get("PORT", "8000"))
SEED_DEMO = os.environ.get("SEED_DEMO", "1") != "0"

app = Flask(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    resource   TEXT NOT NULL,
    version    INTEGER NOT NULL,
    author     TEXT NOT NULL DEFAULT '',
    message    TEXT NOT NULL DEFAULT '',
    payload    TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_resource ON events (resource);
"""

# (resource, version, author, message, payload, created_at)
SEED_EVENTS = [
    ("payment-service", 1, "alice", "初始化支付服务配置",
     {"replicas": 2, "image": "pay:1.4.0", "env": {"TIMEOUT": "3s"}},
     "2026-09-20T09:00:00+00:00"),
    ("payment-service", 2, "bob", "扩容到 3 副本并放宽超时",
     {"replicas": 3, "env": {"TIMEOUT": "5s"}},
     "2026-09-20T09:20:00+00:00"),
    ("payment-service", 2, "carol", "开启灰度（与 bob 的 v2 撞车）",
     {"replicas": 4, "canary": {"enabled": True}},
     "2026-09-20T09:35:00+00:00"),
    ("payment-service", 3, "bob", "升级镜像到 1.5.0",
     {"image": "pay:1.5.0"},
     "2026-09-20T10:05:00+00:00"),
    ("payment-service", 7, "alice", "调整连接池上限（跳过了 v4~v6）",
     {"env": {"MAX_CONN": "200"}},
     "2026-09-20T10:40:00+00:00"),
    ("gateway", 1, "alice", "初始化网关路由",
     {"routes": {"/api": "backend"}, "tls": True},
     "2026-09-20T08:30:00+00:00"),
    ("gateway", 2, "dave", "新增管理后台路由",
     {"routes": {"/admin": "console"}},
     "2026-09-20T11:00:00+00:00"),
    ("gateway", 3, "dave", "开启限流",
     {"rate_limit": {"rps": 500}},
     "2026-09-20T11:30:00+00:00"),
    ("search-api", 1, "eve", "切换到 products-v8 索引",
     {"index": "products-v8", "shards": 3},
     "2026-09-21T09:00:00+00:00"),
    ("search-api", 1, "frank", "误用相同版本号提交 v9 索引",
     {"index": "products-v9", "shards": 6},
     "2026-09-21T09:15:00+00:00"),
]


# ---------------------------------------------------------------- 数据库

def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    """启动时初始化数据库；空库且 SEED_DEMO=1 时写入示例数据。"""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    if SEED_DEMO:
        empty = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 0
        if empty:
            conn.executemany(
                "INSERT INTO events (resource, version, author, message, payload, created_at)"
                " VALUES (?,?,?,?,?,?)",
                [(r, v, a, m, json.dumps(p, ensure_ascii=False), t)
                 for r, v, a, m, p, t in SEED_EVENTS],
            )
    conn.commit()
    conn.close()


# ------------------------------------------------------------ 冲突检测

def row_to_event(row):
    try:
        payload = json.loads(row["payload"])
    except (ValueError, TypeError):
        payload = {}
    return {
        "id": row["id"],
        "resource": row["resource"],
        "version": row["version"],
        "author": row["author"],
        "message": row["message"],
        "payload": payload,
        "created_at": row["created_at"],
    }


def annotate_conflicts(events):
    """按资源分组、按提交顺序扫描，给每个事件就地加上 conflicts 列表。

    冲突规则（针对同一资源）：
      - duplicate_version  版本重复：该版本号已被更早的事件使用
      - version_regression 版本回退：版本号小于等于已出现的最大版本
      - version_gap        版本跳变：版本号比当前最大版本高出 2 及以上
    """
    state = {}  # resource -> {"seen": {version: event_id}, "max": int}
    for e in sorted(events, key=lambda x: (x["created_at"], x["id"])):
        st = state.setdefault(e["resource"], {"seen": {}, "max": 0})
        v = e["version"]
        conflicts = []
        if v in st["seen"]:
            conflicts.append({
                "type": "duplicate_version",
                "label": "版本重复",
                "detail": f"版本 v{v} 已由事件 #{st['seen'][v]} 使用",
            })
        elif v <= st["max"]:
            conflicts.append({
                "type": "version_regression",
                "label": "版本回退",
                "detail": f"版本 v{v} 不晚于当前最大版本 v{st['max']}",
            })
        elif st["max"] > 0 and v > st["max"] + 1:
            conflicts.append({
                "type": "version_gap",
                "label": "版本跳变",
                "detail": f"从 v{st['max']} 直接跳到 v{v}，中间版本缺失",
            })
        st["seen"].setdefault(v, e["id"])
        st["max"] = max(st["max"], v)
        e["conflicts"] = conflicts
    return events


def fetch_events(resource=None):
    db = get_db()
    if resource:
        rows = db.execute(
            "SELECT * FROM events WHERE resource = ? ORDER BY created_at, id",
            (resource,),
        ).fetchall()
    else:
        rows = db.execute("SELECT * FROM events ORDER BY created_at, id").fetchall()
    return [row_to_event(r) for r in rows]


# ---------------------------------------------------------------- 路由

@app.route("/")
def index():
    return render_template("index.html")


@app.get("/api/health")
def health():
    return jsonify({"status": "ok", "time": now_iso()})


@app.get("/api/resources")
def list_resources():
    """资源列表及统计（事件数 / 冲突数 / 最大版本）。"""
    stats = {}
    for e in annotate_conflicts(fetch_events()):
        s = stats.setdefault(e["resource"], {
            "resource": e["resource"],
            "event_count": 0,
            "conflict_count": 0,
            "max_version": 0,
            "first_at": e["created_at"],
            "last_at": e["created_at"],
        })
        s["event_count"] += 1
        s["max_version"] = max(s["max_version"], e["version"])
        s["last_at"] = e["created_at"]
        if e["conflicts"]:
            s["conflict_count"] += 1
    return jsonify(sorted(stats.values(), key=lambda s: s["resource"]))


@app.get("/api/events")
def list_events():
    """事件列表，可用 ?resource=<name> 过滤；每个事件带 conflicts 标记。"""
    resource = request.args.get("resource") or None
    return jsonify(annotate_conflicts(fetch_events(resource)))


@app.post("/api/events")
def create_event():
    data = request.get_json(silent=True) or {}
    resource = str(data.get("resource") or "").strip()
    author = str(data.get("author") or "").strip()
    message = str(data.get("message") or "").strip()
    payload = data.get("payload", {})

    errors = []
    if not resource:
        errors.append("resource（资源名称）不能为空")
    try:
        version = int(data.get("version"))
        if version < 1:
            raise ValueError
    except (TypeError, ValueError):
        version = None
        errors.append("version（版本号）必须是 >= 1 的整数")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload) if payload.strip() else {}
        except ValueError:
            payload = None
            errors.append("payload 不是合法的 JSON")
    if payload is not None and not isinstance(payload, dict):
        errors.append("payload 必须是 JSON 对象")
        payload = None
    if errors:
        return jsonify({"errors": errors}), 400

    db = get_db()
    cur = db.execute(
        "INSERT INTO events (resource, version, author, message, payload, created_at)"
        " VALUES (?,?,?,?,?,?)",
        (resource, version, author, message,
         json.dumps(payload, ensure_ascii=False), now_iso()),
    )
    db.commit()
    # 返回该资源全量事件（含冲突标记），前端据此提示新事件是否引发冲突
    events = annotate_conflicts(fetch_events(resource))
    created = next(e for e in events if e["id"] == cur.lastrowid)
    return jsonify(created), 201


@app.get("/api/export")
def export_events():
    """把当前筛选结果导出为 JSON 文件下载。"""
    resource = request.args.get("resource") or None
    events = annotate_conflicts(fetch_events(resource))
    doc = {
        "exported_at": now_iso(),
        "filter": {"resource": resource or "*"},
        "event_count": len(events),
        "events": events,
    }
    filename = f"events-{resource or 'all'}.json"
    return Response(
        json.dumps(doc, ensure_ascii=False, indent=2),
        mimetype="application/json; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/seed")
def seed_demo():
    """清空并重新写入示例数据（演示用）。"""
    db = get_db()
    db.execute("DELETE FROM events")
    db.executemany(
        "INSERT INTO events (resource, version, author, message, payload, created_at)"
        " VALUES (?,?,?,?,?,?)",
        [(r, v, a, m, json.dumps(p, ensure_ascii=False), t)
         for r, v, a, m, p, t in SEED_EVENTS],
    )
    db.commit()
    return jsonify({"inserted": len(SEED_EVENTS)})


@app.post("/api/reset")
def reset_all():
    db = get_db()
    db.execute("DELETE FROM events")
    db.commit()
    return jsonify({"deleted": True})


# ---------------------------------------------------------------- 启动

init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
