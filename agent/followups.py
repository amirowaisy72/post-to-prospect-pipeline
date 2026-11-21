"""Follow-ups the person asked for ('I'll talk tomorrow')."""

import os
import re
import sqlite3
import threading
from datetime import datetime

_DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "leadhunter.db")
_LOCK = threading.Lock()
_FMT = "%Y-%m-%d %H:%M"
_TOKEN = re.compile(
    r"^SCHEDULE:\s*(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})\s*\|\s*(.*)$", re.I | re.S
)


def _conn():
    c = sqlite3.connect(_DB, timeout=10)
    c.execute(
        "create table if not exists follow_ups "
        "(thread_id text primary key, due_at text not null, name text)"
    )
    return c


def parse(text):
    """'SCHEDULE: 2026-11-14 18:00 | message' -> (due 'YYYY-MM-DD HH:MM', message) or None."""
    m = _TOKEN.match((text or "").strip())
    if not m:
        return None
    try:
        due = datetime.strptime(
            f"{m.group(1)} {int(m.group(2)):02d}:{m.group(3)}", _FMT
        )
    except ValueError:
        return None
    if due <= datetime.now():
        return None
    msg = m.group(4).strip()
    return (due.strftime(_FMT), msg) if msg else None


def save(thread_id, name, due_at):
    with _LOCK:
        c = _conn()
        c.execute(
            "insert or replace into follow_ups (thread_id, due_at, name) values (?,?,?)",
            (thread_id, due_at, name),
        )
        c.commit()
        c.close()


def take_due(thread_id):
    """True (and the entry is removed) when this thread's follow-up time has come."""
    with _LOCK:
        c = _conn()
        row = c.execute(
            "select due_at from follow_ups where thread_id=?", (thread_id,)
        ).fetchone()
        due = bool(row and row[0] <= datetime.now().strftime(_FMT))
        if due:
            c.execute("delete from follow_ups where thread_id=?", (thread_id,))
            c.commit()
        c.close()
        return due


def clear(thread_id):
    with _LOCK:
        c = _conn()
        c.execute("delete from follow_ups where thread_id=?", (thread_id,))
        c.commit()
        c.close()


def pending():
    with _LOCK:
        c = _conn()
        rows = c.execute(
            "select thread_id, name, due_at from follow_ups order by due_at"
        ).fetchall()
        c.close()
    return [{"threadId": r[0], "name": r[1] or "", "dueAt": r[2]} for r in rows]
