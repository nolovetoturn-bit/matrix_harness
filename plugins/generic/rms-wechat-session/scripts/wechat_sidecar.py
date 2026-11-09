#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
rms-wechat-session 边车采集器（Python 侧）。

职责：用 wechatauto-replica 解密读取微信 4.x 本地 SQLCipher 数据库，
把会话与消息归一化成 JSON / NDJSON 落盘，供 Node 侧的 dsh 插件（零依赖）调用。

契约：**只从 stdin 读一个 JSON 载荷，只向 stdout 写一个 JSON 文档**；
所有诊断信息走 stderr。故调用方（plugin.mjs）不需要处理任何命令行引号问题。

子命令：
  doctor    体检：微信进程 / 本机账号 / 数据库密钥可用性 / 会话数
  sessions  列出会话（含未读、摘要、最近时间）
  fetch     执行一轮增量采集，落盘 NDJSON，更新游标
  backfill  全量历史回溯：逐会话从最新翻到最老导出 NDJSON，可一并下载媒体
  send      发送消息（文本 / 图片 / 文件）——**UI 自动化**路线，会真实占用鼠标键盘
  config    读取或写入边车配置（数据目录 / 每会话条数 / 会话上限 / 动态同步参数）
  sync_scan 扫描可同步会话：返回会话全集，并标注消息免打扰 / 公众号 / 手动排除

