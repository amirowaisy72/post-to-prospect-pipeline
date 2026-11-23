"""AI Analysis engine.

Goal: take ALL the scraped data the user selected and find the people
(post authors AND commenters/repliers) who match a free-text description,
with as little wasted AI work as possible.

How it works (code decides what is read, the AI only judges text):
  1. build_people   - every post/comment/reply is grouped by PERSON
                      (one Facebook profile = one entry, all their
                      activity together). Nothing is skipped.
  2. screen (stage 1) - many people per AI call, tiny answer (a score).
  3. judge  (stage 2) - one AI call per promising person with their full
                      activity: score, reason, real quote.
  4. rank   - score + a bonus for recent activity.

Memory: judgements are stored per (criteria, person, activity
fingerprint). A new run on the same criteria only sends people who are
new or who wrote something new; everything else is reused.
The AI never "chooses" posts, so no post is left unused.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import threading
import time
import uuid
from datetime import datetime, timezone

import httpx

BASE = "https://www.facebook.com"
GEMINI = "https://generativelanguage.googleapis.com/v1beta"

SCREEN_MIN = 45  # stage-1 score needed to reach stage 2
MATCH_MIN = 65  # stage-2 score needed to count as a match
MAX_FAILS_IN_ROW = 4  # AI errors in a row before the run is stopped

_SCHEMA = """
CREATE TABLE IF NOT EXISTS analysis_runs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    criteria TEXT NOT NULL DEFAULT '',
    quantity INTEGER NOT NULL DEFAULT 20,
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT '[]',
    rescan INTEGER NOT NULL DEFAULT 0,
    progress TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    matches TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS analysis_people (
    crit_hash TEXT NOT NULL,
    person_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL DEFAULT '',
    stage1 INTEGER,
    stage2 TEXT,
    updated_at TEXT,
    PRIMARY KEY (crit_hash, person_key)
);
CREATE TABLE IF NOT EXISTS analysis_training (
    account_id TEXT NOT NULL DEFAULT '',
    crit_hash TEXT NOT NULL,
    criteria TEXT NOT NULL DEFAULT '',
    rules TEXT NOT NULL DEFAULT '[]',
    categories TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT,
    PRIMARY KEY (account_id, crit_hash)
);
"""

_THINK: dict = {}  # Gemini model -> thinking setting that works
_NO_JSON_MODE: set = set()  # Gemini models that refuse JSON mode
_LOCK = threading.Lock()
_ACTIVE: dict = {}  # run_id -> {"stop": bool}


# ----------------------------------------------------------------------
# small helpers
# ----------------------------------------------------------------------
def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt=None) -> str:
    return (dt or _now()).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse(ts):
    if not ts:
        return None
    try:
        d = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except Exception:
        return None


PROMPT_VERSION = (
    "v2"  # bump when the prompts change: old saved verdicts are then re-checked
)


def crit_hash(criteria: str) -> str:
    norm = re.sub(r"\s+", " ", (criteria or "").strip().lower()) + "|" + PROMPT_VERSION
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()[:16]


def init(db) -> None:
    with db._connect() as conn:
        conn.executescript(_SCHEMA)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(analysis_runs)")}
        if "crit_hash" not in cols:
            conn.execute("ALTER TABLE analysis_runs ADD COLUMN crit_hash TEXT")
        for r in conn.execute(
            "SELECT id, criteria FROM analysis_runs WHERE crit_hash IS NULL"
        ).fetchall():
            conn.execute(
                "UPDATE analysis_runs SET crit_hash=? WHERE id=?",
                (crit_hash(r["criteria"]), r["id"]),
            )
        conn.execute(
            "UPDATE analysis_runs SET status='stopped', error='Agent restarted - resume it', "
            "finished_at=? WHERE status IN ('running','stop-requested')",
            (_iso(),),
        )


# ----------------------------------------------------------------------
# training: the user's answers to clarification questions, per query
# ----------------------------------------------------------------------
def save_training(db, account_id, criteria, rules, categories):
    """Store the user's training for one query (rules + categories)."""
    rules = rules or []
    categories = categories or []
    with db._connect() as conn:
        conn.execute(
            "INSERT INTO analysis_training (account_id, crit_hash, criteria, rules, "
            "categories, updated_at) VALUES (?,?,?,?,?,?) "
            "ON CONFLICT(account_id, crit_hash) DO UPDATE SET criteria=excluded.criteria, "
            "rules=excluded.rules, categories=excluded.categories, "
            "updated_at=excluded.updated_at",
            (
                account_id or "",
                crit_hash(criteria),
                criteria or "",
                json.dumps(rules),
                json.dumps(categories),
                _iso(),
            ),
        )
    return {"criteria": criteria, "rules": rules, "categories": categories}


def get_training(db, account_id, criteria):
    """The saved training for one query, or None when there is none."""
    with db._connect() as conn:
        r = conn.execute(
            "SELECT criteria, rules, categories, updated_at FROM analysis_training "
            "WHERE account_id=? AND crit_hash=?",
            (account_id or "", crit_hash(criteria)),
        ).fetchone()
    if r is None:
        return None
    try:
        rules = json.loads(r["rules"] or "[]")
    except Exception:
        rules = []
    try:
        categories = json.loads(r["categories"] or "[]")
    except Exception:
        categories = []
    return {
        "criteria": r["criteria"],
        "rules": rules if isinstance(rules, list) else [],
        "categories": categories if isinstance(categories, list) else [],
        "updated_at": r["updated_at"],
    }


def training_block(training) -> str:
    """The training as prompt text ("" when there is no training)."""
    if not training:
        return ""
    rules = training.get("rules") or []
    cats = training.get("categories") or []
    if not rules and not cats:
        return ""
    lines = [
        "TRAINING FROM THE USER (answers given before this analysis — follow them exactly):"
    ]
    for r in rules:
        if isinstance(r, dict):
            lines.append(f"Q: {r.get('question') or ''}\nA: {r.get('answer') or ''}")
    if cats:
        lines.append(
            "Tag each match with one of these categories: "
            + ", ".join(str(c) for c in cats)
            + '. Use "other" when none of them fits.'
        )
    return "\n".join(lines)


_RESERVED = {
    "groups",
    "pages",
    "watch",
    "profile.php",
    "photo",
    "photos",
    "posts",
    "permalink.php",
    "story.php",
    "hashtag",
    "share",
    "reel",
    "reels",
    "events",
    "marketplace",
    "people",
    "friends",
    "stories",
    "gaming",
    "login",
    "help",
    "policies",
}


