"""Facebook comment/reply timestamps -> ISO datetimes.

Order of preference (verified live on Facebook 2026-11-12):
1. EXACT time from the timestamp element's title attribute /
   aria-describedby text, e.g. "Wednesday 11 November 2026 at 05:43"
   or the no-year form "5 November at 21:02". This is the real time.
2. ONLY if that is missing, the visible relative label ("5d",
   "5 days ago", "Yesterday", "Just now") converted by subtracting
   the labelled amount from the collection instant (``now``).

The label fallback is APPROXIMATE by nature — a "5d" label covers
that whole day, so the computed time is the label's amount before
the collection instant, not the exact posting moment. The original
visible label is always kept alongside in ``postedAtLabel`` so the
approximation is visible. Unparseable labels (e.g. "October 12", an
absolute date with no year) map to None rather than a guessed time.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

__all__ = [
    "posted_at_from_label",
    "extract_timestamp_label",
    "parse_exact_description",
    "posted_at",
]

# Short labels: "5s", "5m", "5h", "5d", "5w", "5mo", "5y".
# "mo" must be tried before "m" so "5mo" is months, not minutes.
_SHORT_RE = re.compile(r"^(\d+)\s*(mo|[smhdwy])$", re.IGNORECASE)

# Long labels: "5 seconds ago", "3 days ago", "1 month ago", ...
_LONG_RE = re.compile(
    r"^(\d+)\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago$",
    re.IGNORECASE,
)

_YESTERDAY_RE = re.compile(r"^yesterday(\s+at\s+.*)?$", re.IGNORECASE)
_JUST_NOW_RE = re.compile(r"^just now$", re.IGNORECASE)

# Exact timestamp descriptions (the timestamp element's title /
# aria-describedby text), e.g. "Wednesday 11 November 2026 at 05:43"
# or the no-year form "5 November at 21:02". Weekday is optional and
# ignored — the date itself is what matters.
_MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5,
    "june": 6, "july": 7, "august": 8, "september": 9, "october": 10,
    "november": 11, "december": 12,
}
_EXACT_RE = re.compile(
    r"^(?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+)?"
    r"(\d{1,2})\s+([A-Za-z]+)\s+(?:(\d{4})\s+)?at\s+(\d{1,2}):(\d{2})",
    re.IGNORECASE,
)

# Amounts in seconds for each unit. A month is taken as 30 days and a
# year as 365 days — Facebook gives no finer detail, so these are the
# same approximation the label itself carries.
_UNIT_SECONDS = {
    "s": 1,
    "second": 1,
    "seconds": 1,
    "m": 60,
    "minute": 60,
    "minutes": 60,
    "h": 3600,
    "hour": 3600,
    "hours": 3600,
    "d": 86400,
    "day": 86400,
    "days": 86400,
    "w": 7 * 86400,
    "week": 7 * 86400,
    "weeks": 7 * 86400,
    "mo": 30 * 86400,
    "month": 30 * 86400,
    "months": 30 * 86400,
    "y": 365 * 86400,
    "year": 365 * 86400,
    "years": 365 * 86400,
}


def _as_aware(now: datetime) -> datetime:
    """Treat a naive ``now`` as UTC so the result is always ISO with offset."""
    if now.tzinfo is None:
        return now.replace(tzinfo=timezone.utc)
    return now


def posted_at_from_label(label: str | None, now: datetime) -> str | None:
    """Convert a Facebook relative timestamp label to an ISO string.

    Returns None when the label is empty or unparseable (e.g. an
    absolute date like "October 12"). The returned value is
    ``now`` minus the labelled amount — approximate, see module docstring.
    """
    if not label:
        return None
    text = str(label).strip()
    if not text:
        return None
    now = _as_aware(now)

    if _JUST_NOW_RE.match(text):
        return now.isoformat()
    if _YESTERDAY_RE.match(text):
        return (now - timedelta(days=1)).isoformat()

    m = _SHORT_RE.match(text)
    if m:
        amount = int(m.group(1))
        unit = m.group(2).lower()
        seconds = _UNIT_SECONDS.get(unit)
        if seconds is None:
            return None
        return (now - timedelta(seconds=amount * seconds)).isoformat()

    m = _LONG_RE.match(text)
    if m:
        amount = int(m.group(1))
        unit = m.group(2).lower()
        seconds = _UNIT_SECONDS.get(unit)
        if seconds is None:
            return None
        return (now - timedelta(seconds=amount * seconds)).isoformat()

    return None


def parse_exact_description(text: str | None, now: datetime | None = None) -> str | None:
    """Parse an exact timestamp description to an ISO string.

    Facebook's timestamp element carries the exact time in its title
    attribute / aria-describedby text, e.g. "Wednesday 11 November
    2026 at 05:43" or the no-year form "5 November at 21:02".

    The description is in the PC's LOCAL time (the agent runs on the
    user's PC), so the result is built in local time and returned as
    ISO with the local offset. A no-year date assumes the current
    year; if that lands in the future it is the previous year instead
    (a post cannot be from the future). Returns None when the text
    does not match the format or is not a real date.
    """
    if not text:
        return None
    m = _EXACT_RE.match(str(text).strip())
    if not m:
        return None
    day = int(m.group(1))
    month = _MONTHS.get(m.group(2).lower())
    year = int(m.group(3)) if m.group(3) else None
    hour = int(m.group(4))
    minute = int(m.group(5))
    if month is None or hour > 23 or minute > 59:
        return None
    ref = now if now is not None else datetime.now().astimezone()
    tz = ref.tzinfo if ref.tzinfo is not None else timezone.utc
    if year is None:
        year = ref.year
    try:
        result = datetime(year, month, day, hour, minute, tzinfo=tz)
    except ValueError:
        return None
    if year is not None and m.group(3) is None and result > ref:
        # No-year date in the future: it must be last year.
        try:
            result = datetime(year - 1, month, day, hour, minute, tzinfo=tz)
        except ValueError:
            return None
    return result.isoformat()


def posted_at(exact: str | None, label: str | None, now: datetime) -> str | None:
    """Best timestamp for a comment/reply: exact description first,
    label-minus-now fallback second (see module docstring for the
    approximation note on the fallback)."""
    parsed = parse_exact_description(exact, now)
    if parsed is not None:
        return parsed
    return posted_at_from_label(label, now)


def extract_timestamp_label(lines) -> str | None:
    """First line of ``lines`` that looks like a Facebook timestamp label.

    Used to pull the label off the leading line of a comment article's
    text (e.g. "5d", "3 days ago", "Yesterday", "Just now").
    Returns the line as written, or None when no line matches.
    """
    for line in lines or []:
        if line is None:
            continue
        text = str(line).strip()
        if not text:
            continue
        if (
            _SHORT_RE.match(text)
            or _LONG_RE.match(text)
            or _YESTERDAY_RE.match(text)
            or _JUST_NOW_RE.match(text)
        ):
            return text
    return None
