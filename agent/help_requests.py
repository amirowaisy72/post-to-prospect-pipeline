"""Agent "needs your help" state (in memory only).

When the agent hits something it cannot do alone (Messenger asks for
its PIN, it cannot tell which chat is open, an unknown popup), it
raises a help request here. The app polls GET /agent/help and shows a
card; the user answers (PIN) or fixes it by hand, then the agent
carries on with the very message it was sending.

The PIN lives in this module's memory ONLY: never written to disk,
never logged. An agent restart forgets everything here.
"""

from __future__ import annotations

import threading
from datetime import datetime, timezone

_LOCK = threading.Lock()
_REQUEST: dict | None = None
_PIN: str | None = None
_PAYLOAD: dict | None = None  # the send that is waiting for help
_CURRENT: dict | None = None  # the send running right now
_CONFIRMED: set = set()  # profiles the user confirmed by hand


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def set_current_payload(payload) -> None:
    global _CURRENT
    with _LOCK:
        _CURRENT = dict(payload) if isinstance(payload, dict) else None


def raise_help(kind: str, message: str) -> None:
    global _REQUEST, _PAYLOAD
    with _LOCK:
        same = _REQUEST is not None and _REQUEST["kind"] == kind
        since = _REQUEST["since"] if same else _now()
        _REQUEST = {"kind": kind, "message": message, "since": since}
        if _CURRENT is not None:
            _PAYLOAD = dict(_CURRENT)


def get_help() -> dict | None:
    with _LOCK:
        return dict(_REQUEST) if _REQUEST else None


def resolve() -> dict | None:
    """Clear the request; return the send that was waiting (or None).
    When the user resolved a 'stuck' request, remember that profile as
    confirmed so the agent does not get stuck on it again."""
    global _REQUEST, _PAYLOAD
    with _LOCK:
        payload = _PAYLOAD
        kind = _REQUEST["kind"] if _REQUEST else None
        if kind == "stuck" and payload and payload.get("profileUrl"):
            _CONFIRMED.add(payload["profileUrl"])
        _REQUEST = None
        _PAYLOAD = None
    return payload


def is_confirmed(profile_url: str) -> bool:
    with _LOCK:
        return profile_url in _CONFIRMED


def set_pin(pin: str) -> None:
    global _PIN
    with _LOCK:
        _PIN = pin


def get_pin() -> str | None:
    with _LOCK:
        return _PIN


def clear_pin() -> None:
    global _PIN
    with _LOCK:
        _PIN = None