def person_ident(url: str, name: str):
    """(key, canonical profile url) for a Facebook profile link, or
    (None, '') when the link says nothing about who the person is."""
    u = (url or "").strip()
    if not u:
        return None, ""
    m = re.search(r"/user/(\d{5,})", u) or (
        re.search(r"[?&]id=(\d{5,})", u) if "profile.php" in u else None
    )
    if m:
        return "id:" + m.group(1), f"{BASE}/profile.php?id={m.group(1)}"
    m = re.match(r"https?://[^/]+/([^/?#]+)", u)
    if m and m.group(1).lower() not in _RESERVED:
        seg = m.group(1)
        return "u:" + seg.lower(), f"{BASE}/{seg}"
    return None, ""


def recency_bonus(last, now=None) -> int:
    d = _parse(last)
    if not d:
        return 0
    days = max(0.0, ((now or _now()) - d).total_seconds() / 86400)
    for limit, pts in ((3, 15), (7, 12), (14, 9), (30, 5), (60, 2)):
        if days <= limit:
            return pts
    return 0


def _clip(text: str, n: int) -> str:
    t = re.sub(r"\s+", " ", (text or "")).strip()
    return t if len(t) <= n else t[: n - 1] + "…"


def _norm(t: str) -> str:
    return re.sub(r"\W+", "", (t or "").lower())


# ----------------------------------------------------------------------
# 1. data -> people
# ----------------------------------------------------------------------
def _chunks(seq, n=400):
    for i in range(0, len(seq), n):
        yield seq[i : i + n]


def exclude_keys(urls) -> set:
    """Person keys of profile links (e.g. everyone already in Leads)."""
    out = set()
    for u in urls or []:
        k, _ = person_ident(str(u or ""), "")
        if k:
            out.add(k)
    return out


def build_people(db, source_ids, own_name=""):
    source_ids = [s for s in (source_ids or []) if s]
    stats = {"posts": 0, "comments": 0, "replies": 0, "no_link": 0}
    people: dict = {}
    if not source_ids:
        return people, stats
    own = (own_name or "").strip().lower()

    def add(url, name, item):
        key, purl = person_ident(url, name)
        if not key:
            stats["no_link"] += 1
            return
        if own and (name or "").strip().lower() == own:
            return
        p = people.get(key)
        if p is None:
            p = people[key] = {"key": key, "name": name or "", "url": purl, "items": []}
        if name and not p["name"]:
            p["name"] = name
        p["items"].append(item)

    with db._connect() as conn:
        q = ",".join("?" * len(source_ids))
        posts = [
            dict(r)
            for r in conn.execute(
                "SELECT p.id, p.post_url, p.author_name, p.author_url, p.text, p.collected_at, "
                "s.name AS source_name FROM posts p LEFT JOIN sources s ON s.id = p.source_id "
                f"WHERE p.source_id IN ({q})",
                source_ids,
            ).fetchall()
        ]
        stats["posts"] = len(posts)
        by_id = {p["id"]: p for p in posts}
        for p in posts:
            title = f"{p['author_name'] or 'Post'}"
            p["title"] = title + (
                f" · {p['source_name']}" if p.get("source_name") else ""
            )
            add(
                p["author_url"],
                p["author_name"],
                {
                    "kind": "post",
                    "text": p["text"] or "",
                    "time": p["collected_at"],
                    "post_id": p["id"],
                    "parent": "",
                },
            )
        ids = list(by_id)
        for chunk in _chunks(ids):
            qq = ",".join("?" * len(chunk))
            for c in conn.execute(
                "SELECT id, post_id, author_name, author_url, text, posted_at FROM comments "
                f"WHERE post_id IN ({qq})",
                chunk,
            ).fetchall():
                stats["comments"] += 1
                post = by_id.get(c["post_id"]) or {}
                add(
                    c["author_url"],
                    c["author_name"],
                    {
                        "kind": "comment",
                        "text": c["text"] or "",
                        "time": c["posted_at"] or post.get("collected_at"),
                        "post_id": c["post_id"],
                        "parent": "",
                    },
                )
            for r in conn.execute(
                "SELECT r.author_name, r.author_url, r.text, r.posted_at, c.post_id, "
                "c.text AS parent_text FROM replies r JOIN comments c ON r.comment_id = c.id "
                f"WHERE c.post_id IN ({qq})",
                chunk,
            ).fetchall():
                stats["replies"] += 1
                post = by_id.get(r["post_id"]) or {}
                add(
                    r["author_url"],
                    r["author_name"],
                    {
                        "kind": "reply",
                        "text": r["text"] or "",
                        "time": r["posted_at"] or post.get("collected_at"),
                        "post_id": r["post_id"],
                        "parent": r["parent_text"] or "",
                    },
                )

    for p in people.values():
        p["items"] = [i for i in p["items"] if (i["text"] or "").strip()]
        p["items"].sort(
            key=lambda i: (
                _parse(i["time"]) or datetime.min.replace(tzinfo=timezone.utc)
            ),
            reverse=True,
        )
        times = [t for t in (_parse(i["time"]) for i in p["items"]) if t]
        p["last"] = _iso(max(times)) if times else None
        sig = "\n".join(sorted(f"{i['kind']}:{i['text']}" for i in p["items"]))
        p["fp"] = hashlib.sha1(sig.encode("utf-8")).hexdigest()[:16]
        p["has_post"] = any(i["kind"] == "post" for i in p["items"])
        p["posts_by_id"] = {
            pid: by_id[pid]
            for pid in {i["post_id"] for i in p["items"]}
            if pid in by_id
        }
    people = {k: v for k, v in people.items() if v["items"]}
    return people, stats


def _is_trivial(p) -> bool:
    if p["has_post"]:
        return False
    return not re.search(r"[^\W\d_]", " ".join(i["text"] for i in p["items"]))


def dossier(p, limit: int, per_item: int = 300) -> str:
    """The person's activity as plain text for the AI (newest first, posts first)."""
    items = sorted(p["items"], key=lambda i: 0 if i["kind"] == "post" else 1)
    out, used = [], 0
    for it in items:
        post = p["posts_by_id"].get(it["post_id"]) or {}
        if it["kind"] == "post":
            head = f'[POST written by this person in "{post.get("source_name") or "a group"}"]'
        elif it["kind"] == "comment":
            head = f'[COMMENT on a post: "{_clip(post.get("text"), 120)}"]'
        else:
            head = f'[REPLY to a comment: "{_clip(it.get("parent"), 100)}"]'
        line = f"{head} {_clip(it['text'], per_item)}"
        if used + len(line) > limit and out:
            break
        out.append(line)
        used += len(line)
    return "\n".join(out)


# ----------------------------------------------------------------------
# 2. AI calls
# ----------------------------------------------------------------------
_GAP = 6.5  # seconds between Gemini calls (free tier allows ~10 per minute)
_LAST = [0.0]


