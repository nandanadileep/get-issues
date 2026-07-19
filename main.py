"""
Issue Radar — local web UI.

Run:  .venv/bin/uvicorn main:app --reload
Open: http://localhost:8000
"""

import time

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

import engine

app = FastAPI(title="Issue Radar")
templates = Jinja2Templates(directory="templates")

CACHE_TTL = 6 * 3600  # rebuild feed at most every 6h unless ?refresh=1
_cache = {"feed": None, "built": 0, "error": None}


def feed_stale():
    return _cache["feed"] is None or (time.time() - _cache["built"]) > CACHE_TTL


@app.get("/", response_class=HTMLResponse)
def home(request: Request, refresh: bool = False):
    if refresh or feed_stale():
        try:
            _cache["feed"] = engine.get_feed(engine.get_token())
            _cache["built"] = time.time()
            _cache["error"] = None
        except Exception as e:  # show error page, keep old feed if any
            _cache["error"] = str(e)
    return templates.TemplateResponse(
        request,
        "feed.html",
        {
            "feed": _cache["feed"],
            "error": _cache["error"],
            "built": time.strftime(
                "%Y-%m-%d %H:%M", time.localtime(_cache["built"])
            )
            if _cache["built"]
            else None,
        },
    )


@app.get("/health")
def health():
    return {"ok": True, "cached": _cache["feed"] is not None}
