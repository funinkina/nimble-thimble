from fastapi import APIRouter
from pydantic import BaseModel

from .. import memory
from ..models import ChatResponse

router = APIRouter()


class ChatIn(BaseModel):
    message: str
    conversation_id: str


@router.post("/chat", response_model=ChatResponse)
def chat(body: ChatIn) -> ChatResponse:
    # sync def -> FastAPI runs it in a threadpool, so the blocking
    # embed + LLM pipeline doesn't stall the event loop.
    return memory.process_turn(body.message, body.conversation_id)