def _pace() -> None:
    gap = _LAST[0] + _GAP - time.time()
    if gap > 0:
        time.sleep(gap)
    _LAST[0] = time.time()


def _tell(cfg, msg: str) -> None:
    print(f"analysis: {msg}", flush=True)
    note = cfg.get("note")
    if note:
        try:
            note(msg)
        except Exception:
            pass


def _llm(cfg, prompt: str):
    """(text, error). JSON mode, low temperature, big context for Ollama."""
    if cfg["provider"] == "ollama":
        try:
            r = httpx.post(
                (cfg.get("ollamaUrl") or "http://127.0.0.1:11434").rstrip("/")
                + "/api/generate",
                json={
                    "model": cfg["model"],
                    "prompt": prompt,
                    "stream": False,
                    "format": "json",
                    "options": {"temperature": 0.1, "num_ctx": 8192},
                },
                timeout=cfg.get("timeout", 600),
            )
            if r.status_code != 200:
                return "", f"Ollama HTTP {r.status_code}: {r.text[:150]}"
            return (r.json().get("response") or "").strip(), ""
        except Exception as e:  # noqa: BLE001
            return "", f"Ollama {type(e).__name__}: {e}"
    key = (cfg.get("geminiKey") or "").strip()
    if not key:
        return "", "Gemini key missing"
    err = ""
    for attempt in range(7):
        gen = {"temperature": 0.1, "maxOutputTokens": 2048}
        think = _THINK.get(
            cfg["model"], 0
        )  # 0: level low, 1: budget 0, 2: model default
        if think == 0:
            gen["thinkingConfig"] = {"thinkingLevel": "low"}
        elif think == 1:
            gen["thinkingConfig"] = {"thinkingBudget": 0}
        if cfg["model"] not in _NO_JSON_MODE:
            gen["responseMimeType"] = "application/json"
        _pace()
        try:
            r = httpx.post(
                f"{GEMINI}/models/{cfg['model']}:generateContent",
                headers={"x-goog-api-key": key, "Content-Type": "application/json"},
                json={
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": gen,
                },
                timeout=cfg.get("timeout", 150),
            )
        except Exception as e:  # noqa: BLE001
            err = f"{type(e).__name__}: {e}"
            if cfg.get("quick"):
                return "", f"Gemini {err[:80]}"
            _tell(
                cfg,
                f"Gemini is not responding ({err[:60]}) - retrying {attempt + 1}/7",
            )
            time.sleep(3 * (attempt + 1))
            continue
        if r.status_code == 200:
            parts = (r.json().get("candidates") or [{}])[0].get("content", {}).get(
                "parts"
            ) or []
            text = "".join(
                p.get("text", "") for p in parts if isinstance(p, dict)
            ).strip()
            return text, "" if text else "Gemini returned an empty reply"
        err = f"Gemini HTTP {r.status_code}: {r.text[:150]}"
        if (
            r.status_code == 400
            and "think" in r.text.lower()
            and _THINK.get(cfg["model"], 0) < 2
        ):
            _THINK[cfg["model"]] = (
                _THINK.get(cfg["model"], 0) + 1
            )  # try the next thinking setting
            continue
        if (
            r.status_code == 400
            and "JSON mode" in r.text
            and cfg["model"] not in _NO_JSON_MODE
        ):
            _NO_JSON_MODE.add(
                cfg["model"]
            )  # this model cannot do JSON mode: retry as plain text
            continue
        if r.status_code not in (429, 500, 502, 503, 504):
            break
        if cfg.get("quick"):
            return "", err
        wait = 15 if r.status_code == 429 else 3 * (attempt + 1)
        if r.status_code == 429:
            if "PerDay" in r.text:
                return (
                    "",
                    "Gemini's free limit for today is used up (it resets tomorrow, or use another model/key)",
                )
            m = re.search(r'"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"', r.text)
            wait = min(90, int(float(m.group(1))) + 2) if m else 30
        _tell(
            cfg,
            f"Gemini busy/limit (HTTP {r.status_code}) - retrying in {wait}s ({attempt + 1}/7)",
        )
        time.sleep(wait)
    return "", err


def _json_of(text: str):
    t = (text or "").strip()
    t = re.sub(r"^```(?:json)?|```$", "", t, flags=re.M).strip()
    for cand in (
        t,
        t[t.find("{") : t.rfind("}") + 1],
        t[t.find("[") : t.rfind("]") + 1],
    ):
        if not cand:
            continue
        try:
            return json.loads(cand)
        except Exception:
            continue
    return None


_RULES = (
    "Texts may be English, Roman Urdu/Hindi, Bangla or mixed - understand the meaning, not only keywords.\n"
    "A person is a match ONLY if THEIR OWN words show the need/interest described above. "
    "A person who POSTED about the need counts as much as a commenter.\n"
    "NOT a match (score 0-20):\n"
    "- people promoting their own channel/page/link/service ('subscribe back', 'sub4sub', 'follow me', "
    "a link plus 'subscribe'), advertisers, sellers, spammers;\n"
    "- bare replies such as 'Yes', 'Me', 'Done', 'Ok', 'Interested', 'Same' that only answer a bait/giveaway/"
    "promotion post and state no need of their own;\n"
    "- people who only give tips or advice to others, or only like/thank/compliment.\n"
    "Be strict: most people in a group do NOT match, so most scores must be low."
)


def _screen_prompt(criteria: str, batch, training=None) -> str:
    blocks = "\n\n".join(
        f"### {n}\n{dossier(p, 700, 220)}" for n, p in enumerate(batch, 1)
    )
    tb = training_block(training)
    return (
        "You screen Facebook people for a lead list.\n\n"
        f"WHAT THE USER IS LOOKING FOR:\n{criteria}\n\n{_RULES}\n\n"
        + (tb + "\n\n" if tb else "")
        + "Score 0-20 when the person only gives advice, sells/promotes, or wants something else than the thing described.\n"
        "For EVERY person below give a score 0-100: 0-20 no match, 21-44 weak, 45-70 possible, 71-100 clearly states the need.\n"
        'Return ONLY JSON like {"results":[{"i":1,"s":80},{"i":2,"s":0}]} and include every person.\n\n'
        f"PEOPLE:\n\n{blocks}\n"
    )


