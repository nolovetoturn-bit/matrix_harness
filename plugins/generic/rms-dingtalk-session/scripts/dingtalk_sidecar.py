#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
rms-dingtalk-session 边车（Python 侧）。

职责：
  1) 只读扫描钉钉进程内存取数据库密钥；
  2) 用 AES-128-ECB 解密本地 SQLite 库（含 WAL），把会话/消息归一化成 JSON/NDJSON；
  3) 经 UI 自动化（搜索面板 CEF 精确点击结果 + 剪贴板粘贴 + Enter）发送文本消息。

契约：**只从 stdin 读一个 JSON 载荷，只向 stdout 写一个 JSON 文档**；诊断走 stderr。

子命令：doctor / sessions / fetch / send / config
依赖：cryptography、psutil、uiautomation（装在专用 venv 里）。
"""

import ctypes
import datetime
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import traceback
import zlib
from ctypes import wintypes

APP_NAME = "rms-dingtalk-session"

DEFAULT_ACCOUNT = None  # None = 自动选最近活跃的 *_v3 账号目录
DEFAULTS = {
    "account": DEFAULT_ACCOUNT,
    "data_dir": None,          # None => <LOCALAPPDATA>/rms-dingtalk-session/data
    "limit_per_chat": 200,     # 首次采集每会话回溯条数
    "max_chats": 0,            # 0 = 全部
    "chats": [],
    "skip_chats": [],
    "content_max_chars": 4000,
}

# 已实测版本（钉钉 7.x / Windows）的数据库密钥。命中可直接用，省去 ~1 分钟内存扫描。
KNOWN_KEYS = ["077150d580cae1a6"]

SQLITE_MAGIC = b"SQLite format 3\x00"
# 用真实密钥对 16 个零字节做 AES-128-ECB 加密得到的固定密文；用于在内存中快速试密钥。
ZERO_CT = bytes.fromhex("8a56f8b1341a1e2d99995104d1b95fd2")
ZERO = b"\x00" * 16
SHARD_COUNT = 128

SEARCH_AID = ("dt_main_frame_view{default}.widget.widgetTitleBarContainerWrapper."
              "widgetTitleBarContainer.titlebar_widget.search_bar.search_edit")
INPUT_AID = ("qt_chat_navigable_content_widget.stackedWidget.mesasgePage.widget.splitter."
             "widgetRichEditWnd.drich_edit.verticalContentWidget.widget_input_wnd."
             "textEditWidget.textEdit")

_ACCOUNT = None
_ACCOUNT_DB = None


# --------------------------------------------------------------------------- #
# 基础：目录 / 配置
# --------------------------------------------------------------------------- #

def app_dir():
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    d = os.path.join(base, APP_NAME)
    os.makedirs(d, exist_ok=True)
    return d


def config_path():
    return os.path.join(app_dir(), "config.json")


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
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


def dingtalk_root():
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    return os.path.join(base, "DingTalk")


def account_dir_names():
    """枚举 %APPDATA%\\DingTalk\\*_v3 下存在 DBFiles/dingtalk.db 的账号目录。"""
    root = dingtalk_root()
    out = []
    try:
        for name in os.listdir(root):
            db = os.path.join(root, name, "DBFiles", "dingtalk.db")
            if os.path.isfile(db):
                out.append((os.path.getmtime(db), name))
    except Exception:
        return []
    out.sort(reverse=True)
    return [name for _, name in out]


def account_base_dir():
    """当前账号的钉钉数据目录（...\\DingTalk\\<account>）。"""
    return os.path.join(dingtalk_root(), _ACCOUNT)


def account_dir():
    """本插件按账号隔离的产物目录：<data_dir>/<account>。"""
    d = os.path.join(load_config()["data_dir"], _ACCOUNT)
    os.makedirs(d, exist_ok=True)
    return d


def cursor_path():
    return os.path.join(account_dir(), "cursor.json")


def key_cache_path():
    return os.path.join(account_dir(), "key.json")


# --------------------------------------------------------------------------- #
# 文件共享读（钉钉运行中也能读）
# --------------------------------------------------------------------------- #

GENERIC_READ = 0x80000000
SHARE_ALL = 0x00000007
OPEN_EXISTING = 3
FILE_ATTRIBUTE_NORMAL = 0x80

_k32 = ctypes.WinDLL("kernel32", use_last_error=True)
_k32.CreateFileW.restype = ctypes.c_void_p
_k32.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p,
                             ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
_k32.ReadFile.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32,
                          ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
_k32.CloseHandle.argtypes = [ctypes.c_void_p]


def read_shared(path, limit=None):
    """以 FILE_SHARE_READ|WRITE|DELETE 打开，读到内存（可限制前 N 字节）。"""
    h = _k32.CreateFileW(path, GENERIC_READ, SHARE_ALL, None, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, None)
    if h in (None, ctypes.c_void_p(-1).value):
        return None
    try:
        size = os.path.getsize(path)
        n = size if limit is None else min(size, limit)
        buf = ctypes.create_string_buffer(max(n, 1))
        got = ctypes.c_uint32(0)
        ok = _k32.ReadFile(h, buf, n, ctypes.byref(got), None)
        return buf.raw[:got.value] if ok else None
    finally:
        _k32.CloseHandle(h)


# --------------------------------------------------------------------------- #
# 解密
# --------------------------------------------------------------------------- #

def _aes_ecb_decrypt(key, data):
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    c = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
    data = data[:len(data) - len(data) % 16]
    return c.update(data) + c.finalize()


def _aes_ecb_encrypt_block(key, block):
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    c = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    return c.update(block) + c.finalize()


def db_paths():
    base = account_base_dir()
    files = os.path.join(base, "DBFiles")
    return os.path.join(files, "dingtalk.db"), os.path.join(base, "user_config")


def key_works(key, path):
    if not key or len(key) not in (16, 24, 32):
        return False
    head = read_shared(path, 32)
    if not head or len(head) < 16:
        return False
    try:
        return _aes_ecb_decrypt(key, head[:16]) == SQLITE_MAGIC
    except Exception:
        return False


def _read_salt():
    """user_config 是 base64(JSON)，含 salt / salt_md5。"""
    import base64
    db, cfg = db_paths()
    raw = read_shared(cfg)
    if not raw:
        return {}
    try:
        txt = base64.b64decode(raw, validate=False).decode("utf-8", "ignore")
        return json.loads(txt)
    except Exception:
        try:
            return json.loads(raw.decode("utf-8", "ignore"))
        except Exception:
            return {}


def _proc_pids():
    try:
        import psutil
    except Exception:
        return []
    pids = []
    for p in psutil.process_iter(["pid", "name"]):
        try:
            if (p.info.get("name") or "").lower().startswith("dingtalk"):
                pids.append(p.info["pid"])
        except Exception:
            continue
    return pids


def _printable_runs(buf):
    """提取长度 >=16 的可打印 ASCII 片段，按 16 字节对齐切出候选密钥。"""
    cands = set()
    i, n = 0, len(buf)
    while i < n:
        if 32 <= buf[i] <= 126:
            j = i
            while j < n and 32 <= buf[j] <= 126:
                j += 1
            run = buf[i:j]
            if len(run) >= 16:
                for off in range(0, len(run) - 15, 16):
                    cands.add(run[off:off + 16])
            i = j
        else:
            i += 1
    return cands


def scan_memory_for_key(db):
    """扫描钉钉进程内存：在 salt 字符串附近找 16 字节 AES 密钥。

    只读、无需管理员权限；找不到返回 None。
    """
    salt_info = _read_salt()
    needles = []
    salt = str(salt_info.get("salt") or "")
    if salt:
        needles.append(salt.encode("ascii", "ignore"))
        try:
            needles.append(bytes.fromhex(salt))
        except Exception:
            pass
    smd5 = str(salt_info.get("salt_md5") or "")
    if smd5:
        needles.append(smd5.encode("ascii", "ignore"))
    needles.append(b"666DingTalk888")
    needles = [n for n in needles if n]

    MEM_COMMIT = 0x1000
    readable = (0x02, 0x04, 0x08, 0x20, 0x40, 0x80)
    PAGE_GUARD, PAGE_NOACCESS = 0x100, 0x01

    class MEMORY_BASIC_INFORMATION64(ctypes.Structure):
        _fields_ = [("BaseAddress", ctypes.c_ulonglong),
                    ("AllocationBase", ctypes.c_ulonglong),
                    ("AllocationProtect", wintypes.DWORD),
                    ("__alignment1", wintypes.DWORD),
                    ("RegionSize", ctypes.c_ulonglong),
                    ("State", wintypes.DWORD),
                    ("Protect", wintypes.DWORD),
                    ("Type", wintypes.DWORD),
                    ("__alignment2", wintypes.DWORD)]

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.restype = ctypes.c_void_p
    k32.VirtualQueryEx.restype = ctypes.c_size_t
    k32.ReadProcessMemory.restype = wintypes.BOOL

    seen = set()
    for pid in _proc_pids():
        ph = k32.OpenProcess(0x0010 | 0x0400, False, pid)  # PROCESS_VM_READ | QUERY_INFORMATION
        if not ph:
            continue
        try:
            addr = 0
            mbi = MEMORY_BASIC_INFORMATION64()
            while True:
                got = k32.VirtualQueryEx(ctypes.c_void_p(ph), ctypes.c_void_p(addr),
                                         ctypes.byref(mbi), ctypes.sizeof(mbi))
                if not got:
                    break
                base, size = mbi.BaseAddress, mbi.RegionSize
                if size == 0:
                    break
                if (mbi.State == MEM_COMMIT and not (mbi.Protect & PAGE_GUARD)
                        and mbi.Protect != PAGE_NOACCESS and (mbi.Protect & 0xFF) in readable
                        and size <= 256 * 1024 * 1024):
                    buf = ctypes.create_string_buffer(size)
                    read = ctypes.c_size_t(0)
                    if k32.ReadProcessMemory(ctypes.c_void_p(ph), ctypes.c_void_p(base),
                                             buf, size, ctypes.byref(read)):
                        data = buf.raw[:read.value]
                        for needle in needles:
                            start = 0
                            while True:
                                j = data.find(needle, start)
                                if j < 0:
                                    break
                                start = j + 1
                                lo = max(0, j - 16384)
                                hi = min(len(data), j + 262144)
                                for key in _printable_runs(data[lo:hi]):
                                    if key in seen:
                                        continue
                                    seen.add(key)
                                    if _aes_ecb_encrypt_block(key, ZERO) == ZERO_CT and key_works(key, db):
                                        return key
                addr = base + size
        except Exception as e:
            sys.stderr.write("scan pid=%s failed: %s: %s\n" % (pid, type(e).__name__, e))
        finally:
            try:
                k32.CloseHandle(ctypes.c_void_p(ph))
            except Exception:
                pass
    return None


def get_key(db):
    """取当前账号库的密钥：缓存 -> 已知密钥 -> 内存扫描；成功后落缓存。"""
    cached = load_json(key_cache_path(), {}) or {}
    for hk in (cached.get("key_hex"),):
        if hk:
            try:
                k = bytes.fromhex(hk)
                if key_works(k, db):
                    return k
            except Exception:
                pass
    for s in KNOWN_KEYS:
        k = s.encode("ascii")
        if key_works(k, db):
            save_json(key_cache_path(), {"key_hex": k.hex(), "source": "known", "ts": int(time.time())})
            return k
    k = scan_memory_for_key(db)
    if k:
        save_json(key_cache_path(), {"key_hex": k.hex(), "source": "memory", "ts": int(time.time())})
        return k
    return None


def decrypt_db_to_temp(key):
    """把 dingtalk.db 与 -wal 解密并**手工按页号合并**到临时目录，返回 (连接, 临时目录)。

    为什么不用 SQLite 自己读 WAL：钉钉的 WAL 校验和是对加密页计算的，解密后
    SQLite 会判定帧校验失败并整段丢弃（表现为「UI 显示已发出、库里查不到」）。
    这里直接按帧头里的页号覆盖解密页，绕开校验和。
    """
    src, _ = db_paths()
    raw = read_shared(src)
    if raw is None:
        raise RuntimeError("无法读取 %s（钉钉未运行或权限不足）" % src)

    pages = bytearray(_aes_ecb_decrypt(key, raw))
    if len(pages) < 100 or bytes(pages[:16]) != SQLITE_MAGIC:
        raise RuntimeError("数据库解密失败（密钥不匹配）")
    page_size = int.from_bytes(bytes(pages[16:18]), "big") or 4096
    if page_size < 512 or page_size > 65536:
        page_size = 4096

    wal = read_shared(src + "-wal")
    applied = 0
    max_page = len(pages) // page_size
    if wal and len(wal) > 32:
        frame = 24 + page_size
        for i in range((len(wal) - 32) // frame):
            off = 32 + i * frame
            if off + frame > len(wal):
                break
            pno = int.from_bytes(bytes(wal[off:off + 4]), "big")
            if pno <= 0:
                continue
            start = (pno - 1) * page_size
            if len(pages) < start + page_size:
                pages.extend(b"\x00" * (start + page_size - len(pages)))
            pages[start:start + page_size] = _aes_ecb_decrypt(key, bytes(wal[off + 24:off + frame]))
            applied += 1
            max_page = max(max_page, pno)
    if len(pages) > max_page * page_size:
        pages = pages[:max_page * page_size]

    tmp = tempfile.mkdtemp(prefix="rmsdd_")
    dst = os.path.join(tmp, "dingtalk.db")
    with open(dst, "wb") as f:
        f.write(bytes(pages))
    # 不写 -wal / -shm：合并后的主库已包含 WAL 的最新页
    conn = sqlite3.connect(dst)
    conn.row_factory = sqlite3.Row
    return conn, tmp


# --------------------------------------------------------------------------- #
# 数据读取
# --------------------------------------------------------------------------- #

def iso(ms):
    try:
        return datetime.datetime.fromtimestamp(int(ms) / 1000.0).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return ""


def content_text(raw):
    """把 content JSON 归一化成可读文本 + contentType。"""
    if not raw:
        return "", None
    try:
        d = json.loads(raw)
    except Exception:
        return str(raw)[:500], None
    ct = d.get("contentType")
    if isinstance(d.get("text"), str) and d["text"].strip():
        return d["text"], ct
    ext = d.get("extension") or {}
    if isinstance(ext, str):
        try:
            ext = json.loads(ext)
        except Exception:
            ext = {}
    for key in ("markdown", "desc", "f_name", "fileName", "title", "content"):
        if isinstance(ext.get(key), str) and ext[key].strip():
            return ext[key], ct
    card = ext.get("interactiveCardLastMessage")
    if isinstance(card, str):
        try:
            cd = json.loads(card)
            for k in ("text", "title", "content"):
                if isinstance(cd.get(k), str) and cd[k].strip():
                    return cd[k], ct
        except Exception:
            return card, ct
    label = {2: "[图片]", 3: "[语音]", 501: "[文件]", 1200: "[Markdown]",
             2950: "[卡片]", 3100: "[富文本]"}.get(ct)
    if label:
        return label, ct
    return (json.dumps(d, ensure_ascii=False)[:300]), ct


def profile_map(conn):
    out = {}
    try:
        for r in conn.execute("select uid, nick, alias, dingtaklId, realName from tbuser_profile_v2"):
            uid = str(r["uid"])
            out[uid] = r["alias"] or r["nick"] or r["realName"] or uid
    except Exception:
        pass
    return out


def self_uid(conn):
    """本机 uid：1:1 会话 cid 里出现最多的那个 token。"""
    freq = {}
    try:
        for r in conn.execute("select cid from tbconversation where type=1"):
            for tok in str(r["cid"]).split(":"):
                freq[tok] = freq.get(tok, 0) + 1
    except Exception:
        return ""
    if not freq:
        return ""
    return max(freq.items(), key=lambda kv: kv[1])[0]


def chat_name(row, self_id, nicks):
    cid = str(row["cid"])
    if row["type"] == 1:
        parts = cid.split(":")
        peer = parts[1] if parts and parts[0] == self_id and len(parts) > 1 else parts[0]
        if cid.split(":")[0] == cid.split(":")[1]:
            return "我自己"
        return nicks.get(peer) or (row["title"] or peer)
    return row["title"] or cid


def shard_table(conn, cid):
    idx = zlib.crc32(str(cid).encode("utf-8")) % SHARD_COUNT
    name = "tbmsg_%03d" % idx
    row = conn.execute("select name from sqlite_master where type='table' and name=?", (name,)).fetchone()
    return name if row else None


def last_message(conn, cid):
    try:
        r = conn.execute(
            "select senderId, createdAt, content from tblastmsg where cid=? order by createdAt desc limit 1",
            (cid,)).fetchone()
        return r
    except Exception:
        return None


def open_store():
    db, _ = db_paths()
    key = get_key(db)
    if not key:
        raise RuntimeError("未能取得数据库密钥（请确认钉钉已登录并运行）")
    return decrypt_db_to_temp(key)


def with_conn(fn):
    conn, tmp = open_store()
    try:
        return fn(conn)
    finally:
        try:
            conn.close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# --------------------------------------------------------------------------- #
# 子命令：doctor
# --------------------------------------------------------------------------- #

def cmd_doctor(payload):
    cfg = load_config()
    out = {
        "python": sys.executable,
        "python_version": sys.version.split()[0],
        "config": cfg,
        "config_path": config_path(),
        "account": _ACCOUNT,
        "account_dir": account_dir(),
        "cursor_path": cursor_path(),
        "account_dirs": account_dir_names(),
        "dingtalk_pids": _proc_pids(),
        "dingtalk_running": bool(_proc_pids()),
        "db_path": db_paths()[0],
        "user_config": db_paths()[1],
    }
    try:
        import cryptography
        out["cryptography_version"] = getattr(cryptography, "__version__", "?")
    except Exception:
        out["cryptography_version"] = None
    try:
        import uiautomation
        out["uiautomation_version"] = getattr(uiautomation, "__version__", "?")
    except Exception:
        out["uiautomation_version"] = None

    try:
        def probe(conn):
            nicks = profile_map(conn)
            sid = self_uid(conn)
            conv = conn.execute("select count(*) c from tbconversation").fetchone()["c"]
            msg_tables = conn.execute(
                "select count(*) c from sqlite_master where type='table' and name like 'tbmsg_%'").fetchone()["c"]
            return {
                "self_uid": sid,
                "self_name": nicks.get(sid, ""),
                "conversation_count": conv,
                "message_shards": msg_tables,
                "profile_count": len(nicks),
            }
        out.update(with_conn(probe))
        out["db_key_ok"] = True
        out["ok"] = True
    except Exception as e:
        out["db_key_ok"] = False
        out["ok"] = False
        out["error"] = "%s: %s" % (type(e).__name__, e)
    return out


# --------------------------------------------------------------------------- #
# 子命令：sessions
# --------------------------------------------------------------------------- #

def cmd_sessions(payload):
    limit = int(payload.get("limit") or 50)
    def run(conn):
        nicks = profile_map(conn)
        sid = self_uid(conn)
        rows = conn.execute(
            "select cid, type, title, unreadCount, memberCount, createAt, lastModify, status "
            "from tbconversation order by lastModify desc, createAt desc limit ?", (max(limit, 1),)
        ).fetchall()
        result = []
        for r in rows:
            lm = last_message(conn, r["cid"])
            text, ct = content_text(lm["content"] if lm else "")
            result.append({
                "cid": r["cid"],
                "type": r["type"],
                "name": chat_name(r, sid, nicks),
                "unread": r["unreadCount"] or 0,
                "member_count": r["memberCount"] or 0,
                "last_time": lm["createdAt"] if lm else (r["lastModify"] or r["createAt"]),
                "last_datetime": iso(lm["createdAt"] if lm else (r["lastModify"] or r["createAt"])),
                "last_sender": nicks.get(str(lm["senderId"]), str(lm["senderId"])) if lm else "",
                "summary": (text or "").replace("\n", " ")[:200],
                "content_type": ct,
            })
        total = conn.execute("select count(*) c from tbconversation").fetchone()["c"]
        return {"ok": True, "count": len(result), "total_listed": total, "sessions": result}
    return with_conn(run)


# --------------------------------------------------------------------------- #
# 子命令：fetch
# --------------------------------------------------------------------------- #

def resolve_targets(conn, entries):
    """把会话名/cid/联系人昵称 解析成 cid 列表。"""
    nicks = profile_map(conn)
    sid = self_uid(conn)
    index = {}
    for r in conn.execute("select cid, type, title from tbconversation"):
        name = chat_name(r, sid, nicks)
        index.setdefault(str(r["cid"]), str(r["cid"]))
        if name:
            index.setdefault(name, str(r["cid"]))
        if r["title"]:
            index.setdefault(str(r["title"]), str(r["cid"]))
    # 联系人昵称 -> 1:1 会话 cid（含「发给自己」的自聊会话）
    if sid:
        index.setdefault(nicks.get(sid, ""), "%s:%s" % (sid, sid))
    for uid, nm in (nicks or {}).items():
        if not nm:
            continue
        index.setdefault(nm, None)
        idx = index[nm]
        if idx is None:
            for r in conn.execute("select cid from tbconversation where type=1"):
                parts = str(r["cid"]).split(":")
                if uid in parts:
                    index[nm] = str(r["cid"])
                    break
            if index[nm] is None:
                index.pop(nm, None)
    out, seen = [], set()
    for e in entries:
        k = str(e).strip()
        if not k:
            continue
        cid = index.get(k, k)
        if cid in seen:
            continue
        seen.add(cid)
        out.append(cid)
    return out


def cmd_fetch(payload):
    cfg = load_config()
    limit_per_chat = int(payload.get("limit_per_chat") or cfg["limit_per_chat"])
    max_chats = int(payload.get("max_chats") or cfg["max_chats"])
    chats_filter = payload.get("chats") or cfg.get("chats") or []
    skip_filter = payload.get("skip_chats") or cfg.get("skip_chats") or []
    content_max = int(cfg.get("content_max_chars") or 4000)
    out_dir = account_dir()
    cursor = load_json(cursor_path(), {}) or {}
    run_date = datetime.datetime.now().strftime("%Y%m%d")
    out_file = os.path.join(out_dir, "rms-dingtalk-%s.ndjson" % run_date)

    def run(conn):
        nicks = profile_map(conn)
        sid = self_uid(conn)
        rows = conn.execute(
            "select cid, type, title from tbconversation order by lastModify desc, createAt desc").fetchall()
        if chats_filter:
            wanted = set(resolve_targets(conn, chats_filter))
            rows = [r for r in rows if str(r["cid"]) in wanted]
        if skip_filter:
            skip = set(resolve_targets(conn, skip_filter))
            rows = [r for r in rows if str(r["cid"]) not in skip]
        if max_chats:
            rows = rows[:max_chats]

        stats = {"ok": True, "chats_total": len(rows), "chats_read": 0,
                 "messages_new": 0, "errors": [], "per_chat": []}
        written = 0
        with open(out_file, "a", encoding="utf-8") as f:
            for r in rows:
                cid = str(r["cid"])
                name = chat_name(r, sid, nicks)
                table = shard_table(conn, cid)
                if not table:
                    stats["errors"].append({"chat": name, "error": "未找到消息分片表"})
                    continue
                since = int((cursor.get(cid) or {}).get("mid") or 0)
                q = ("select localId, mid, senderId, type, createdAt, content, contentType, recallStatus "
                     "from %s where cid=?" % table)
                args = [cid]
                if since:
                    q += " and mid > ?"
                    args.append(since)
                q += " order by mid asc"
                if not since:
                    q += " limit ?"
                    args.append(limit_per_chat)
                try:
                    msgs = conn.execute(q, args).fetchall()
                except Exception as e:
                    stats["errors"].append({"chat": name, "error": "%s: %s" % (type(e).__name__, e)})
                    continue
                fresh = 0
                max_mid = since
                for m in msgs:
                    text, ct = content_text(m["content"])
                    rec = {
                        "account": _ACCOUNT,
                        "cid": cid,
                        "chat_name": name,
                        "chat_type": r["type"],
                        "mid": m["mid"],
                        "local_id": m["localId"],
                        "sender_id": m["senderId"],
                        "sender_name": nicks.get(str(m["senderId"]), str(m["senderId"])),
                        "type": m["type"],
                        "content_type": m["contentType"] if m["contentType"] is not None else ct,
                        "created_at": m["createdAt"],
                        "datetime": iso(m["createdAt"]),
                        "text": (text or "")[:content_max],
                        "content_truncated": bool(text and len(text) > content_max),
                        "recall_status": m["recallStatus"],
                        "raw": (m["content"] or "")[:content_max],
                    }
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    written += 1
                    fresh += 1
                    max_mid = max(max_mid, int(m["mid"] or 0))
                if max_mid > since:
                    cursor[cid] = {"mid": max_mid, "time": iso(max_mid and msgs[-1]["createdAt"] or 0)}
                stats["chats_read"] += 1
                stats["messages_new"] += fresh
                if fresh:
                    stats["per_chat"].append({"chat": name, "new": fresh})
        stats["written"] = written
        stats["output_file"] = out_file
        stats["per_chat"].sort(key=lambda x: x["new"], reverse=True)
        stats["per_chat_top"] = stats["per_chat"][:20]
        del stats["per_chat"]
        return stats

    return with_conn(run)


# --------------------------------------------------------------------------- #
# 子命令：config
# --------------------------------------------------------------------------- #

def cmd_config(payload):
    cfg = load_config()
    setter = payload.get("set")
    if isinstance(setter, dict):
        for k in ("account", "data_dir", "limit_per_chat", "max_chats", "chats",
                  "skip_chats", "content_max_chars"):
            if k in setter:
                cfg[k] = setter[k]
        save_json(config_path(), {k: cfg[k] for k in DEFAULTS})
    return {"ok": True, "config": cfg, "config_path": config_path()}


# --------------------------------------------------------------------------- #
# 发送（UI 自动化）
# --------------------------------------------------------------------------- #

def _user32():
    u = ctypes.WinDLL("user32", use_last_error=True)
    u.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
    u.mouse_event.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
    u.EnumWindows.argtypes = [ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM), wintypes.LPARAM]
    u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    u.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    return u


def _windows(u, pids):
    out = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(h, _):
        pid = wintypes.DWORD()
        u.GetWindowThreadProcessId(h, ctypes.byref(pid))
        if pid.value not in pids:
            return True
        cls = ctypes.create_unicode_buffer(256)
        u.GetClassNameW(h, cls, 256)
        t = ctypes.create_unicode_buffer(256)
        u.GetWindowTextW(h, t, 256)
        r = wintypes.RECT()
        u.GetWindowRect(h, ctypes.byref(r))
        out.append({"hwnd": int(h), "pid": int(pid.value), "class": cls.value, "title": t.value,
                    "visible": bool(u.IsWindowVisible(h)),
                    "rect": [r.left, r.top, r.right, r.bottom]})
        return True

    u.EnumWindows(cb, 0)
    return out


def _click_xy(u, x, y):
    u.SetCursorPos(x, y)
    time.sleep(0.15)
    u.mouse_event(0x0002, 0, 0, 0, None)
    u.mouse_event(0x0004, 0, 0, 0, None)


def _click_ctrl(u, ctrl):
    r = ctrl.BoundingRectangle
    x, y = (r.left + r.right) // 2, (r.top + r.bottom) // 2
    _click_xy(u, x, y)
    return [x, y]


def _clipboard_set(text):
    """写入剪贴板（CF_UNICODETEXT），返回旧文本用于恢复。"""
    u32 = ctypes.WinDLL("user32", use_last_error=True)
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    CF_UNICODETEXT, GMEM_MOVEABLE = 13, 0x0002

    u32.OpenClipboard.argtypes = [wintypes.HWND]
    u32.OpenClipboard.restype = wintypes.BOOL
    u32.CloseClipboard.restype = wintypes.BOOL
    u32.EmptyClipboard.restype = wintypes.BOOL
    u32.GetClipboardData.argtypes = [wintypes.UINT]
    u32.GetClipboardData.restype = wintypes.HANDLE
    u32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    u32.SetClipboardData.restype = wintypes.HANDLE
    k32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    k32.GlobalAlloc.restype = wintypes.HANDLE
    k32.GlobalLock.argtypes = [wintypes.HANDLE]
    k32.GlobalLock.restype = ctypes.c_void_p
    k32.GlobalUnlock.argtypes = [wintypes.HANDLE]
    k32.GlobalUnlock.restype = wintypes.BOOL

    old = None
    if not u32.OpenClipboard(None):
        return None
    try:
        h = u32.GetClipboardData(CF_UNICODETEXT)
        if h:
            p = k32.GlobalLock(h)
            if p:
                old = ctypes.wstring_at(p)
                k32.GlobalUnlock(h)
        u32.EmptyClipboard()
        data = (str(text) + "\x00").encode("utf-16-le")
        hm = k32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        if hm:
            pm = k32.GlobalLock(hm)
            if pm:
                ctypes.memmove(pm, data, len(data))
                k32.GlobalUnlock(hm)
                u32.SetClipboardData(CF_UNICODETEXT, hm)
    finally:
        u32.CloseClipboard()
    return old


def _clipboard_restore(text):
    if text is None:
        return
    try:
        _clipboard_set(text)
    except Exception:
        pass


def _find_main(u, pids):
    best = None
    for w in _windows(u, pids):
        if "QWindowIcon" in w["class"] and w["title"] == "钉钉":
            area = (w["rect"][2] - w["rect"][0]) * (w["rect"][3] - w["rect"][1])
            if area > 300000 and (best is None or area > best[0]):
                best = (area, w)
    return best[1] if best else None


def _find_hit(root, target, exact=True):
    """在 CEF 搜索面板里找目标文本节点并点击。"""
    import uiautomation as auto
    found = []

    def walk(n, d=0):
        if d > 26 or found:
            return
        try:
            kids = n.GetChildren() or []
        except Exception:
            return
        for k in kids:
            try:
                nm = (k.Name or "").strip()
                if (nm == target) if exact else (target in nm):
                    found.append(k)
                    return
            except Exception:
                pass
            walk(k, d + 1)
            if found:
                return

    walk(root)
    return found[0] if found else None


def _debug_shot(name):
    """RMS_DD_DEBUG=1 时把当前屏幕截图落到账号目录，便于排查 UI 自动化。"""
    if os.environ.get("RMS_DD_DEBUG") != "1":
        return
    try:
        from PIL import ImageGrab
        d = os.path.join(account_dir(), "debug")
        os.makedirs(d, exist_ok=True)
        ImageGrab.grab().save(os.path.join(d, "%s_%s.png" % (time.strftime("%H%M%S"), name)))
    except Exception:
        pass


def _send_via_ui(target, text, wait_ms):
    import uiautomation as auto
    u = _user32()
    pids = set(_proc_pids())
    steps = []

    main = _find_main(u, pids)
    if not main:
        return {"ok": False, "error": "未找到钉钉主窗口（请确认钉钉已登录且未完全退出）", "steps": steps}
    hwnd = main["hwnd"]
    u.ShowWindow(hwnd, 9)  # SW_RESTORE
    time.sleep(0.5)
    u.SetForegroundWindow(hwnd)
    u.BringWindowToTop(hwnd)
    time.sleep(0.8)
    steps.append({"step": "restore", "hwnd": hwnd})

    root = auto.ControlFromHandle(hwnd)
    search = auto.EditControl(searchFromControl=root, AutomationId=SEARCH_AID)
    if not search.Exists(2, 0.2):
        return {"ok": False, "error": "未定位到搜索框", "steps": steps}
    steps.append({"step": "search_click", "pos": _click_ctrl(u, search)})
    time.sleep(0.4)

    # 搜索词也走粘贴，避免输入法把中文吞成拼音
    old_clip = _clipboard_set(target)
    try:
        auto.SendKeys("{Ctrl}a", waitTime=0.1)
        auto.SendKeys("{Ctrl}v", waitTime=0.2)
        time.sleep(0.4)
        deadline = time.time() + max(8.0, wait_ms / 1000.0)
        hit = None
        while time.time() < deadline:
            panels = [w for w in _windows(u, pids)
                      if w["visible"] and w["class"] == "Qt51511QWindowToolSaveBits"
                      and 600 < (w["rect"][2] - w["rect"][0]) < 1800
                      and (w["rect"][3] - w["rect"][1]) > 400]
            for p in panels:
                try:
                    c = auto.ControlFromHandle(p["hwnd"])
                    hit = _find_hit(c, target, exact=True) or _find_hit(c, target, exact=False)
                except Exception:
                    hit = None
                if hit:
                    steps.append({"step": "search_panel", "hwnd": p["hwnd"]})
                    break
            if hit:
                break
            time.sleep(0.5)
        if not hit:
            return {"ok": False, "error": "搜索结果中没有找到「%s」" % target, "steps": steps}
        _debug_shot("search_results")
        steps.append({"step": "result_click", "pos": _click_ctrl(u, hit)})
        time.sleep(1.8)
        _debug_shot("after_result_click")

        inp = auto.EditControl(searchFromControl=root, AutomationId=INPUT_AID)
        if not inp.Exists(2, 0.2):
            return {"ok": False, "error": "未定位到消息输入框（会话可能未打开）", "steps": steps}
        steps.append({"step": "input_click", "pos": _click_ctrl(u, inp)})
        time.sleep(0.5)
        _clipboard_set(text)
        auto.SendKeys("{Ctrl}v", waitTime=0.2)
        time.sleep(0.6)
        _debug_shot("typed")
        auto.SendKeys("{Enter}", waitTime=0.2)
        steps.append({"step": "sent"})
        time.sleep(1.5)
        _debug_shot("after_enter")
        return {"ok": True, "steps": steps}
    finally:
        _clipboard_restore(old_clip)


def verify_sent(cid, text, timeout=20):
    """回读库确认最后若干条里出现该文本。"""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            def run(conn):
                table = shard_table(conn, cid)
                if not table:
                    return None
                return conn.execute(
                    "select localId, createdAt, content from %s where cid=? order by mid desc limit 8" % table,
                    (cid,)).fetchall()
            rows = with_conn(run) or []
            last = [{"local_id": r["localId"], "created_at": r["createdAt"],
                     "text": content_text(r["content"])[0][:80]} for r in rows]
            if any(text in content_text(r["content"])[0] for r in rows):
                return True, last
        except Exception as e:
            last = [{"error": "%s: %s" % (type(e).__name__, e)}]
        time.sleep(1.5)
    return False, last


def cmd_send(payload):
    target = str(payload.get("to") or payload.get("chat") or "").strip()
    text = payload.get("text")
    verify = payload.get("verify") is True
    wait_ms = int(payload.get("wait_ms") or 8000)
    if not target:
        return {"ok": False, "error": "缺少 to（目标会话名称）"}
    if not isinstance(text, str) or not text.strip():
        return {"ok": False, "error": "缺少 text（要发送的文本）"}

    def resolve(conn):
        return resolve_targets(conn, [target])

    cids = with_conn(resolve)
    cid = cids[0] if cids else ""
    out = {"ok": True, "to": target, "resolved_cid": cid, "account": _ACCOUNT,
           "text": text, "verify": verify}

    res = _send_via_ui(target, text, wait_ms)
    out["steps"] = res.get("steps", [])
    if res.get("ok") is not True:
        out["ok"] = False
        out["error"] = res.get("error")
        return out

    if verify and cid:
        ok, rows = verify_sent(cid, text)
        out["verified"] = ok
        out["db_tail"] = rows
        if not ok:
            out["ok"] = False
            out["error"] = "UI 已执行发送，但回读数据库未发现该文本"
    return out


# --------------------------------------------------------------------------- #
# 入口
# --------------------------------------------------------------------------- #

COMMANDS = {
    "doctor": cmd_doctor,
    "sessions": cmd_sessions,
    "fetch": cmd_fetch,
    "send": cmd_send,
    "config": cmd_config,
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
        cfg = load_config()
        wanted = args.get("account") or cfg.get("account")
        dirs = account_dir_names()
        if wanted and wanted in dirs:
            _ACCOUNT = wanted
        elif dirs:
            _ACCOUNT = dirs[0]
        else:
            _ACCOUNT = wanted or "default"
    except Exception:
        _ACCOUNT = args.get("account") or "default"

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
