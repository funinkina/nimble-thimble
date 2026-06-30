from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import db
from .routes import chat, conversations, memories, metrics, traces


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.connect()  # init schema + load sqlite-vec before first request
    yield


app = FastAPI(title="Inspectable Memory Chat", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True}


app.include_router(chat.router)
app.include_router(conversations.router)
app.include_router(memories.router)
app.include_router(traces.router)
app.include_router(metrics.router)