def _judge_prompt(criteria: str, p, training=None) -> str:
    tb = training_block(training)
    return (
        "You decide whether ONE Facebook person matches what the user is looking for.\n\n"
        f"WHAT THE USER IS LOOKING FOR:\n{criteria}\n\n{_RULES}\n\n"
        + (tb + "\n\n" if tb else "")
        + f"EVERYTHING THIS PERSON WROTE:\n{dossier(p, 3000, 600)}\n\n"
        "A match ONLY when the person wants to buy the SAME thing as the query describes. "
        "Wanting a different thing, giving advice, selling or promoting, or a bare reply "
        "('Yes', 'Me', 'Inbox price' with no clear buying intent) is NOT a match, "
        "however high the score would otherwise be.\n"
        "Scoring: 90-100 = their own words clearly state the need; 70-89 = strongly implied; "
        "40-69 = weak or unclear; 0-39 = no match. Do not give every person the same score.\n"
        'Return ONLY JSON: {"wants_to_buy":true or false,'
        '"wants_query_thing":true or false,'
        '"wanted_thing":"what the person wants, in a few words",'
        '"gives_advice":true or false,"sells_or_promotes":true or false,'
        '"bare_reply":true or false,'
        '"evidence":"explicit" or "implied" or "none","promo":true or false,'
        '"score":0-100,"match":true or false,"role":"poster" or "commenter",'
        '"category":"one of the training categories, or \\"other\\"",'
        '"reason":"1-2 short sentences why, in the same language as the user description",'
        '"quote":"exact words copied from the person text above that show the buying intent (max 200 chars); empty if none"}'
    )


def _screen(cfg, criteria, batch, training=None):
    """-> ({index: score}, error). Missing indexes are simply not returned."""
    text, err = _llm(cfg, _screen_prompt(criteria, batch, training))
    if err:
        return {}, err
    data = _json_of(text)
    rows = []
    if isinstance(data, dict):
        rows = data.get("results") or data.get("people") or []
    elif isinstance(data, list):
        rows = data
    out = {}
    for r in rows if isinstance(rows, list) else []:
        try:
            i = int(r.get("i") if "i" in r else r.get("id"))
            s = int(float(r.get("s") if "s" in r else r.get("score")))
            if 1 <= i <= len(batch):
                out[i] = max(0, min(100, s))
        except Exception:
            continue
    if not out:  # last resort: pull pairs out of broken JSON
        for i, s in re.findall(r'"i"\s*:\s*(\d+)\D{1,12}"s"\s*:\s*(\d+)', text or ""):
            if 1 <= int(i) <= len(batch):
                out[int(i)] = max(0, min(100, int(s)))
    return out, "" if out else "Could not understand the AI's reply"


def _reference(p, where):
    """The full reference behind a verdict: the evidence item + its post."""
    post = p["posts_by_id"].get(where["post_id"]) or {}
    return {
        "postText": _clip(post.get("text") or "", 1000),
        "itemText": _clip(where["text"] or "", 600),
        "itemKind": where["kind"],
        "parentText": _clip(where.get("parent") or "", 300),
        "sourceName": post.get("source_name") or "",
        "postUrl": post.get("post_url") or "",
        "postTitle": post.get("title") or "",
    }


def _judge(cfg, criteria, p, training=None):
    text, err = _llm(cfg, _judge_prompt(criteria, p, training))
    if err:
        return None, err
    d = _json_of(text)
    if isinstance(d, list) and d:
        d = d[0]
    if not isinstance(d, dict):
        return None, "Could not understand the AI's reply"
    try:
        score = int(float(d.get("score")))
    except Exception:
        return None, "score missing"
    quote = _clip(str(d.get("quote") or ""), 220)
    # keep only quotes that really exist in the person's text; else use the best real text
    where = None
    nq = _norm(quote)
    if nq:
        for it in p["items"]:
            if nq[:40] in _norm(it["text"]):
                where = it
                break
    quote_verified = where is not None
    if where is None:
        where = next((i for i in p["items"] if i["kind"] == "post"), None) or max(
            p["items"], key=lambda i: len(i["text"])
        )
        quote = _clip(where["text"], 220)
    evidence = str(d.get("evidence") or "").lower()
    # strict checklist: a reply missing these keys is treated as "no" on every
    # check, so an old-style model answer can never pass as a match.
    wants_to_buy = bool(d.get("wants_to_buy"))
    wants_query_thing = bool(d.get("wants_query_thing"))
    wanted_thing = _clip(str(d.get("wanted_thing") or ""), 200)
    gives_advice = bool(d.get("gives_advice"))
    sells_or_promotes = bool(d.get("sells_or_promotes"))
    bare_reply = bool(d.get("bare_reply"))
    promo = bool(d.get("promo")) or sells_or_promotes
    if evidence == "implied":
        score = min(score, 78)
    if promo or evidence == "none":
        score = min(score, 30)
    role = "poster" if where["kind"] == "post" else "commenter"
    post = p["posts_by_id"].get(where["post_id"]) or {}
    cats = (training or {}).get("categories") or []
    category = str(d.get("category") or "").strip()
    if cats:
        category = category if category in cats else "other"
    elif not category:
        category = "other"
    match = (
        wants_to_buy
        and wants_query_thing
        and not gives_advice
        and not sells_or_promotes
        and not bare_reply
        and evidence in ("explicit", "implied")
        and score >= MATCH_MIN
        and quote_verified
    )
    return {
        "score": max(0, min(100, score)),
        "match": match,
        "evidence": evidence,
        "promo": promo,
        "role": role,
        "reason": _clip(str(d.get("reason") or ""), 300),
        "quote": quote,
        "where": where["kind"],
        "postId": where["post_id"],
        "postUrl": post.get("post_url") or "",
        "postTitle": post.get("title") or "",
        "wants_to_buy": wants_to_buy,
        "wants_query_thing": wants_query_thing,
        "wanted_thing": wanted_thing,
        "gives_advice": gives_advice,
        "sells_or_promotes": sells_or_promotes,
        "bare_reply": bare_reply,
        "category": category,
        "quote_verified": quote_verified,
        "reference": _reference(p, where),
    }, ""


# ----------------------------------------------------------------------
# 3. runs (one record per query + data scope; stop / resume / shrink)
# ----------------------------------------------------------------------
def _match_row(p, v):
    bonus = recency_bonus(p["last"])
    return {
        "personKey": p["key"],
        "name": p["name"],
        "profileUrl": p["url"],
        "score": v["score"],
        "bonus": bonus,
        "combined": min(115, v["score"] + bonus),
        "role": v["role"],
        "reason": v["reason"],
        "quote": v["quote"],
        "where": v["where"],
        "postId": v["postId"],
        "postUrl": v["postUrl"],
        "postTitle": v["postTitle"],
        "category": v.get("category") or "other",
        "reference": v.get("reference") or {},
        "lastActiveAt": p["last"],
        "activityCount": len(p["items"]),
    }


