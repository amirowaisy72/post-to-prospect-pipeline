"""AI Analysis endpoints (see analysis_engine.py)."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse


def build_router(db) -> APIRouter:
    import analysis_engine as eng

    eng.init(db)
    r = APIRouter()

    async def _body(request: Request) -> dict:
        try:
            b = await request.json()
        except Exception:
            b = {}
        return b if isinstance(b, dict) else {}

    def _err(msg: str, code: int = 400):
        return JSONResponse(status_code=code, content={"detail": msg})

    @r.post("/analysis/overlap")
    async def overlap(request: Request):
        b = await _body(request)
        return await asyncio.to_thread(eng.overlap, db, b)

    @r.post("/analysis/start")
    async def start(request: Request):
        b = await _body(request)
        run_id, err = eng.start_run(db, b)
        if err:
            return _err(err, 409 if "already running" in err else 400)
        return {"id": run_id}

    @r.get("/analysis/training")
    def training(accountId: str = "", criteria: str = ""):
        t = eng.get_training(db, accountId, criteria)
        if t is None:
            return {
                "found": False,
                "criteria": criteria,
                "rules": [],
                "categories": [],
                "updated_at": None,
            }
        return {"found": True, **t}

    @r.post("/analysis/training")
    async def save_training(request: Request):
        b = await _body(request)
        criteria = (b.get("criteria") or "").strip()
        if not criteria:
            return _err("criteria is required")
        rules = b.get("rules") or []
        categories = b.get("categories") or []
        if not isinstance(rules, list) or not isinstance(categories, list):
            return _err("rules and categories must be lists")
        saved = await asyncio.to_thread(
            eng.save_training, db, b.get("accountId") or "", criteria, rules, categories
        )
        return {
            "ok": True,
            "criteria": saved["criteria"],
            "rules": len(saved["rules"]),
            "categories": saved["categories"],
        }

    @r.post("/analysis/clarify-questions")
    async def clarify_questions(request: Request):
        b = await _body(request)
        cfg = {
            "provider": b.get("provider") or "ollama",
            "model": b.get("model") or "",
            "geminiKey": b.get("geminiKey") or "",
            "ollamaUrl": b.get("ollamaUrl") or "",
        }
        return await asyncio.to_thread(
            eng.suggest_questions,
            db,
            cfg,
            b.get("accountId") or "",
            b.get("sourceIds") or [],
            (b.get("criteria") or "").strip(),
        )

    @r.post("/analysis/chat")
    async def chat(request: Request):
        b = await _body(request)
        cfg = {
            "provider": b.get("provider") or "ollama",
            "model": b.get("model") or "",
            "geminiKey": b.get("geminiKey") or "",
            "ollamaUrl": b.get("ollamaUrl") or "",
        }
        training = b.get("training")
        if training is None:
            training = await asyncio.to_thread(
                eng.get_training, db, b.get("accountId") or "", (b.get("criteria") or "").strip()
            )
        return await asyncio.to_thread(
            eng.chat_answer,
            db,
            cfg,
            b.get("accountId") or "",
            (b.get("criteria") or "").strip(),
            b.get("sourceIds") or [],
            b.get("messages") or [],
            training,
        )

    @r.get("/analysis/runs")
    def runs(accountId: str = ""):
        return {"runs": eng.list_runs(db, accountId)}

    @r.get("/analysis/runs/{run_id}")
    def one(run_id: str):
        v = eng.run_view(db, run_id)
        if v is None:
            return _err("unknown run", 404)
        return {"run": v}

    @r.post("/analysis/runs/{run_id}/stop")
    def stop(run_id: str):
        return {"ok": eng.request_stop(db, run_id)}

    @r.post("/analysis/runs/{run_id}/resume")
    async def resume(run_id: str, request: Request):
        b = await _body(request)
        new_id, err = eng.resume_run(db, run_id, b)
        if err:
            return _err(err, 409 if "already running" in err else 400)
        return {"id": new_id}

    @r.post("/analysis/runs/{run_id}/quantity")
    async def quantity(run_id: str, request: Request):
        b = await _body(request)
        try:
            q = int(b.get("quantity"))
        except (TypeError, ValueError):
            return _err("quantity must be a number")
        ok, msg = eng.set_quantity(db, run_id, q)
        if not ok:
            return _err(msg)
        return {"ok": True}

    @r.post("/analysis/runs/{run_id}/delete")
    def delete(run_id: str):
        if not eng.delete_run(db, run_id):
            return _err("A running analysis cannot be deleted - stop it first", 409)
        return {"ok": True}

    @r.get("/analysis/source/{source_id}")
    async def source(source_id: str):
        v = await asyncio.to_thread(eng.source_summary, db, source_id)
        if v is None:
            return _err("unknown source", 404)
        return v

    @r.get("/analysis/unchecked")
    async def unchecked(accountId: str = ""):
        return {"sources": await asyncio.to_thread(eng.unchecked_counts, db, accountId)}

    return r
