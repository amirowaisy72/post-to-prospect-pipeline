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
            return _err(err, 409 if "pehle se" in err else 400)
        return {"id": run_id}

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
            return _err(err, 409 if "pehle se" in err else 400)
        return {"id": new_id}

    @r.post("/analysis/runs/{run_id}/quantity")
    async def quantity(run_id: str, request: Request):
        b = await _body(request)
        try:
            q = int(b.get("quantity"))
        except (TypeError, ValueError):
            return _err("quantity number honi chahiye")
        ok, msg = eng.set_quantity(db, run_id, q)
        if not ok:
            return _err(msg)
        return {"ok": True}

    @r.post("/analysis/runs/{run_id}/delete")
    def delete(run_id: str):
        if not eng.delete_run(db, run_id):
            return _err("Chalti hui analysis delete nahi ho sakti - pehle Stop karein", 409)
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