def _save_run(db, run_id, **fields):
    cols, vals = [], []
    for k, v in fields.items():
        cols.append(f"{k}=?")
        vals.append(json.dumps(v) if k in ("progress", "matches", "scope") else v)
    with db._connect() as conn:
        conn.execute(
            f"UPDATE analysis_runs SET {', '.join(cols)} WHERE id=?", (*vals, run_id)
        )


def _get_row(db, run_id):
    with db._connect() as conn:
        r = conn.execute("SELECT * FROM analysis_runs WHERE id=?", (run_id,)).fetchone()
    return dict(r) if r else None


def start_run(db, params: dict):
    """Start (or restart) the record for this query + data. Returns (run_id, error).

    The same query on the same data always reuses ONE record, so the user
    never ends up with duplicates; already judged people are remembered."""
    with _LOCK:
        if _ACTIVE:
            return (
                None,
                "An analysis is already running - stop it first, then run this one",
            )
        criteria = (params.get("criteria") or "").strip()
        sources = sorted({s for s in (params.get("sourceIds") or []) if s})
        if not criteria:
            return None, "Criteria is required"
        if not sources:
            return None, "Choose at least one source"
        ch = crit_hash(criteria)
        account = params.get("accountId") or ""
        quantity = max(1, int(params.get("quantity") or 20))
        progress = json.dumps({"stage": "loading", "message": "Loading data…"})
        with db._connect() as conn:
            run_id = params.get("runId") or ""
            if not run_id:
                for r in conn.execute(
                    "SELECT id, scope FROM analysis_runs WHERE account_id=? AND crit_hash=?",
                    (account, ch),
                ).fetchall():
                    if sorted(json.loads(r["scope"] or "[]")) == sources:
                        run_id = r["id"]
                        break
            if run_id:
                conn.execute(
                    "UPDATE analysis_runs SET status='running', finished_at=NULL, error=NULL, quantity=?, "
                    "provider=?, model=?, rescan=?, progress=? WHERE id=?",
                    (
                        quantity,
                        params.get("provider") or "",
                        params.get("model") or "",
                        1 if params.get("rescan") else 0,
                        progress,
                        run_id,
                    ),
                )
            else:
                run_id = uuid.uuid4().hex
                conn.execute(
                    "INSERT INTO analysis_runs (id, account_id, created_at, criteria, quantity, "
                    "provider, model, scope, rescan, progress, crit_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        run_id,
                        account,
                        _iso(),
                        criteria,
                        quantity,
                        params.get("provider") or "",
                        params.get("model") or "",
                        json.dumps(sources),
                        1 if params.get("rescan") else 0,
                        progress,
                        ch,
                    ),
                )
        _ACTIVE[run_id] = {
            "stop": False,
            "quantity": quantity,
            "early": bool(params.get("early")),
            "finish": False,
        }
    params = {**params, "criteria": criteria, "sourceIds": sources}
    threading.Thread(target=_worker, args=(db, run_id, params), daemon=True).start()
    return run_id, ""


def resume_run(db, run_id, extra: dict):
    row = _get_row(db, run_id)
    if row is None:
        return None, "Analysis not found"
    params = {
        "accountId": row["account_id"],
        "criteria": row["criteria"],
        "sourceIds": json.loads(row["scope"] or "[]"),
        "quantity": row["quantity"],
        "provider": row["provider"],
        "model": row["model"],
        "rescan": False,
        "runId": run_id,
    }
    params.update({k: v for k, v in (extra or {}).items() if v not in (None, "")})
    params["rescan"] = False
    stop_at = int(params.pop("stopAt", 0) or 0)
    if stop_at >= 1:  # user wants: stop (and complete) once N matches exist
        params["quantity"] = stop_at
        params["early"] = True
    return start_run(db, params)


def request_stop(db, run_id) -> bool:
    with _LOCK:
        st = _ACTIVE.get(run_id)
        if not st:
            return False
        st["stop"] = True
    _save_run(db, run_id, status="stop-requested")
    return True


def set_quantity(db, run_id, quantity: int):
    """While a run is live the user can set 'stop at N matches' (any N >= 1).
    As soon as N matches exist the run stops and counts as complete."""
    with _LOCK:
        st = _ACTIVE.get(run_id)
        if not st:
            return False, "This analysis is not running right now"
        quantity = int(quantity)
        if quantity < 1:
            return False, "At least 1"
        st["quantity"] = quantity
        st["early"] = True
    _save_run(db, run_id, quantity=quantity)
    return True, ""


def delete_run(db, run_id) -> bool:
    with _LOCK:
        if run_id in _ACTIVE:
            return False
    with db._connect() as conn:
        row = conn.execute(
            "SELECT crit_hash FROM analysis_runs WHERE id=?", (run_id,)
        ).fetchone()
        conn.execute("DELETE FROM analysis_runs WHERE id=?", (run_id,))
        ch = row[0] if row else None
        # last run of this query gone -> forget its verdicts too, so a new run starts truly fresh
        if (
            ch
            and not conn.execute(
                "SELECT 1 FROM analysis_runs WHERE crit_hash=? LIMIT 1", (ch,)
            ).fetchone()
        ):
            conn.execute("DELETE FROM analysis_people WHERE crit_hash=?", (ch,))
    return True


