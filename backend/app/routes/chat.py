import json

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import memory
from ..models import ChatResponse

router = APIRouter()


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    conversation_id: str = Field(min_length=1, max_length=64)


@router.post("/chat", response_model=ChatResponse)
def chat(body: ChatIn) -> ChatResponse:
    # sync def -> FastAPI runs it in a threadpool, so the blocking
    # embed + LLM pipeline doesn't stall the event loop.
    return memory.process_turn(body.message, body.conversation_id)


@router.post("/chat/stream")
def chat_stream(body: ChatIn) -> StreamingResponse:
    """Same pipeline as /chat, but the reply streams token-by-token over SSE. The
    first event carries the stages-1-5 result (message_id, memory_events, retrieved)
    so the memory + trace panes update the instant extraction finishes; reply deltas
    follow. Starlette runs this sync generator in a threadpool, so the blocking
    embed/LLM work doesn't stall the event loop."""

    def gen():
        for event in memory.process_turn_stream(body.message, body.conversation_id):
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
