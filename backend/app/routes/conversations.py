from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import store
from ..models import ConversationOut, RestoredMessage, RetrievedRef

router = APIRouter()


class ConversationCreate(BaseModel):
    title: str = ""


@router.get("/conversations", response_model=list[ConversationOut])
def list_conversations():
    return store.list_conversations()


@router.post("/conversations", response_model=ConversationOut)
def create_conversation(body: ConversationCreate):
    return store.create_conversation(body.title)


@router.get(
    "/conversations/{conversation_id}/messages",
    response_model=list[RestoredMessage],
)
def conversation_messages(conversation_id: str):
    if not store.get_conversation(conversation_id):
        raise HTTPException(404, "conversation not found")
    retrieved_by_msg = store.retrieved_by_user_message(conversation_id)
    out: list[RestoredMessage] = []
    last_user_id: str | None = None
    for m in store.messages_for(conversation_id):
        if m["role"] == "user":
            last_user_id = m["id"]
            out.append(RestoredMessage(id=m["id"], role=m["role"], content=m["content"]))
        else:
            rows = retrieved_by_msg.get(last_user_id or "", [])
            out.append(
                RestoredMessage(
                    id=m["id"],
                    role=m["role"],
                    content=m["content"],
                    turn_message_id=last_user_id,
                    retrieved=[RetrievedRef(**r) for r in rows],
                )
            )
    return out


@router.delete("/conversations/{conversation_id}")
def delete_conversation(conversation_id: str):
    if not store.get_conversation(conversation_id):
        raise HTTPException(404, "conversation not found")
    store.delete_conversation(conversation_id)
    return {"deleted": conversation_id}