def _worker(db, run_id, params):
    st = _ACTIVE[run_id]
    prog = {
        "stage": "loading",
        "message": "Loading data…",
        "people": 0,
        "trivial": 0,
        "excluded": 0,
        "reused": 0,
        "toScreen": 0,
        "backlog": 0,
        "backlogDone": 0,
        "screened": 0,
        "candidates": 0,
        "judged": 0,
        "matches": 0,
        "failed": 0,
        "posts": 0,
        "comments": 0,
        "replies": 0,
        "stopAt": 0,
    }
    prog["stopAt"] = st["quantity"] if st["early"] else 0
    prev = _get_row(db, run_id) or {}
    matches: dict = {m["personKey"]: m for m in json.loads(prev.get("matches") or "[]")}
    status, error = "done", None
    ctl = {"fails": 0, "failed": None}
    try:
        cfg = {
            "provider": params.get("provider") or "ollama",
            "model": params.get("model") or "",
            "geminiKey": params.get("geminiKey") or "",
            "ollamaUrl": params.get("ollamaUrl") or "",
        }
        criteria = params["criteria"].strip()
        ch = crit_hash(criteria)
        training = params.get("training") or get_training(
            db, params.get("accountId") or "", criteria
        )
        prog["training"] = {
            "rules": len((training or {}).get("rules") or []),
            "categories": (training or {}).get("categories") or [],
        }
        rescan = bool(params.get("rescan"))
        excl = exclude_keys(params.get("excludeUrls"))
        with db._connect() as conn:
            row = conn.execute(
                "SELECT facebook_name FROM accounts WHERE id=?",
                (params.get("accountId") or "",),
            ).fetchone()
            own = (row["facebook_name"] if row else "") or ""
        people, stats = build_people(db, params["sourceIds"], own)
        prog.update(
            posts=stats["posts"],
            comments=stats["comments"],
            replies=stats["replies"],
            people=len(people),
        )
        kept = {k: v for k, v in people.items() if k not in excl}
        prog["excluded"] = len(people) - len(kept)
        people = kept

        def push(msg=None):
            if msg:
                prog["message"] = msg
            prog["matches"] = len(matches)
            _save_run(
                db,
                run_id,
                progress=prog,
                matches=sorted(matches.values(), key=lambda m: -m["combined"]),
            )

        cfg["note"] = lambda m: (prog.__setitem__("message", m), push())

        # quick check: is the chosen model alive at all? (fails fast with a clear reason)
        push("Checking the model…")
        t0 = time.time()
        _, perr = _llm(
            {**cfg, "quick": True, "timeout": 45}, 'Reply with JSON only: {"ok": true}'
        )
        if perr:
            raise RuntimeError(
                f"This model is not responding right now ({perr}). Choose another model in Configurations."
            )
        print(f"analysis: model check ok in {time.time() - t0:.0f}s", flush=True)

        known = {}
        if not rescan:
            with db._connect() as conn:
                for r in conn.execute(
                    "SELECT person_key, fingerprint, stage1, stage2 FROM analysis_people "
                    "WHERE crit_hash=?",
                    (ch,),
                ).fetchall():
                    known[r["person_key"]] = dict(r)

        backlog, todo_screen = (
            [],
            [],
        )  # backlog: (stage1 score, person) already screened earlier
        for key, p in people.items():
            if _is_trivial(p):
                prog["trivial"] += 1
                continue
            k = known.get(key)
            if k and k["fingerprint"] == p["fp"]:
                if k["stage2"]:
                    v = json.loads(k["stage2"])
                    prog["reused"] += 1
                    if v.get("match"):
                        matches[key] = _match_row(p, v)
                    else:
                        matches.pop(key, None)
                    continue
                if k["stage1"] is not None and k["stage1"] < SCREEN_MIN:
                    prog["reused"] += 1
                    matches.pop(key, None)
                    continue
                if k["stage1"] is not None:
                    backlog.append((k["stage1"], p))
                    continue
            todo_screen.append(p)

        backlog.sort(key=lambda t: -t[0])
        todo_screen.sort(key=lambda p: p["last"] or "", reverse=True)
        prog.update(
            stage="working",
            toScreen=len(todo_screen),
            backlog=len(backlog),
            candidates=len(backlog),
        )
        push(
            f"{len(todo_screen)} new/changed people will be screened, {len(backlog)} are ready for a detail check."
        )

        def upsert(p, s1=None, s2=None):
            with db._connect() as conn:
                conn.execute(
                    "INSERT INTO analysis_people (crit_hash, person_key, fingerprint, stage1, stage2, "
                    "updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(crit_hash, person_key) DO UPDATE SET "
                    "fingerprint=excluded.fingerprint, stage1=COALESCE(excluded.stage1, stage1), "
                    "stage2=excluded.stage2, updated_at=excluded.updated_at",
                    (ch, p["key"], p["fp"], s1, json.dumps(s2) if s2 else None, _iso()),
                )

        def should_end() -> bool:
            prog["stopAt"] = st["quantity"] if st["early"] else 0
            if st["early"] and len(matches) >= st["quantity"]:
                st["finish"] = True
            return bool(st["stop"] or st["finish"] or ctl["failed"])

        def judge_one(s1, p) -> bool:
            """True = keep going."""
            t1 = time.time()
            v, err = _judge(cfg, criteria, p, training)
            print(
                f"analysis: judged {p['name'][:30]} in {time.time() - t1:.0f}s err={err[:80]}",
                flush=True,
            )
            if v is None:
                ctl["fails"] += 1
                prog["failed"] += 1
                prog["lastError"] = err
                if ctl["fails"] >= MAX_FAILS_IN_ROW:
                    ctl["failed"] = f"AI kept failing: {err}"
                    return False
                return True
            ctl["fails"] = 0
            upsert(p, s1=s1, s2=v)
            prog["judged"] += 1
            if v["match"]:
                matches[p["key"]] = _match_row(p, v)
            else:
                matches.pop(p["key"], None)
            push(
                f"Detail check: {prog['judged']} / {prog['candidates']} · matches {len(matches)}"
            )
            return True

        # 1) people screened in an earlier run but never judged
        for s1, p in backlog:
            if should_end():
                break
            if not judge_one(s1, p):
                break
            prog["backlogDone"] += 1

        # 2) screen the rest in batches; judge each batch's promising people right away,
        #    so matches show up early and the target can be reached sooner.
        bsize = 6 if cfg["provider"] == "ollama" else 12
        for i in range(0, len(todo_screen), bsize):
            if should_end():
                break
            batch = todo_screen[i : i + bsize]
            t0 = time.time()
            print(
                f"analysis: screening batch {i // bsize + 1}/{math.ceil(len(todo_screen) / bsize)} ({len(batch)} people)",
                flush=True,
            )
            scores, err = _screen(cfg, criteria, batch, training)
            if len(scores) < len(batch) / 2 and not err:
                scores, err = _screen(cfg, criteria, batch, training)  # one retry
            print(
                f"analysis: batch done in {time.time() - t0:.0f}s, got {len(scores)} scores, err={err[:80]}",
                flush=True,
            )
            if err and not scores:
                ctl["fails"] += 1
                prog["failed"] += len(batch)
                prog["lastError"] = err
                if ctl["fails"] >= MAX_FAILS_IN_ROW:
                    ctl["failed"] = f"AI kept failing: {err}"
                    break
                push()
                continue
            ctl["fails"] = 0
            promising = []
            for n, p in enumerate(batch, 1):
                if n in scores:
                    upsert(p, s1=scores[n])
                    prog["screened"] += 1
                    if scores[n] >= SCREEN_MIN:
                        promising.append((scores[n], p))
                else:
                    prog["failed"] += 1
            promising.sort(key=lambda t: -t[0])
            prog["candidates"] += len(promising)
            push(f"Screening: {prog['screened']} / {prog['toScreen']} people")
            for s1, p in promising:
                if should_end():
                    break
                if not judge_one(s1, p):
                    break

        should_end()
        if ctl["failed"]:
            status, error = "failed", ctl["failed"]
        elif st["stop"]:
            status = "stopped"
        n = len(matches)
        if status == "done" and st["finish"]:
            prog["partial"] = True
            prog["message"] = (
                f"Target reached: {n} matching people found. The rest were not checked - "
                "you can Resume to check the rest too."
            )
        else:
            prog["message"] = {
                "done": f"Complete: {n} matching people found.",
                "stopped": f"Stopped: {n} matching people found so far. Resume will continue from here.",
                "failed": f"Failed: {error}. {n} matching people found so far. You can resume.",
            }[status]
        prog["stage"] = "done" if status == "done" else status
    except Exception as e:  # noqa: BLE001
        status, error = "failed", f"{type(e).__name__}: {e}"
        prog["message"] = f"Fail: {error}"
    finally:
        try:
            _save_run(
                db,
                run_id,
                status=status,
                error=error,
                finished_at=_iso(),
                progress=prog,
                matches=sorted(matches.values(), key=lambda m: -m["combined"]),
            )
        finally:
            with _LOCK:
                _ACTIVE.pop(run_id, None)


