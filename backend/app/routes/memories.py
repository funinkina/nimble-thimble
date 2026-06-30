from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import embeddings, store
from ..models import MemoryOut, Status

router = APIRouter()


@router.get("/memories", response_model=list[MemoryOut])
def list_memories(status: Optional[str] = None, scope: Optional[str] = None):
    return store.list_memories(status=status, scope=scope)


class MemoryPatch(BaseModel):
    text: Optional[str] = None
    forget: Optional[bool] = None


@router.patch("/memories/{mem_id}", response_model=MemoryOut)
def patch_memory(mem_id: str, body: MemoryPatch):
    row = store.get_row(mem_id)
    if not row:
        raise HTTPException(404, "memory not found")
    if body.forget:
        store.set_status(mem_id, Status.forgotten)
    if body.text is not None and body.text != row["text"]:
        store.update_text(mem_id, body.text, embeddings.embed_one(body.text))
    return store.row_to_out(store.get_row(mem_id))


@router.delete("/memories/{mem_id}")
def delete_memory(mem_id: str):
    if not store.get_row(mem_id):
        raise HTTPException(404, "memory not found")
    store.delete_memory(mem_id)
    return {"deleted": mem_id}
