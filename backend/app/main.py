import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from . import config, db, settings
from .routes import chat, conversations, memories, metrics, traces
from .routes import settings as settings_route

log = logging.getLogger("glassbox")


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.connect()  # init schema + load sqlite-vec before first request
    settings.load_from_db()  # apply persisted config overrides onto the config module
    if not config.GROQ_API_KEY:
        # Surface the misconfig at boot, not on the first chat turn's 401.
        log.warning("GROQ_API_KEY is not set — LLM calls (reply/extract/judge) will fail.")
    yield


app = FastAPI(title="GlassBox Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    # Readiness, not just liveness: confirm the DB actually answers.
    try:
        db.query_one("SELECT 1 AS ok")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, "database unavailable") from e
    return {"ok": True}


app.include_router(chat.router)
app.include_router(conversations.router)
app.include_router(memories.router)
app.include_router(traces.router)
app.include_router(metrics.router)
app.include_router(settings_route.router)
