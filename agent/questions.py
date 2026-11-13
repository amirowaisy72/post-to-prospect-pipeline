"""Questions the AI could not answer: the owner answers in the app."""

import threading

_LOCK = threading.Lock()
_PENDING = {}
_ANSWERS = {}


def ask(thread_id, name, messages, question):
    with _LOCK:
        _PENDING[thread_id] = {
            "threadId": thread_id,
            "name": name,
            "messages": list(messages),
            "question": question,
        }


def pending():
    with _LOCK:
        return [dict(v) for k, v in _PENDING.items() if k not in _ANSWERS]


def is_pending(thread_id):
    with _LOCK:
        return thread_id in _PENDING


def answer(thread_id, text):
    with _LOCK:
        if thread_id not in _PENDING or not (text or "").strip():
            return False
        _ANSWERS[thread_id] = text.strip()
        return True


def take_answer(thread_id):
    with _LOCK:
        text = _ANSWERS.pop(thread_id, "")
        if text:
            _PENDING.pop(thread_id, None)
        return text
