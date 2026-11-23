"""Tests for the AI Analysis intent fix (strict judge + training).

The LLM is always stubbed — no test calls a live model.
Person dicts are shaped exactly like build_people output.
"""

import json
import sys
from pathlib import Path

import pytest

AGENT_DIR = Path(__file__).resolve().parent.parent
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import db  # noqa: E402
import analysis_engine as eng  # noqa: E402

QUERY = "People who want to buy a tool for making YouTube videos easily"
CFG = {"provider": "ollama", "model": "llama3.1:8b", "geminiKey": "", "ollamaUrl": ""}

TRAINING = {
    "rules": [
        {
            "question": "Should people who only give tips count as matches?",
            "answer": "No, tip-givers are not matches.",
        },
        {
            "question": "Should people wanting a different thing count?",
            "answer": "No, only the tool for making YouTube videos.",
        },
    ],
    "categories": ["beginner", "rich", "poor"],
}


@pytest.fixture(autouse=True)
def temp_db(tmp_path):
    db.init_db(tmp_path / "test_intent.db")
    eng.init(db)
    yield


def _person(name, items, posts_by_id):
    return {
        "key": "u:" + name.lower().replace(" ", ""),
        "name": name,
        "url": "https://www.facebook.com/" + name.lower().replace(" ", ""),
        "items": items,
        "last": "2026-11-23T05:00:00Z",
        "fp": "testfp",
        "has_post": any(i["kind"] == "post" for i in items),
        "posts_by_id": posts_by_id,
    }


def _post(pid, text, title="Post"):
    return {
        pid: {
            "post_url": f"https://www.facebook.com/groups/1/permalink/{pid}/",
            "title": title,
            "text": text,
            "source_name": "Test Group",
        }
    }


def _judge_with_stub(monkeypatch, person, stub_reply, training=None):
    def fake_llm(cfg, prompt):
        return json.dumps(stub_reply), ""

    monkeypatch.setattr(eng, "_llm", fake_llm)
    return eng._judge(CFG, QUERY, person, training)


# (a) Mahdi Hasan: "Inbox price" on a post about a monetized channel.
def test_mahdi_wrong_thing_rejected(monkeypatch):
    post_text = "I have a monetized YouTube channel for sale, inbox for price"
    p = _person(
        "Mahdi Hasan",
        [
            {
                "kind": "comment",
                "text": "Inbox price",
                "time": "2026-11-23T05:00:00Z",
                "post_id": "111",
                "parent": "",
            }
        ],
        _post("111", post_text),
    )
    v, err = _judge_with_stub(
        monkeypatch,
        p,
        {
            "wants_to_buy": True,
            "wants_query_thing": False,
            "wanted_thing": "monetized YouTube channel",
            "gives_advice": False,
            "sells_or_promotes": False,
            "bare_reply": False,
            "evidence": "explicit",
            "promo": False,
            "score": 90,
            "match": True,
            "role": "commenter",
            "category": "other",
            "reason": "He wants to buy a channel.",
            "quote": "Inbox price",
        },
        TRAINING,
    )
    assert err == ""
    assert v["match"] is False
    assert v["wanted_thing"] == "monetized YouTube channel"
    assert v["quote_verified"] is True


# (b) Oman News Urdu/Hindi: gives a viral tip, does not want to buy.
def test_oman_tip_giver_rejected(monkeypatch):
    tip = "1 video Din me 4 bjy upload kro Dosri Thk 1 hour bad phir dekhna viral kesy hoti hai"
    p = _person(
        "Oman News Urdu/Hindi",
        [
            {
                "kind": "comment",
                "text": tip,
                "time": "2026-11-23T05:00:00Z",
                "post_id": "222",
                "parent": "",
            }
        ],
        _post("222", "How to grow on YouTube? Share your best tips below."),
    )
    v, err = _judge_with_stub(
        monkeypatch,
        p,
        {
            "wants_to_buy": False,
            "wants_query_thing": False,
            "wanted_thing": "",
            "gives_advice": True,
            "sells_or_promotes": False,
            "bare_reply": False,
            "evidence": "explicit",
            "promo": False,
            "score": 90,
            "match": True,
            "role": "commenter",
            "category": "other",
            "reason": "He talks about YouTube videos.",
            "quote": tip,
        },
        TRAINING,
    )
    assert err == ""
    assert v["match"] is False
    assert v["gives_advice"] is True
    assert v["quote_verified"] is True


# (c) True buyer: matches, keeps the category, has a full reference.
def test_true_buyer_matches_with_category_and_reference(monkeypatch):
    post_text = "Looking for recommendations for video making tools"
    p = _person(
        "Ayesha Khan",
        [
            {
                "kind": "comment",
                "text": "I want to buy an easy tool for making YouTube videos, please suggest a good one",
                "time": "2026-11-23T05:00:00Z",
                "post_id": "333",
                "parent": "",
            }
        ],
        _post("333", post_text),
    )
    v, err = _judge_with_stub(
        monkeypatch,
        p,
        {
            "wants_to_buy": True,
            "wants_query_thing": True,
            "wanted_thing": "tool for making YouTube videos",
            "gives_advice": False,
            "sells_or_promotes": False,
            "bare_reply": False,
            "evidence": "explicit",
            "promo": False,
            "score": 92,
            "match": True,
            "role": "commenter",
            "category": "beginner",
            "reason": "She wants to buy a tool for making YouTube videos.",
            "quote": "I want to buy an easy tool for making YouTube videos",
        },
        TRAINING,
    )
    assert err == ""
    assert v["match"] is True
    assert v["category"] == "beginner"
    assert v["quote_verified"] is True
    ref = v["reference"]
    assert ref["itemText"].startswith("I want to buy an easy tool")
    assert ref["postText"] == post_text
    assert ref["itemKind"] == "comment"
    assert ref["postUrl"].endswith("/333/")
    assert ref["sourceName"] == "Test Group"