依赖：wechatauto-replica（仅在专用 venv 内）。本文件不属于 dsh 插件零依赖约束范围。
"""

import datetime
import json
import os
import sys
import time
import traceback

APP_NAME = "rms-wechat-session"

# 默认锁定的微信账号（= <xwechat_files>\<account> 的目录名）。
# 多账号机器上库自带的「按库文件时间自动挑账号」会漂移，可能读到不是当前收发消息的账号，
# 因此这里显式锁定；可用 payload.account / config.account 覆盖。
DEFAULT_ACCOUNT = "BurstM_792c"

DEFAULTS = {
    "account": DEFAULT_ACCOUNT, # 读库账号（xwechat_files 下的目录名）
    "data_dir": None,          # None => <LOCALAPPDATA>/rms-wechat-session/data
    "limit_per_chat": 200,     # 增量模式：首次采集每个会话最多回溯多少条
    "max_chats": 0,            # 0 = 全部会话
    "chats": [],               # 非空则只采集这些会话（username / 昵称 / 备注）
    "skip_chats": [],          # 非空则跳过这些会话（username / 昵称 / 备注）
    "content_max_chars": 4000, # 单条 content 落盘时的截断上限
    "download_media": True,    # 回溯模式：是否一并下载图片/语音/视频/文件
    # ---- 动态同步（调度器在 Node 侧，参数在这里持久化） ----
    "sync_enabled": True,       # 是否随插件启动自动同步
    "sync_accounts": [],        # 要同步的账号目录列表；空 = 自动发现本机全部账号（多开时逐个同步）
    "sync_tick_seconds": 60,    # 调度器 tick（检查谁到期）
    "sync_scan_seconds": 300,   # 重新扫描会话全集 / 免打扰状态的间隔
    "sync_base_interval": 3600, # 无交互时的基准同步间隔（秒）
    "sync_min_interval": 120,   # 最活跃会话的下限间隔（秒）
    "sync_max_interval": 7200,  # 长期无新消息的上限间隔（秒）
    "sync_half_life": 10800,    # 活跃度分数的半衰期（秒，默认 3 小时）
    "sync_activity_window": 3600, # 只有最近这么久的消息才计入「交互活跃度」
    "sync_max_per_tick": 20,    # 单次 tick 最多同步多少个会话
    "sync_skip_muted": True,    # 跳过「消息免打扰」的群（游标不推进）
    "sync_include_service": False, # 是否把公众号/服务号也纳入同步
    "muted_chats": [],          # 手动追加的不参与同步的会话（username / 名称）
}

# 回溯模式下会尝试下载媒体的消息类型（其余类型只记元信息）。
MEDIA_TYPES = ("图片", "语音", "视频", "文件")


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #

def app_dir():
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    d = os.path.join(base, APP_NAME)
    os.makedirs(d, exist_ok=True)
    return d


def config_path():
    return os.path.join(app_dir(), "config.json")


def account_dir():
    """当前读库账号专属的数据目录：<data_dir>/<account>。

    两个账号的产物必须物理隔离：混放在同一个 backfill 目录里，同名会话会因
    「已存在即跳过」被错误跳过；游标也会对错库（A 账号的 sort_seq 用到 B 账号上）。
    """
    d = os.path.join(load_config()["data_dir"], _ACCOUNT)
    os.makedirs(d, exist_ok=True)
    return d


def cursor_path():
    return os.path.join(account_dir(), "cursor.json")


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def load_config():
    cfg = dict(DEFAULTS)
    cfg.update(load_json(config_path(), {}) or {})
    if not cfg.get("data_dir"):
        cfg["data_dir"] = os.path.join(app_dir(), "data")
    return cfg


def weixin_pids():
    try:
        import psutil
    except Exception:
        return []
    pids = []
    for p in psutil.process_iter(["pid", "name"]):
        try:
            if (p.info.get("name") or "").lower() == "weixin.exe":
                pids.append(p.info["pid"])
        except Exception:
            continue
    return pids


_ACCOUNT = DEFAULT_ACCOUNT  # 由 main() 依 payload.account / config.account 覆盖


def open_db():
    """构造 WeChatDB。密钥来自对 Weixin.exe 进程内存的只读扫描（微信必须处于登录态）。

    账号锁定 `_ACCOUNT`（不再用库的自动选择，多账号机器上那个选择会漂移）。
    """
    from wechatauto import WeChatDB
    return WeChatDB(account=_ACCOUNT)


def iso(ts):
    try:
        return datetime.datetime.fromtimestamp(int(ts)).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return ""


def resolve_chats(db, nickmap, chats_filter):
    """
    把用户给的会话标识（username / 昵称 / 备注）解析成会话条目列表。

    关键：**不能靠 get_sessions() 的返回集来过滤会话**。实测同一接口在不同 limit /
    不同时刻返回的会话集不一致（有时 260 条、有时 484 条，且不保证含全部会话），
    拿它做白名单过滤会把真实存在的会话漏掉。故 get_sessions() 本函数里只用来
    「查名字」；命中不了的标识**原样当作 username 交给 export_history / get_messages**
    （这两个接口接受任意 username，不要求该会话出现在当前会话列表里）。
    """
    sessions = []
    try:
        sessions = db.get_sessions(limit=2000) or []
    except Exception as e:
        sys.stderr.write("get_sessions failed: %s: %s\n" % (type(e).__name__, e))

    index = {}
    for s in sessions:
        u = s.get("username", "")
        if not u:
            continue
        index.setdefault(u, u)
        nm = nickmap.get(u, "")
        if nm:
            index.setdefault(nm, u)
    for u, nm in (nickmap or {}).items():
        if nm:
            index.setdefault(nm, u)

    out = []
    seen = set()
    for entry in chats_filter:
        key = str(entry).strip()
        if not key:
            continue
        u = index.get(key, key)
        if u in seen:
            continue
        seen.add(u)
        out.append({"username": u, "name": nickmap.get(u, "") or key})
    return out


def enum_chats(db, nickmap):
    """
    枚举「确实存有消息」的全部会话。

    用 list_message_chats()——它直接扫全部分片库里的 Msg_<md5> 表再反查用户名，
    结果集稳定且完整；而 get_sessions() 实测结果集不稳定（同一 limit 不同时刻
    返回 260 / 484 条不等），拿它枚举会漏会话。故只在它失败时兜底。
    """
    try:
        rows = db.list_message_chats() or []
        return [{"username": r.get("username", ""),
                 "name": r.get("name") or nickmap.get(r.get("username", ""), "") or r.get("username", ""),
                 "message_count": r.get("message_count")}
                for r in rows if r.get("username")]
    except Exception as e:
        sys.stderr.write("list_message_chats failed: %s: %s\n" % (type(e).__name__, e))
    sessions = db.get_sessions(limit=2000) or []
    for s in sessions:
        u = s.get("username", "")
        s["name"] = nickmap.get(u, "") or u
    return sessions


def muted_chat_map(db):
    """读取「消息免打扰」的**群聊**集合：``{username: True}``。

    字段是 contact.db 的 ``contact.chat_room_notify``，实测语义：
      · 群聊：``0`` = 消息免打扰，``1`` = 正常提醒；
      · 单聊：该字段恒为 0，**不能**据此判断单聊是否免打扰。
    故本函数只返回 ``@chatroom`` 的会话，单聊一律不标记（调度器也不据它跳单聊）。
    """
    out = {}
    conn = None
    try:
        conn = db._contact_conn()
        if conn is None:
            return out
        rows = conn.execute(
            "SELECT username, chat_room_notify FROM contact "
            "WHERE username LIKE '%@chatroom'").fetchall()
        for r in rows:
            u = r["username"]
            if not u:
                continue
            if int(r["chat_room_notify"] or 0) == 0:
                out[u] = True
    except Exception as e:
        sys.stderr.write("muted_chat_map failed: %s: %s\n" % (type(e).__name__, e))
    finally:
        try:
            if conn is not None:
                conn.close()
        except Exception:
            pass
    return out


def strip_group_prefix(content, chat_username):
    """群聊正文形如 'wxid_xxx:\\n实际内容'，剥掉发送者前缀，返回 (正文, 前缀)。"""
    if not content or not isinstance(content, str):
        return content, ""
    if chat_username.endswith("@chatroom") and "\n" in content:
        head, _, tail = content.partition("\n")
        if head and "\n" not in head and len(head) <= 64 and ("@" in head or head.startswith("wxid_")):
            return tail, head
    return content, ""


def normalize_message(chat, msg, nickmap, content_max):
    """把库里的原始消息行归一化成稳定字段集合。"""
    chat_username = chat.get("username", "")
    msg_type = msg.get("type") or ""
    content = msg.get("content") or ""

    body, prefix = strip_group_prefix(content, chat_username)
    sender_username = msg.get("sender_username") or prefix or ""

    if msg_type in ("文本", "Text"):
        text = body
    elif msg_type:
        text = "[%s]" % msg_type
    else:
        text = ""

    raw = content if isinstance(content, str) else ""
    truncated = len(raw) > content_max

    return {
        "chat_username": chat_username,
        "chat_name": chat.get("name") or nickmap.get(chat_username, "") or chat_username,
        "shard": msg.get("shard"),
        "local_id": msg.get("local_id"),
        "sort_seq": msg.get("sort_seq"),
        "type": msg_type,
        "sender_username": sender_username,
        "sender_name": nickmap.get(sender_username, "") or sender_username,
        "create_time": msg.get("create_time"),
        "datetime": iso(msg.get("create_time")),
        "text": text,
        "content": raw[:content_max],
        "content_truncated": truncated,
    }


# --------------------------------------------------------------------------- #
# 子命令
# --------------------------------------------------------------------------- #

def cmd_doctor(payload):
    cfg = load_config()
    out = {
        "python": sys.executable,
        "python_version": sys.version.split()[0],
        "wechat_process_pids": weixin_pids(),
        "config": cfg,
        "config_path": config_path(),
        "account": _ACCOUNT,
        "account_dir": account_dir(),
        "cursor_path": cursor_path(),
        "account_dirs": account_dir_names(),
    }
    try:
        out["instances"] = list_instances()
    except Exception as e:
        out["instances"] = []
        out["instances_error"] = "%s: %s" % (type(e).__name__, e)
    out["wechat_running"] = bool(out["wechat_process_pids"])
    try:
        from wechatauto import __version__ as libver
    except Exception:
        libver = "unknown"
    out["wechatauto_version"] = libver

    try:
        db = open_db()
        out["self"] = db.get_self_info()
        out["db_key_ok"] = True
    except Exception as e:
        out["db_key_ok"] = False
        out["error"] = "%s: %s" % (type(e).__name__, e)
        out["ok"] = False
        return out

    try:
        sessions = db.get_sessions(limit=2000)
        out["session_count"] = len(sessions)
    except Exception as e:
        out["session_count"] = None
        out["sessions_error"] = "%s: %s" % (type(e).__name__, e)

    out["ok"] = True
    return out


def cmd_sessions(payload):
    cfg = load_config()
    limit = int(payload.get("limit") or 50)
    db = open_db()
    sessions = db.get_sessions(limit=max(limit, 1))
    nickmap = {}
    try:
        nickmap = db.nickname_map() or {}
    except Exception:
        pass

    rows = []
    try:
        muted = muted_chat_map(db)
    except Exception:
        muted = {}
    for s in sessions[:limit]:
        u = s.get("username", "")
        rows.append({
            "username": u,
            "name": nickmap.get(u, "") or u,
            "unread": s.get("unread", 0),
            "last_time": s.get("last_time"),
            "last_datetime": iso(s.get("last_time")),
            "last_sender": s.get("last_sender", ""),
            "summary": s.get("summary", ""),
            "muted": bool(muted.get(u)),
        })
    return {"ok": True, "count": len(rows), "total_listed": len(sessions), "sessions": rows}


def cmd_fetch(payload):
    cfg = load_config()
    limit_per_chat = int(payload.get("limit_per_chat") or cfg["limit_per_chat"])
    max_chats = int(payload.get("max_chats") or cfg["max_chats"])
    chats_filter = payload.get("chats") or cfg.get("chats") or []
    content_max = int(cfg.get("content_max_chars") or 4000)
    activity_since = int(payload.get("activity_since") or 0)  # 0 = 不做时间过滤
    out_dir = account_dir()  # 按账号隔离产物

    db = open_db()
    nickmap = {}
    try:
        nickmap = db.nickname_map() or {}
    except Exception:
        pass

    if chats_filter:
        sessions = resolve_chats(db, nickmap, chats_filter)
    else:
        sessions = enum_chats(db, nickmap)
    skip_filter = payload.get("skip_chats") or cfg.get("skip_chats") or []
    if skip_filter:
        skip_users = {s["username"] for s in resolve_chats(db, nickmap, skip_filter)}
        sessions = [s for s in sessions if s["username"] not in skip_users]
    if max_chats and len(sessions) > max_chats:
        sessions = sessions[:max_chats]

    cursor = load_json(cursor_path(), {}) or {}
    run_date = datetime.datetime.now().strftime("%Y%m%d")
    out_file = os.path.join(out_dir, "rms-wechat-%s.ndjson" % run_date)

    try:
        self_wxid = db.wxid or ""
    except Exception:
        self_wxid = ""

    stats = {
        "ok": True,
        "chats_total": len(sessions),
        "chats_read": 0,
        "messages_new": 0,
        "errors": [],
    }
    per_chat = []

    written = 0
    with open(out_file, "a", encoding="utf-8") as f:
        for s in sessions:
            u = s["username"]
            since = int(cursor.get(u, 0) or 0)
            try:
                if since:
                    msgs = db.get_new_messages(u, since)
                else:
                    msgs = db.get_messages(u, limit=limit_per_chat)
            except Exception as e:
                err = "%s: %s" % (type(e).__name__, e)
                stats["errors"].append({"chat": s["name"], "error": err})
                per_chat.append({
                    "chat": s["name"], "username": u, "new": 0,
                    "self_new": 0, "in_new": 0, "since": since, "now": since,
                    "error": err,
                })
                continue

            msgs = [m for m in (msgs or []) if (m.get("sort_seq") or 0) > since]
            msgs.sort(key=lambda m: m.get("sort_seq") or 0)

            fresh = 0
            self_new = 0
            in_new = 0
            max_seq = since
            seen = set()
            for m in msgs:
                key = (m.get("shard"), m.get("local_id"))
                if key in seen:
                    continue
                seen.add(key)
                rec = normalize_message(s, m, nickmap, content_max)
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                written += 1
                fresh += 1
                # 活跃度只统计「最近」的消息：首次采集的几百条历史不该把会话钉在最短间隔。
                created = int(m.get("create_time") or 0)
                recent = activity_since <= 0 or created >= activity_since
                sender = rec.get("sender_username") or ""
                # 自己发的消息：群聊里没有发送者前缀、单聊里 sender 为空或等于本账号 wxid。
                if recent:
                    if not sender or (self_wxid and sender == self_wxid):
                        self_new += 1
                    else:
                        in_new += 1
                max_seq = max(max_seq, m.get("sort_seq") or 0)

            if max_seq > since:
                cursor[u] = max_seq
            stats["chats_read"] += 1
            stats["messages_new"] += fresh
            # 所有处理过的会话都返回（含 0 条新消息），供调度器更新活跃度 / 下次到期时间。
            per_chat.append({
                "chat": s["name"], "username": u, "new": fresh,
                "self_new": self_new, "in_new": in_new,
                "since": since, "now": max_seq,
            })

    save_json(cursor_path(), cursor)

    stats["written"] = written
    stats["output_file"] = out_file
    stats["self_username"] = self_wxid
    per_chat.sort(key=lambda r: r["new"], reverse=True)
    stats["per_chat"] = per_chat
    stats["per_chat_top"] = per_chat[:20]
    if len(stats["errors"]) > 20:
        stats["errors"] = stats["errors"][:20]
    return stats


SERVICE_SESSION_IDS = {
    "newsapp", "notifymessage", "brandservicesessionholder", "brandsessionholder",
    "officialaccounts", "weixin", "qqmail", "qqsafe", "jinsuiqqcard", "weixinpay",
    "tenpay", "mphelper", "fmessage", "floatbottle", "medianote", "tmessage",
    "blogapp", "weapp", "weibo", "shake",
}
SERVICE_SESSION_SUFFIXES = ("@app", "@openim")


def is_service_chat(username):
    """判断会话是否公众号 / 服务号 / 系统通知（非真人会话）。

    微信里这类会话的 username 有稳定特征：``gh_`` 前缀（公众号）、``@app`` / ``@openim``
    后缀（小程序、应用消息、企业微信客服会话），或若干固定的系统 id（服务通知、
    订阅号、腾讯新闻等）。
    """
    u = str(username or "")
    if not u:
        return False
    if u.startswith("gh_") or u.endswith(SERVICE_SESSION_SUFFIXES):
        return True
    return u.lower() in SERVICE_SESSION_IDS


def cmd_new(payload):
    """检测「有新消息」的会话。

    数据源是 session.db 的 SessionTable.unread_count（会话按 sort_timestamp 排序），
    纯只读、零网络请求，微信最小化时同样可用。

    落盘语义：只把「本次新出现、或未读数 / 最后消息时间较上次快照有变化」的会话
    追加到 ``<account>\\new-YYYYMMDD.ndjson``，并更新 ``<account>\\new_state.json``
    快照，因此重复调用不会产生重复记录；未读清零的会话会移出快照，下次来信可重新触发。
    """
    cfg = load_config()
    limit = int(payload.get("limit") or 0)
    min_unread = int(payload.get("min_unread") or 1)
    top = max(int(payload.get("max") or 50), 1)
    exclude_service = payload.get("exclude_service")
    if exclude_service is None:
        exclude_service = True  # 默认剔除公众号 / 服务号推送，只留真人会话
    content_max = int(cfg.get("content_max_chars") or 4000)
    out_dir = account_dir()

    db = open_db()
    nickmap = {}
    try:
        nickmap = db.nickname_map() or {}
    except Exception:
        pass

    # get_sessions 按 sort_timestamp DESC 截断，limit<=0 时放大到足以覆盖全部会话
    sessions = db.get_sessions(limit=limit if limit > 0 else 10000)

    hits = []
    skipped_service = 0
    for s in sessions:
        u = s.get("username", "")
        unread = int(s.get("unread") or 0)
        if unread < min_unread:
            continue
        if exclude_service and is_service_chat(u):
            skipped_service += 1
            continue
        summary = s.get("summary") or ""
        hits.append({
            "chat_username": u,
            "chat_name": nickmap.get(u, "") or u,
            "unread": unread,
            "last_sender": s.get("last_sender", ""),
            "last_time": s.get("last_time"),
            "last_datetime": iso(s.get("last_time")),
            "summary": summary[:content_max],
            "summary_truncated": len(summary) > content_max,
        })
    hits.sort(key=lambda r: r.get("last_time") or 0, reverse=True)

    state_path = os.path.join(out_dir, "new_state.json")
    state = load_json(state_path, {}) or {}

    seen = set()
    changed = []
    for r in hits:
        u = r["chat_username"]
        seen.add(u)
        prev = state.get(u) or {}
        if prev.get("unread") != r["unread"] or prev.get("last_time") != r["last_time"]:
            changed.append(r)
    for u in list(state):
        if u not in seen:
            state.pop(u, None)  # 未读已清零，移出快照，便于下次重新触发
    for r in hits:
        state[r["chat_username"]] = {"unread": r["unread"], "last_time": r["last_time"]}

    out_file = None
    if changed:
        run_date = datetime.datetime.now().strftime("%Y%m%d")
        out_file = os.path.join(out_dir, "new-%s.ndjson" % run_date)
        detected_at = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        with open(out_file, "a", encoding="utf-8") as f:
            for r in changed:
                f.write(json.dumps(dict(r, detected_at=detected_at), ensure_ascii=False) + "\n")
    save_json(state_path, state)

    return {
        "ok": True,
        "scanned": len(sessions),
        "unread_chats": len(hits),
        "total_unread": sum(r["unread"] for r in hits),
        "exclude_service": bool(exclude_service),
        "skipped_service": skipped_service,
        "changed": len(changed),
        "output_file": out_file,
        "state_file": state_path,
        "sessions": hits[:top],
        "sessions_truncated": len(hits) > top,
    }


def cmd_sync_scan(payload):
    """扫描「可参与动态同步」的会话全集，并标注免打扰 / 服务号 / 手动排除。

    调度器每 ``sync_scan_seconds`` 调一次，用它刷新会话清单与免打扰状态；
    它本身**不读消息、不写游标**，只是一次只读的元数据快照。
    """
    cfg = load_config()
    db = open_db()
    nickmap = {}
    try:
        nickmap = db.nickname_map() or {}
    except Exception:
        pass

    chats = enum_chats(db, nickmap)
    try:
        auto_muted = muted_chat_map(db)
    except Exception:
        auto_muted = {}

    manual = payload.get("muted_chats")
    if manual is None:
        manual = cfg.get("muted_chats") or []
    manual_users = set()
    if manual:
        manual_users = {c["username"] for c in resolve_chats(db, nickmap, manual)}
    skip_filter = payload.get("skip_chats") or cfg.get("skip_chats") or []
    skip_users = set()
    if skip_filter:
        skip_users = {c["username"] for c in resolve_chats(db, nickmap, skip_filter)}

    include_muted = payload.get("include_muted")
    if include_muted is None:
        include_muted = not bool(cfg.get("sync_skip_muted", True))
    include_service = payload.get("include_service")
    if include_service is None:
        include_service = bool(cfg.get("sync_include_service", False))

    eligible, muted_rows = [], []
    skipped_service = 0
    for c in chats:
        u = c["username"]
        is_muted = bool(auto_muted.get(u)) or u in manual_users
        if is_muted and not include_muted:
            muted_rows.append({"username": u, "name": c["name"], "reason": "muted"})
            continue
        if is_service_chat(u) and not include_service:
            skipped_service += 1
            continue
        if u in skip_users:
            continue
        eligible.append({
            "username": u,
            "name": c["name"],
            "muted": is_muted,
            "service": is_service_chat(u),
            "message_count": c.get("message_count"),
        })

    return {
        "ok": True,
        "account": _ACCOUNT,
        "chats_total": len(chats),
        "chats": eligible,
        "muted": muted_rows,
        "muted_count": len(muted_rows),
        "skipped_service": skipped_service,
        "include_muted": bool(include_muted),
        "include_service": bool(include_service),
    }


def cmd_config(payload):
    cfg = load_config()
    patch = payload.get("set")
    if isinstance(patch, dict):
        for k, v in patch.items():
            if k in DEFAULTS:
                cfg[k] = v
        if not cfg.get("data_dir"):
            cfg["data_dir"] = os.path.join(app_dir(), "data")
        save_json(config_path(), {k: cfg[k] for k in DEFAULTS})
    return {"ok": True, "config": cfg, "config_path": config_path()}


def _safe_name(username):
    """把 username（含 @ 群号等）转成可用作文件名的安全串。"""
    out = []
    for ch in str(username or ""):
        out.append(ch if (ch.isalnum() or ch in "-_@.") else "_")
    return ("".join(out)[:120]) or "chat"


def normalize_export_msg(chat, m, content_max, media_path=None):
    """归一化 export_history 返回的单条消息（该接口已给出 chat/sender_name/序号）。"""
    typ = m.get("type") or ""
    content = m.get("content")
    if typ in ("文本", "Text"):
        text = content or ""
    elif typ:
        text = "[%s]" % typ
    else:
        text = ""
    raw = content if isinstance(content, str) else ""
    return {
        "chat_username": chat.get("username", ""),
        "chat_name": chat.get("name") or chat.get("username", ""),
        "local_id": m.get("local_id"),
        "sort_seq": m.get("sort_seq"),
        "type": typ,
        "type_code": m.get("type_code"),
        "sender_name": m.get("sender_name") or "",
        "server_id": m.get("server_id"),
        "md5": m.get("md5"),
        "create_time": m.get("create_time"),
        "datetime": iso(m.get("create_time")),
        "text": text,
        "content": raw[:content_max],
        "content_truncated": len(raw) > content_max,
        "media_path": media_path,
    }


def export_chat(db, out_path, username):
    """调库的 export_history 导出单会话全历史，返回 messages 列表。

    实测该接口偶发返回 0 条（同一 username 同一时刻重跑即有数据，疑似与微信
    正在写库的读竞争有关），故调用方需对空结果重试一次。
    """
    db.export_history(out_path, fmt="json", users=[username], limit_per_chat=None)
    with open(out_path, "r", encoding="utf-8") as f:
        return (json.load(f) or {}).get("messages") or []


def cmd_backfill(payload):
    """
    全量历史回溯：把每个会话从最新翻到最老，逐会话落一份 NDJSON。

    走库自带的 export_history（limit_per_chat=None = 全历史），比自己按 offset 翻页更可靠：
    它已处理分片合并、发送者名称解析、时间升序，且多分片同号问题由库内部消化。

    幂等：每个会话写成 <backfill>/<safe-username>.ndjson，**已存在即跳过**，
    故中断后重跑只补未完成的会话，不会重复落盘（force=True 可强制重做）。
    """
    cfg = load_config()
    bf_dir = os.path.join(account_dir(), "backfill")  # 按账号隔离产物
    os.makedirs(bf_dir, exist_ok=True)

    chats_filter = payload.get("chats") or cfg.get("chats") or []
    max_chats = int(payload.get("max_chats") or cfg.get("max_chats") or 0)
    content_max = int(cfg.get("content_max_chars") or 4000)
    force = bool(payload.get("force"))
    want_media = payload.get("download_media")
    if want_media is None:
        want_media = bool(cfg.get("download_media", True))

    db = open_db()
    nickmap = {}
    try:
        nickmap = db.nickname_map() or {}
    except Exception:
        pass

    if chats_filter:
        sessions = resolve_chats(db, nickmap, chats_filter)
    else:
        sessions = enum_chats(db, nickmap)
    skip_filter = payload.get("skip_chats") or cfg.get("skip_chats") or []
    if skip_filter:
        skip_users = {s["username"] for s in resolve_chats(db, nickmap, skip_filter)}
        sessions = [s for s in sessions if s["username"] not in skip_users]
    if max_chats and len(sessions) > max_chats:
        sessions = sessions[:max_chats]

    md = None
    image_key_ok = None
    if want_media:
        try:
            from wechatauto import MediaDownloader
            md = MediaDownloader(db)
            image_key_ok = bool(md.detect_image_key())
        except Exception as e:
            md = None
            image_key_ok = False
            sys.stderr.write("media downloader init failed: %s: %s\n" % (type(e).__name__, e))

    stats = {
        "ok": True,
        "chats_total": len(sessions),
        "chats_backfilled": 0,
        "chats_skipped": 0,
        "chats_empty": 0,
        "empties": [],
        "messages": 0,
        "media_downloaded": 0,
        "media_failed": 0,
        "download_media": want_media,
        "image_key_ok": image_key_ok,
        "backfill_dir": bf_dir,
        "errors": [],
        "done": [],
    }

    for i, s in enumerate(sessions):
        u = s["username"]
        safe = _safe_name(u)
        final = os.path.join(bf_dir, safe + ".ndjson")
        if os.path.exists(final) and not force:
            stats["chats_skipped"] += 1
            continue

        tmp_json = os.path.join(bf_dir, "." + safe + ".export.json")
        try:
            msgs = export_chat(db, tmp_json, u)
            if not msgs:
                # 该接口偶发返回 0 条（同一 username 重跑即有），重试一次再定论
                msgs = export_chat(db, tmp_json, u)
        except Exception as e:
            stats["errors"].append({"chat": s["name"], "error": "%s: %s" % (type(e).__name__, e)})
            sys.stderr.write("backfill %s failed: %s\n" % (u, e))
            try:
                os.remove(tmp_json)
            except Exception:
                pass
            continue

        if not msgs:
            # 不落空文件：保持「已存在即跳过」的幂等语义，留待下次重跑补采
            stats["chats_empty"] += 1
            stats["empties"].append({"chat": s["name"], "username": u})
            try:
                os.remove(tmp_json)
            except Exception:
                pass
            continue

        media_ok = 0
        media_fail = 0
        save_dir = os.path.join(bf_dir, "media", safe)
        if md is not None:
            os.makedirs(save_dir, exist_ok=True)

        tmp_out = final + ".tmp"
        try:
            with open(tmp_out, "w", encoding="utf-8") as f:
                for m in msgs:
                    media_path = None
                    if md is not None and (m.get("type") or "") in MEDIA_TYPES:
                        try:
                            media_path = md.download_media(u, m.get("local_id"), save_dir=save_dir)
                            if media_path:
                                media_ok += 1
                            else:
                                media_fail += 1
                        except Exception:
                            media_fail += 1
                    rec = normalize_export_msg(s, m, content_max, media_path)
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            os.replace(tmp_out, final)
        except Exception as e:
            stats["errors"].append({"chat": s["name"], "error": "write: %s: %s" % (type(e).__name__, e)})
            continue
        finally:
            try:
                os.remove(tmp_json)
            except Exception:
                pass

        stats["chats_backfilled"] += 1
        stats["messages"] += len(msgs)
        stats["media_downloaded"] += media_ok
        stats["media_failed"] += media_fail
        stats["done"].append({"chat": s["name"], "messages": len(msgs),
                              "media": media_ok, "file": final})
        sys.stderr.write("[backfill %d/%d] %s -> %d msgs, media %d ok / %d fail\n" % (
            i + 1, len(sessions), s["name"], len(msgs), media_ok, media_ok + media_fail))
        sys.stderr.flush()

    if len(stats["errors"]) > 20:
        stats["errors"] = stats["errors"][:20]
    if len(stats["empties"]) > 30:
        stats["empties"] = stats["empties"][:30]
    if len(stats["done"]) > 30:
        stats["done"] = sorted(stats["done"], key=lambda r: r["messages"], reverse=True)[:30]
    return stats


def send_verify_usernames(db, nickmap, who):
    """把会话标识解析成候选 username（消息表按 username 键）。

    比库内 `_verify_usernames` 多一步「昵称/备注反查」：库里那份只查
    `search_contact`，像「文件传输助手」（username=filehelper）这种不在通讯录里的
    会话解析不出来，会让回读校验静默失败、把发成功的消息误报成未确认。
    """
    if not who:
        try:
            return [db.get_self_info().get("username")]
        except Exception:
            return []
    names = []
    try:
        names += [h["username"] for h in db.search_contact(who) if h.get("username")]
    except Exception:
        pass
    for u, nm in (nickmap or {}).items():
        if nm and nm == who:
            names.append(u)
    names.append(who)
    out, seen = [], set()
    for n in names:
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    return out


def send_watermark(db, usernames):
    """发送前拍水位：候选会话里当前最大的 sort_seq（全取不到则 None）。"""
    seq = None
    for u in usernames:
        try:
            rows = db.get_messages(u, limit=5) or []
        except Exception:
            continue
        if rows:
            cur = max(int(r.get("sort_seq") or 0) for r in rows)
            seq = cur if seq is None else max(seq, cur)
    return seq


def wait_landed(db, usernames, needle=None, after=None, types=None,
                mode="exact", timeout=10.0, interval=1.0):
    """自己回读确认落库：只看比水位更新、且（正文匹配 或 类型匹配）的行。

    needle=None 时改按 types 匹配（媒体消息正文里没有原始文件名，按类型命中更可靠）。
    """
    deadline = time.time() + timeout
    while True:
        for u in usernames:
            try:
                rows = db.get_messages(u, limit=10) or []
            except Exception:
                continue
            for r in rows:
                if int(r.get("sort_seq") or 0) <= (after if after is not None else -1):
                    continue
                if types is not None and (r.get("type") or "") not in types:
                    continue
                if needle is None:
                    return True
                content = r.get("content") or ""
                hit = (content == needle) if mode == "exact" else (needle in content)
                if hit:
                    return True
        if time.time() >= deadline:
            return False
        time.sleep(interval)


# ------------------------------------------------------------ 静默发送（实测结论）
#
# 逐项实测（发到「文件传输助手」+ 数据库回读判定）：
#   · 写正文：UIA ValuePattern.SetValue 可在微信**后台**写入，且不碰鼠标；
#   · 回车发送：PostMessage(WM_KEYDOWN/WM_KEYUP, VK_RETURN) 直接投递给主窗口
#     HWND，微信在**后台**（被别的窗口盖住）也能正常落库；
#   · 切换会话：只能「UIA 取焦点 → 投递 WM_CHAR 逐字输入 → 回车」，而投递
#     回车这一步**要求微信当前是前台**（后台投递不生效）——但它同样不碰鼠标。
# 另：库在创建 UIA 引擎 / SetValue / SetFocus 时会 BringWindowToTop +
# SetForegroundWindow 抢一次前台，所以每步之后都要立即把前台还给原窗口。

_MAIN_WND_CLASS = "Qt51514QWindowIcon"
_WM_KEYDOWN, _WM_KEYUP, _WM_CHAR, _VK_RETURN = 0x0100, 0x0101, 0x0102, 0x0D


def enum_main_windows():
    """枚举所有微信主窗口（多开时会有多个，类名与标题完全相同）。"""
    import ctypes
    from ctypes import wintypes
    u = _user32()
    u.EnumWindows.argtypes = [
        ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM), wintypes.LPARAM]
    u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    u.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    u.IsWindowVisible.argtypes = [wintypes.HWND]
    u.IsIconic.argtypes = [wintypes.HWND]

    out = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        cls = ctypes.create_unicode_buffer(256)
        u.GetClassNameW(hwnd, cls, 256)
        if cls.value == _MAIN_WND_CLASS:
            pid = wintypes.DWORD()
            u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            title = ctypes.create_unicode_buffer(256)
            u.GetWindowTextW(hwnd, title, 256)
            out.append({
                "hwnd": int(hwnd),
                "pid": int(pid.value),
                "title": title.value,
                "visible": bool(u.IsWindowVisible(hwnd)),
                "minimized": bool(u.IsIconic(hwnd)),
            })
        return True

    u.EnumWindows(cb, 0)
    return out


def account_dir_names():
    """<xwechat_files> 下的账号目录名（= 工具的 account 参数取值）。"""
    try:
        root = os.path.join(os.path.expanduser("~"), "Documents", "xwechat_files")
        return sorted(
            d for d in os.listdir(root)
            if os.path.isdir(os.path.join(root, d)) and d not in ("Backup", "all_users"))
    except Exception:
        return []


def _wxid_of_pid(pid):
    """从该 Weixin.exe 进程内存读出登录的 wxId（只读，不注入）。

    微信多开时每个实例只在自己进程里持有本账号的主密钥，因此 wxId 是
    「进程 → 账号」唯一的可靠锚点（窗口标题、类名在多个实例间完全相同）。
    """
    try:
        from wechatauto.db import extract_master_key_from_cfg
        got = extract_master_key_from_cfg(pid)
        return got[2] if got else None
    except Exception:
        return None


def account_of_wxid(wxid):
    """账号目录名与 wxId 的对应：目录名等于 wxId，或为 ``<wxid>_<后缀>``。"""
    if not wxid:
        return None
    for d in account_dir_names():
        if d.lower() == wxid.lower() or d.lower().startswith(wxid.lower() + "_"):
            return d
    return None


def list_instances():
    """列出可见的微信实例，并把窗口 / 进程 / 账号目录对应起来。

    返回每项：``hwnd`` / ``pid`` / ``title`` / ``wxid`` / ``account``。
    多个可见窗口按 hwnd 去重（同一实例可能还有隐藏辅助窗口，已在下方过滤）。
    """
    insts = []
    seen = set()
    for w in enum_main_windows():
        if not w["visible"] or w["hwnd"] in seen:
            continue
        seen.add(w["hwnd"])
        wxid = _wxid_of_pid(w["pid"])
        insts.append(dict(w, wxid=wxid, account=account_of_wxid(wxid)))
    return insts


def bind_uia_window(engine, hwnd):
    """把 UIA 引擎锁定到 ``hwnd`` 对应的窗口。

    库的 ``WeChatUIA()`` 不接受 hwnd，``ensure_window()`` 按标题挑第一个匹配窗口。
    多开时所有实例标题都叫「微信」，于是发给第二个账号的正文会被写进**第一个**
    账号的输入框（实测复现）。只覆盖 ``_win`` 不够：``ensure_window()`` 会重新
    遍历 ``_wechat_hwnds()`` 把绑定覆盖回去，所以这里连窗口列表一起锁定。
    """
    anchor = engine._anchor(hwnd)
    if anchor is None:
        raise RuntimeError("无法绑定微信窗口 hwnd=%s（窗口已关闭？）" % hwnd)
    engine._win = anchor
    engine._wechat_hwnds = lambda diag=None: [hwnd]


def resolve_main_hwnd(account):
    """按账号定位微信主窗口；多开时不确定就报错而不是猜。

    - 恰好一个实例可匹配 ``account`` → 用它；
    - 只有一个实例且没匹配上（单开机器 / 锚点漂移）→ 回退到它，行为与旧版一致；
    - 多个实例但无法唯一匹配 → 报错，避免把消息发到别的账号。
    """
    insts = list_instances()
    if not insts:
        raise RuntimeError("未找到微信主窗口（微信未启动或类名已变更）")
    matched = [i for i in insts if account and i.get("account") == account]
    if len(matched) == 1:
        return matched[0]["hwnd"], matched[0]
    if len(insts) == 1:
        return insts[0]["hwnd"], insts[0]
    desc = "；".join(
        "hwnd=%s pid=%s 账号=%s" % (i["hwnd"], i["pid"], i.get("account") or ("未识别(%s)" % (i.get("wxid") or "-")))
        for i in insts)
    raise RuntimeError(
        "检测到 %d 个微信实例，无法唯一定位账号「%s」：%s。"
        "请确认该账号已登录且窗口未关闭；可用 wechat_status 查看实例与账号的对应关系。"
        % (len(insts), account, desc))


def _user32():
    import ctypes
    from ctypes import wintypes
    u = ctypes.WinDLL("user32", use_last_error=True)
    u.FindWindowW.restype = wintypes.HWND
    u.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
    u.GetForegroundWindow.restype = wintypes.HWND
    u.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    return u


def _post_key(hwnd, vk, down=True):
    """投递一次按键（不动真实光标 / 不注入全局键盘）。"""
    lp = 1 | (0x1C << 16)
    if not down:
        lp |= (1 << 30) | (1 << 31)
    _user32().PostMessageW(hwnd, _WM_KEYDOWN if down else _WM_KEYUP, vk, lp)


def _post_enter(hwnd):
    _post_key(hwnd, _VK_RETURN, True)
    time.sleep(0.03)
    _post_key(hwnd, _VK_RETURN, False)


def _post_text(hwnd, text):
    """逐字投递 WM_CHAR：Qt 会派发给当前聚焦控件，全程不碰鼠标键盘。"""
    u = _user32()
    for ch in text:
        u.PostMessageW(hwnd, _WM_CHAR, ord(ch), 1)
        time.sleep(0.05)


_SEARCH_POPUP_CLASS = "Qt51514QWindowTool"


def find_search_popup(pid, exclude_hwnd=None):
    """搜索下拉是独立的 Qt::Popup 顶层窗口（类名 Qt51514QWindowTool*）。

    弹出时间不定，故轮询几秒；同名进程里还有输入法窗口（SoPY_*），按类名前缀过滤。
    """
    import ctypes
    from ctypes import wintypes
    u = _user32()
    u.EnumWindows.argtypes = [
        ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM), wintypes.LPARAM]
    u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    u.IsWindowVisible.argtypes = [wintypes.HWND]

    deadline = time.time() + 2.0
    while time.time() < deadline:
        found = []

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def cb(hwnd, _):
            h = int(hwnd)
            if exclude_hwnd and h == exclude_hwnd:
                return True
            p = wintypes.DWORD()
            u.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
            if p.value != pid or not u.IsWindowVisible(hwnd):
                return True
            cls = ctypes.create_unicode_buffer(256)
            u.GetClassNameW(hwnd, cls, 256)
            if _SEARCH_POPUP_CLASS in cls.value:
                found.append(h)
            return True

        u.EnumWindows(cb, 0)
        if found:
            return found[0]
        time.sleep(0.2)
    return None


def _post_mouse_click(hwnd, x, y):
    """把一次左键点击**投递**到窗口客户区坐标 (x, y)，不移动真实光标。"""
    import ctypes
    from ctypes import wintypes
    u = _user32()
    u.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    lp = (int(y) << 16) | (int(x) & 0xFFFF)
    u.PostMessageW(hwnd, 0x0200, 0, lp)   # WM_MOUSEMOVE
    time.sleep(0.05)
    u.PostMessageW(hwnd, 0x0201, 1, lp)   # WM_LBUTTONDOWN
    time.sleep(0.05)
    u.PostMessageW(hwnd, 0x0202, 0, lp)   # WM_LBUTTONUP


class QuietSender:
    """静默发送：不移动鼠标、不点击、不置顶，微信可被别的窗口盖住。

    限制：只支持**纯文本**、**不回复**（图片 / 文件要真实拖拽或 Ctrl+V，回复要
    右键点击最近一条消息——都必然动鼠标）。切换目标会话那一步会短暂占用前台
    （约 1-2 秒），随后立即归还给调用前的窗口；若目标会话已经是当前会话，则
    全程微信都在后台。
    """

    def __init__(self):
        from wechatauto import WeChatGUI
        from wechatauto.uia_driver import WeChatUIA
        u = _user32()
        # 多开时必须按账号定位窗口：FindWindowW 只会拿第一个匹配窗口（可能不是目标账号）
        hwnd, self.instance = resolve_main_hwnd(_ACCOUNT)
        self.u, self.hwnd, self._UIA = u, hwnd, WeChatUIA
        self._prev = u.GetForegroundWindow()
        # 布局校准会 bring_to_front + OCR（数秒、且置顶），静默模式整段跳过
        WeChatGUI.calibrate_layout = lambda self, *a, **k: True
        self._gui = WeChatGUI(hwnd=hwnd)
        self.d = self._gui._get_uia()      # 创建引擎会抢前台
        self.restore()
        self.used_mouse = False            # 切换会话是否退回了真实鼠标点击
        if not self.d.ensure_window():     # 同样会抢前台
            raise RuntimeError("微信窗口不可用（可能被最小化）")
        self.restore()
        bind_uia_window(self.d, hwnd)      # 多开：强制绑定到本账号的窗口

    def restore(self):
        """把前台还给调用前的窗口（库每步都可能抢前台，逐个还回去）。"""
        try:
            if self._prev:
                self._UIA._force_foreground(self._prev)
        except Exception:
            pass

    def current_chat(self):
        return self.d.current_chat()

    def switch_chat(self, who):
        """搜索并打开会话：不动真实鼠标、不置顶。

        实测（微信 4.x，两个实例都验证过）：搜索下拉的结果行**没有** UIA 的
        Invoke/Select 模式，往主窗口投递回车也不会打开会话（微信不响应）。
        唯一可靠的动作是点结果行——但可以把左键消息**投递**给搜索下拉那个独立
        的 Qt::Popup 窗口（类名 Qt51514QWindowTool*），坐标换算成它的客户区，
        这样真实光标一动不动。定位不到弹窗时才退回真实鼠标点击（会记录
        ``used_mouse``，调用方据此如实告知用户）。
        """
        box = self.d._search_box_present(self.d._win)
        if box is None:
            return False
        for kw in self.d._resolve_search_keyword(who) or [who]:
            try:
                box.SetFocus()             # UIA 取焦点（会激活窗口，不碰鼠标）
                self.d._set_text(box, "")
            except Exception:
                return False
            _post_text(self.hwnd, kw)
            time.sleep(0.9)
            try:
                hits = self.d._collect_results(kw) or []
            except Exception:
                hits = []
            if not hits:
                continue
            cell = hits[0].get("cell")
            if cell is None:
                continue

            try:
                r = cell.BoundingRectangle
                pop = find_search_popup(self.instance.get("pid"), self.hwnd)
                if pop is not None:
                    import ctypes
                    from ctypes import wintypes
                    pr = wintypes.RECT()
                    _user32().GetWindowRect(pop, ctypes.byref(pr))
                    cx = int((r.left + r.right) / 2) - pr.left
                    cy = int((r.top + r.bottom) / 2) - pr.top
                    _post_mouse_click(pop, cx, cy)
                    time.sleep(1.2)
                    cur = self.current_chat()
                    if cur and (cur == kw or kw in cur):
                        return True
            except Exception as e:
                sys.stderr.write("quiet switch post-click failed: %s: %s\n" % (type(e).__name__, e))

            # 兜底：真实鼠标点击结果行（光标会跳一下，仍不置顶窗口）
            self.used_mouse = True
            try:
                self.d._click_ctrl(cell)
            except Exception:
                continue
            time.sleep(1.2)
            cur = self.current_chat()
            if cur and (cur == kw or kw in cur):
                return True
        return False

    def send_text(self, text):
        """写正文（后台可写）→ 归还前台 → 后台投递回车发送。"""
        e = self.d._chat_input()
        if e is None:
            return False
        if not self.d._set_text(e, text):
            return False
        if (self.d._read_edit_value(e) or "").strip() != text.strip():
            return False
        try:
            # 让 Qt 把投递来的回车派发给输入框（SetFocus 会激活窗口，随即归还前台）。
            # 缺这一步时，若输入框本就没有焦点，回车会被窗口丢弃 —— 表现为
            # 「正文写进去了、消息没发出去」（多开时第二个实例上实测复现）。
            e.SetFocus()
        except Exception:
            pass
        self.restore()
        _post_enter(self.hwnd)
        time.sleep(0.8)
        return True


def cmd_send(payload):
    """
    发送微信消息（文本 / 图片 / 文件）——**UI 自动化**路线，不是协议级发送。

    与读库路线（doctor/sessions/fetch/backfill）性质完全不同：
      · 会真实驱动鼠标键盘，并把遮挡窗口最小化以把微信置顶（ensure_visible）；
      · 要求微信窗口**可见且未锁屏**，发送期间用户无法正常使用电脑；
      · 仅适合手动、低频调用；高频/群发有触发微信风控的风险。

    verify=True 时库会回读数据库确认消息已落库（不重复发送）；库自带校验对
    「文件传输助手」这类不在通讯录里的会话会误报「未确认」，本插件在其后
    追加一层自研回读兜底（按水位 + 正文/类型匹配）避免误报。

    quiet=True 走静默路线（详见 `QuietSender`）：不移动鼠标、不点击、不置顶，
    微信可被别的窗口盖住；只支持纯文本、不支持 reply。若目标会话不是当前会话，
    切换那一步会短暂占用前台约 1-2 秒（随后立即归还）。
    """
    to = str(payload.get("to") or "").strip()
    verify = bool(payload.get("verify"))
    reply = bool(payload.get("reply"))
    quiet = bool(payload.get("quiet"))

    plan = []
    text = payload.get("text")
    if isinstance(text, str) and text != "":
        plan.append(("text", text))
    for key in ("image", "file"):
        v = payload.get(key)
        if isinstance(v, str) and v.strip():
            plan.append((key, v.strip()))

    if not plan:
        return {"ok": False, "error": "至少要提供 text / image / file 之一"}

    if quiet:
        if reply:
            return {"ok": False, "error": "静默模式不支持 reply：回复要先右键点最近一条消息，必然动鼠标"}
        if any(k != "text" for k, _ in plan):
            return {"ok": False, "error": "静默模式只支持纯文本：图片 / 文件要真实拖拽或 Ctrl+V，无法静默。"
                                          "请去掉 quiet，或只发 text"}

    missing = [p for k, p in plan if k in ("image", "file") and not os.path.isfile(p)]
    if missing:
        return {"ok": False, "error": "文件不存在：%s" % "，".join(missing)}

    if not weixin_pids():
        return {"ok": False, "wechat_running": False,
                "error": "微信未运行。发送走 UI 自动化，需要微信处于已登录且窗口可见。"}

    # 自研回读校验的准备：连不上库就退回库自带校验，不让发送本身失败
    # （静默模式不经过库自带校验，一律靠自研回读判定，所以 quiet 也强制开库）
    db = None
    verify_users = []
    if verify or quiet:
        try:
            db = open_db()
            nickmap = {}
            try:
                nickmap = db.nickname_map() or {}
            except Exception:
                pass
            verify_users = send_verify_usernames(db, nickmap, to)
        except Exception as e:
            sys.stderr.write("verify: open_db failed: %s: %s\n" % (type(e).__name__, e))
            db = None

    if quiet:
        try:
            sender = QuietSender()
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
        if to and sender.current_chat() != to:
            if not sender.switch_chat(to):
                return {"ok": False, "to": to, "quiet": True,
                        "error": "静默切换会话失败（要求微信窗口未被最小化；目标名也可能不唯一）。"
                                 "可先手动打开该会话再重试，或去掉 quiet 走普通模式。"}
            sender.restore()
    else:
        try:
            from wechatauto import WeChatGUI
            # 多开时按账号定位窗口，避免发到另一个账号
            hwnd, _inst = resolve_main_hwnd(_ACCOUNT)
            sender = WeChatGUI(hwnd=hwnd)
            sender.instance = _inst
            eng = sender._get_uia()        # 多开：引擎默认会绑到第一个窗口
            if eng is not None:
                bind_uia_window(eng, hwnd)
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    results = []
    for kind, val in plan:
        after = send_watermark(db, verify_users) if db is not None else None
        try:
            if quiet:
                ok = sender.send_text(val)
                landed = (wait_landed(db, verify_users, needle=val, after=after,
                                      mode="exact") if (ok and db is not None) else False)
                d = {"status": "成功" if ok else "错误",
                     "message": ("已静默发送（后台回读数据库确认已落库）" if landed
                                 else "已静默发送；后台回读未确认（请以微信窗口实际状态为准）" if ok
                                 else "静默发送失败（正文没落进输入框，或后台回车未生效）")}
                if getattr(sender, "used_mouse", False):
                    d["message"] += "；切换会话时退回了真实鼠标点击"
            elif kind == "text":
                r = (sender.reply_msg(val, who=to or None, verify=verify) if reply
                     else sender.send_msg(val, who=to or None, verify=verify))
            elif kind == "image":
                r = sender.send_image(val, who=to or None, verify=verify)
            else:
                r = sender.send_file(val, who=to or None, verify=verify)
            if not quiet:
                d = r.to_dict() if hasattr(r, "to_dict") else dict(r)
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            d = {"status": "错误", "message": "%s: %s" % (type(e).__name__, e)}

        status = d.get("status")
        message = d.get("message")

        # 库自带校验对非通讯录会话（如「文件传输助手」）会解析不出 username → 误报「未确认」。
        # 这里按「发送前水位」自己回读一次：文本按正文匹配，媒体按类型命中。
        if verify and status != "成功":
            landed = False
            if db is not None:
                if kind == "text":
                    need, types, mode = val, None, ("contains" if reply else "exact")
                elif kind == "image":
                    need, types, mode = None, ("图片",), "exact"
                else:
                    need, types, mode = None, ("文件",), "exact"
                landed = wait_landed(db, verify_users, needle=need, after=after,
                                     types=types, mode=mode)
            if landed:
                status = "成功"
                message = "已发送（本插件回读数据库确认%s）" % (
                    "；库自带校验未识别该会话" if not quiet else "；静默模式无库校验")
            elif message and "已操作发送" in message and "未确认" in message:
                # 库自己都已确认「消息已操作发送」，只是回读对不上（多账号机器上
                # 读到的可能不是当前发送账号的库）。判为已发送，但如实标注未确认。
                status = "成功"
                message = "已发送（UI 操作已完成；数据库回读未确认，请以微信窗口实际状态为准）"

        results.append({
            "kind": kind,
            "target": val if kind != "text" else (val[:200] + ("…" if len(val) > 200 else "")),
            "status": status,
            "message": message,
        })

    return {
        "ok": True,
        "to": to or "(当前打开的会话)",
        "verify": verify,
        "reply": reply,
        "quiet": quiet,
        "account": _ACCOUNT,
        "instance": getattr(sender, "instance", None),
        "sent": sum(1 for x in results if x.get("status") == "成功"),
        "total": len(results),
        "results": results,
    }


COMMANDS = {
    "doctor": cmd_doctor,
    "sessions": cmd_sessions,
    "fetch": cmd_fetch,
    "new": cmd_new,
    "backfill": cmd_backfill,
    "send": cmd_send,
    "config": cmd_config,
    "sync_scan": cmd_sync_scan,
}


def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except Exception as e:
        print(json.dumps({"ok": False, "error": "invalid stdin payload: %s" % e}, ensure_ascii=False))
        return 1

    args = payload.get("args") or {}
    global _ACCOUNT
    try:
        _ACCOUNT = args.get("account") or load_config().get("account") or DEFAULT_ACCOUNT
    except Exception:
        _ACCOUNT = DEFAULT_ACCOUNT

    cmd = payload.get("cmd") or (sys.argv[1] if len(sys.argv) > 1 else "doctor")
    fn = COMMANDS.get(cmd)
    if fn is None:
        print(json.dumps({"ok": False, "error": "unknown cmd: %s" % cmd,
                          "available": sorted(COMMANDS)}, ensure_ascii=False))
        return 1

    try:
        result = fn(args)
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, ensure_ascii=False))
        return 1

    print(json.dumps(result, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
