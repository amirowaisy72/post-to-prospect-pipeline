"""Model list / test / generate for Gemini and Ollama (one place)."""

import time

import httpx

GEMINI = "https://generativelanguage.googleapis.com/v1beta"
RETRY = (429, 500, 502, 503, 504)


def list_models(provider, key, ollama_url):
    try:
        if provider == "ollama":
            r = httpx.get(
                (ollama_url or "http://127.0.0.1:11434").rstrip("/") + "/api/tags",
                timeout=10,
            )
            if r.status_code != 200:
                return [], f"Ollama HTTP {r.status_code}"
            return [m["name"] for m in r.json().get("models", [])], ""
        if not (key or "").strip():
            return [], "Enter the Gemini API key first."
        r = httpx.get(
            GEMINI + "/models?pageSize=200",
            headers={"x-goog-api-key": key.strip()},
            timeout=20,
        )
        if r.status_code != 200:
            return [], f"Gemini HTTP {r.status_code}: {r.text[:150]}"
        names = [
            m["name"].replace("models/", "")
            for m in r.json().get("models", [])
            if "generateContent" in m.get("supportedGenerationMethods", [])
        ]
        return sorted(names), ""
    except Exception as e:  # noqa: BLE001
        return [], f"{type(e).__name__}: {e}"


def generate(provider, model, key, ollama_url, prompt, http_post=None):
    """Returns (text, error). Gemini retries on busy (503/429)."""
    if provider == "ollama":
        try:
            r = httpx.post(
                (ollama_url or "http://127.0.0.1:11434").rstrip("/") + "/api/generate",
                json={"model": model, "prompt": prompt, "stream": False},
                timeout=300,
            )
            if r.status_code != 200:
                return "", f"Ollama HTTP {r.status_code}: {r.text[:150]}"
            return (r.json().get("response") or "").strip(), ""
        except Exception as e:  # noqa: BLE001
            return "", f"Ollama {type(e).__name__}: {e}"
    if not (key or "").strip():
        return "", "Gemini key missing"
    post = http_post or httpx.post
    err = ""
    for attempt in range(3):
        try:
            r = post(
                f"{GEMINI}/models/{model}:generateContent",
                headers={
                    "x-goog-api-key": key.strip(),
                    "Content-Type": "application/json",
                },
                json={"contents": [{"parts": [{"text": prompt}]}]},
                timeout=90,
            )
        except Exception as e:  # noqa: BLE001
            err = f"{type(e).__name__}: {e}"
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
        if r.status_code not in RETRY:
            break
        time.sleep(3 * (attempt + 1))
    return "", err


def test_model(provider, model, key, ollama_url):
    t = time.time()
    text, err = generate(
        provider, model, key, ollama_url, "Reply with the single word: OK"
    )
    return {"seconds": round(time.time() - t, 1), "reply": text[:80], "error": err}