# ----------------------------------------------------------------------
# 3b. training helpers: clarification questions + chat
# ----------------------------------------------------------------------
_FALLBACK_QUESTIONS = [
    {
        "id": "q1",
        "text": "Should people who only give tips or advice count as matches, or should they be excluded?",
    },
    {
        "id": "q2",
        "text": "Should people selling or promoting their own product or service count as matches?",
    },
    {
        "id": "q3",
        "text": "Should people who want something similar but different from the thing described count as matches?",
    },
    {
        "id": "q4",
        "text": "Which categories should matches be tagged with (for example beginner, rich, poor)?",
    },
    {
        "id": "q5",
        "text": "Should a short reply like 'Inbox price' with no clear buying intent count as a match?",
    },
]


def _sample_people(db, account_id, source_ids, limit=10):
    people, stats = build_people(db, source_ids, _own_name(db, account_id))
    cands = [p for p in people.values() if not _is_trivial(p)]
    posters = sorted(
        [p for p in cands if p["has_post"]], key=lambda p: -len(p["items"])
    )
    others = sorted(
        [p for p in cands if not p["has_post"]], key=lambda p: -len(p["items"])
    )
    # interleave posters and commenters so the sample shows both kinds
    sample = []
    for a, b in zip(posters, others):
        sample.extend([a, b])
    sample.extend(posters[len(others) :] or others[len(posters) :])
    return sample[:limit], stats


def suggest_questions(db, cfg, account_id, source_ids, criteria):
    """Clarification questions about the REAL ambiguities in a data sample.

    Returns {"questions": [{"id", "text"}], "sample": {people, posts, comments}}.
    On any LLM failure the generic fallback questions are returned."""
    sample, stats = _sample_people(db, account_id, source_ids, limit=10)
    out_sample = {
        "people": len(sample),
        "posts": stats["posts"],
        "comments": stats["comments"],
    }
    blocks = "\n\n".join(
        f"### {p['name'] or p['key']}\n{dossier(p, 600, 200)}"
        for p in sample
    )
    prompt = (
        "You help a user train a lead-finding AI before it runs.\n\n"
        f"WHAT THE USER IS LOOKING FOR:\n{criteria}\n\n"
        "Below is a sample of the real people the AI will judge. "
        "Look at the sample first, then ask up to 5 SHORT clarification questions "
        "about the real ambiguities you see in it — for example people who give "
        "advice instead of buying, people selling something, people who want a "
        "similar-but-different thing, or short replies with no clear intent. "
        "Ask only what changes who counts as a match.\n\n"
        f"SAMPLE:\n\n{blocks}\n\n"
        'Return ONLY JSON: {"questions":[{"id":"q1","text":"..."}]}'
    )
    text, err = _llm(cfg, prompt)
    if not err:
        data = _json_of(text)
        rows = []
        if isinstance(data, dict):
            rows = data.get("questions") or []
        if isinstance(rows, list):
            qs = []
            for i, r in enumerate(rows[:5], 1):
                if isinstance(r, dict) and (r.get("text") or "").strip():
                    qs.append(
                        {"id": str(r.get("id") or f"q{i}"), "text": r["text"].strip()}
                    )
            if qs:
                return {"questions": qs, "sample": out_sample}
    return {"questions": list(_FALLBACK_QUESTIONS), "sample": out_sample}


def chat_answer(db, cfg, account_id, criteria, source_ids, messages, training=None):
    """One free-form chat turn for training the AI (plain text, not JSON mode).

    Returns {"reply": str, "error": str}."""
    import ai_models  # lazy: avoids an import cycle at module load

    sample, _stats = _sample_people(db, account_id, source_ids or [], limit=5)
    blocks = "\n\n".join(
        f"### {p['name'] or p['key']}\n{dossier(p, 800, 200)}" for p in sample
    )
    history = "\n".join(
        f"{'User' if (m.get('role') or '') == 'user' else 'Assistant'}: "
        f"{_clip(m.get('text') or '', 500)}"
        for m in (messages or [])
        if isinstance(m, dict) and (m.get("text") or "").strip()
    )
    tb = training_block(training)
    prompt = (
        "You help a user train a lead-finding AI before it runs. Answer in plain "
        "English, briefly, one point at a time.\n\n"
        f"WHAT THE USER IS LOOKING FOR:\n{criteria}\n\n"
        + (tb + "\n\n" if tb else "")
        + "A small sample of the real people the AI will judge:\n\n"
        f"{blocks}\n\n"
        "Conversation so far:\n"
        f"{history or '(none)'}\n\n"
        "Answer the user's last message. If you are unsure who counts as a match, "
        "ask ONE short question about it."
    )
    text, err = ai_models.generate(
        cfg.get("provider") or "ollama",
        cfg.get("model") or "",
        cfg.get("geminiKey") or "",
        cfg.get("ollamaUrl") or "",
        prompt,
    )
    return {"reply": text or "", "error": err or ""}


# ----------------------------------------------------------------------
# 4. reading: runs, overlap with earlier queries, per-source summary
# ----------------------------------------------------------------------
def _view(d, with_matches=True):
    matches = json.loads(d["matches"] or "[]")
    out = {
        "id": d["id"],
        "accountId": d["account_id"],
        "status": d["status"],
        "createdAt": d["created_at"],
        "finishedAt": d["finished_at"],
        "criteria": d["criteria"],
        "quantity": d["quantity"],
        "provider": d["provider"],
        "model": d["model"],
        "sourceIds": json.loads(d["scope"] or "[]"),
        "progress": json.loads(d["progress"] or "{}"),
        "error": d["error"],
        "matchCount": len(matches),
        "live": d["id"] in _ACTIVE,
    }
    if with_matches:
        out["matches"] = matches
    return out


def run_view(db, run_id):
    row = _get_row(db, run_id)
    return _view(row) if row else None