# (d) Sloppy model: old-style reply with NO checklist keys -> rejected.
def test_old_style_reply_without_checklist_rejected(monkeypatch):
    p = _person(
        "Sloppy Case",
        [
            {
                "kind": "comment",
                "text": "I want to buy an easy tool for making YouTube videos",
                "time": "2026-11-23T05:00:00Z",
                "post_id": "444",
                "parent": "",
            }
        ],
        _post("444", "Video tools discussion"),
    )
    v, err = _judge_with_stub(
        monkeypatch,
        p,
        {
            "match": True,
            "score": 90,
            "evidence": "explicit",
            "promo": False,
            "reason": "Looks like a match.",
            "quote": "I want to buy an easy tool for making YouTube videos",
        },
        TRAINING,
    )
    assert err == ""
    assert v["match"] is False
    assert v["wants_to_buy"] is False
    assert v["wants_query_thing"] is False


# (e) Fabricated quote: quote not present in the person's text -> rejected.
def test_fabricated_quote_rejected(monkeypatch):
    p = _person(
        "Fabricated Case",
        [
            {
                "kind": "comment",
                "text": "Nice video, thanks for sharing",
                "time": "2026-11-23T05:00:00Z",
                "post_id": "555",
                "parent": "",
            }
        ],
        _post("555", "Video tools discussion"),
    )
    v, err = _judge_with_stub(
        monkeypatch,
        p,
        {
            "wants_to_buy": True,
            "wants_query_thing": True,
            "wanted_thing": "tool for making YouTube videos",
            "gives_advice": False,
            "sells_or_promotes": False,
            "bare_reply": False,
            "evidence": "explicit",
            "promo": False,
            "score": 92,
            "match": True,
            "role": "commenter",
            "category": "beginner",
            "reason": "He wants the tool.",
            "quote": "I really want to buy this amazing tool today",
        },
        TRAINING,
    )
    assert err == ""
    assert v["match"] is False
    assert v["quote_verified"] is False


# (f) Prompt text: judge prompt has the checklist + training block; screen has the guard.
def test_prompt_text():
    p = _person(
        "Prompt Case",
        [
            {
                "kind": "comment",
                "text": "hello",
                "time": "2026-11-23T05:00:00Z",
                "post_id": "666",
                "parent": "",
            }
        ],
        _post("666", "Some post"),
    )
    jp = eng._judge_prompt(QUERY, p)
    for key in ("wants_to_buy", "wants_query_thing", "gives_advice"):
        assert key in jp
    assert "TRAINING FROM THE USER" not in jp
    jp_trained = eng._judge_prompt(QUERY, p, TRAINING)
    assert "TRAINING FROM THE USER" in jp_trained
    assert "tip-givers are not matches" in jp_trained
    assert "beginner" in jp_trained
    sp = eng._screen_prompt(QUERY, [p], TRAINING)
    assert "Score 0-20 when the person only gives advice" in sp
    assert "TRAINING FROM THE USER" in sp


# (g) Training round-trip.
def test_training_round_trip():
    saved = eng.save_training(
        db, "acc1", QUERY, TRAINING["rules"], TRAINING["categories"]
    )
    assert saved["criteria"] == QUERY
    got = eng.get_training(db, "acc1", QUERY)
    assert got is not None
    assert got["rules"] == TRAINING["rules"]
    assert got["categories"] == TRAINING["categories"]
    assert eng.get_training(db, "acc1", "a different query") is None


# (h) suggest_questions fallback when the LLM fails.
def test_suggest_questions_fallback(monkeypatch):
    monkeypatch.setattr(eng, "_llm", lambda cfg, prompt: ("", "boom"))
    out = eng.suggest_questions(db, CFG, "acc1", [], QUERY)
    assert out["questions"], "fallback questions must be non-empty"
    texts = " ".join(q["text"] for q in out["questions"]).lower()
    assert "tip" in texts
    assert "sell" in texts
    assert out["sample"]["people"] == 0


# (i) _match_row carries category + reference.
def test_match_row_category_and_reference():
    p = _person(
        "Row Case",
        [
            {
                "kind": "comment",
                "text": "I want to buy an easy tool for making YouTube videos",
                "time": "2026-11-23T05:00:00Z",
                "post_id": "777",
                "parent": "",
            }
        ],
        _post("777", "Video tools discussion"),
    )
    v = {
        "score": 92,
        "role": "commenter",
        "reason": "Wants the tool.",
        "quote": "I want to buy an easy tool for making YouTube videos",
        "where": "comment",
        "postId": "777",
        "postUrl": "https://www.facebook.com/groups/1/permalink/777/",
        "postTitle": "Video tools discussion",
        "category": "beginner",
        "reference": {"itemText": "I want to buy an easy tool", "postText": "x"},
    }
    row = eng._match_row(p, v)
    assert row["category"] == "beginner"
    assert row["reference"]["itemText"] == "I want to buy an easy tool"
    assert row["score"] == 92
    assert row["name"] == "Row Case"