def list_runs(db, account_id=""):
    with db._connect() as conn:
        rows = conn.execute(
            "SELECT * FROM analysis_runs WHERE account_id=? ORDER BY created_at DESC LIMIT 100",
            (account_id,),
        ).fetchall()
    return [_view(dict(r), with_matches=False) for r in rows]


_STOP = {
    "the",
    "who",
    "that",
    "and",
    "for",
    "with",
    "are",
    "have",
    "need",
    "needs",
    "people",
    "person",
    "log",
    "jo",
    "ko",
    "ki",
    "ka",
    "ke",
    "hain",
    "hai",
    "ho",
    "ye",
    "wo",
    "aur",
    "ya",
    "from",
    "looking",
    "find",
    "want",
    "wants",
    "their",
    "they",
    "them",
    "can",
    "will",
    "about",
}


def _tokens(text: str) -> set:
    return {w for w in re.findall(r"\w{3,}", (text or "").lower()) if w not in _STOP}


def similarity(a: str, b: str) -> float:
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def _own_name(db, account_id):
    with db._connect() as conn:
        row = conn.execute(
            "SELECT facebook_name FROM accounts WHERE id=?", (account_id or "",)
        ).fetchone()
    return (row["facebook_name"] if row else "") or ""


def overlap(db, params: dict):
    """What would a run on this data + query do? Plain numbers + earlier similar queries."""
    sources = [s for s in (params.get("sourceIds") or []) if s]
    account = params.get("accountId") or ""
    criteria = (params.get("criteria") or "").strip()
    people, stats = build_people(db, sources, _own_name(db, account))
    excl = exclude_keys(params.get("excludeUrls")) & set(people)
    rest = {k: p for k, p in people.items() if k not in excl}
    nontrivial = {k: p for k, p in rest.items() if not _is_trivial(p)}
    with db._connect() as conn:
        analysed = {
            r[0]
            for r in conn.execute(
                "SELECT DISTINCT person_key FROM analysis_people"
            ).fetchall()
        }
        known = {}
        if criteria:
            known = {
                r["person_key"]: r["fingerprint"]
                for r in conn.execute(
                    "SELECT person_key, fingerprint FROM analysis_people WHERE crit_hash=?",
                    (crit_hash(criteria),),
                ).fetchall()
            }
        run_rows = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM analysis_runs WHERE account_id=? ORDER BY created_at DESC LIMIT 60",
                (account,),
            ).fetchall()
        ]
    never = sum(1 for k in nontrivial if k not in analysed)
    done_q = (
        sum(1 for k, p in nontrivial.items() if known.get(k) == p["fp"])
        if criteria
        else 0
    )
    similar = []
    sset = set(sources)
    for r in run_rows:
        scope = set(json.loads(r["scope"] or "[]"))
        if not scope & sset:
            continue
        sim = similarity(criteria, r["criteria"]) if criteria else 0.0
        v = _view(r, with_matches=False)
        v["similarity"] = round(sim, 2)
        v["sameData"] = scope == sset
        similar.append(v)
    similar.sort(key=lambda v: (v["similarity"], v["createdAt"]), reverse=True)
    return {
        "posts": stats["posts"],
        "comments": stats["comments"],
        "replies": stats["replies"],
        "people": len(people),
        "noLink": stats["no_link"],
        "inLeads": len(excl),
        "empty": len(rest) - len(nontrivial),
        "neverChecked": never,
        "alreadyForQuery": done_q,
        "pendingForQuery": len(nontrivial) - done_q if criteria else None,
        "runs": similar[:6],
    }


def source_summary(db, source_id: str):
    """AI Analysis history of ONE group/page."""
    with db._connect() as conn:
        src = conn.execute("SELECT * FROM sources WHERE id=?", (source_id,)).fetchone()
        if src is None:
            return None
        own = _own_name(db, src["joined_by_account_id"] or "")
        post_ids = {
            r[0]
            for r in conn.execute(
                "SELECT id FROM posts WHERE source_id=?", (source_id,)
            ).fetchall()
        }
        analysed = {
            r[0]
            for r in conn.execute(
                "SELECT DISTINCT person_key FROM analysis_people"
            ).fetchall()
        }
        runs = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM analysis_runs WHERE account_id=? ORDER BY created_at DESC LIMIT 100",
                (src["joined_by_account_id"] or "",),
            ).fetchall()
        ]
    people, stats = build_people(db, [source_id], own)
    nontrivial = {k: p for k, p in people.items() if not _is_trivial(p)}
    unchecked = sum(1 for k in nontrivial if k not in analysed)
    out_runs = []
    for r in runs:
        scope = json.loads(r["scope"] or "[]")
        if source_id not in scope:
            continue
        ms = [
            m for m in json.loads(r["matches"] or "[]") if m.get("postId") in post_ids
        ]
        with db._connect() as conn:
            known = {
                x["person_key"]: x["fingerprint"]
                for x in conn.execute(
                    "SELECT person_key, fingerprint FROM analysis_people WHERE crit_hash=?",
                    (r["crit_hash"] or crit_hash(r["criteria"]),),
                ).fetchall()
            }
        pending = sum(1 for k, p in nontrivial.items() if known.get(k) != p["fp"])
        v = _view(r, with_matches=False)
        v.update(
            matchesHere=len(ms),
            pendingHere=pending,
            checkedHere=len(nontrivial) - pending,
        )
        out_runs.append(v)
    return {
        "sourceId": source_id,
        "name": src["name"],
        "posts": stats["posts"],
        "comments": stats["comments"],
        "replies": stats["replies"],
        "people": len(people),
        "checkable": len(nontrivial),
        "unchecked": unchecked,
        "checked": len(nontrivial) - unchecked,
        "runs": out_runs,
    }


def unchecked_counts(db, account_id: str):
    """{sourceId: {people, unchecked}} for the Data Sourcing table."""
    with db._connect() as conn:
        srcs = [
            dict(r)
            for r in conn.execute(
                "SELECT s.id, (SELECT COUNT(*) FROM posts p WHERE p.source_id=s.id) AS n "
                "FROM sources s WHERE s.joined_by_account_id=?",
                (account_id,),
            ).fetchall()
        ]
        analysed = {
            r[0]
            for r in conn.execute(
                "SELECT DISTINCT person_key FROM analysis_people"
            ).fetchall()
        }
    own = _own_name(db, account_id)
    out = {}
    for s in srcs:
        if not s["n"]:
            out[s["id"]] = {"people": 0, "unchecked": 0}
            continue
        people, _ = build_people(db, [s["id"]], own)
        nt = [k for k, p in people.items() if not _is_trivial(p)]
        out[s["id"]] = {
            "people": len(nt),
            "unchecked": sum(1 for k in nt if k not in analysed),
        }
    return out
