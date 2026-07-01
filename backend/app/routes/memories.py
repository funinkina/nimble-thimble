from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .. import embeddings, memory, store
from ..models import MemoryOut, MemoryRevisionOut, Status

router = APIRouter()


@router.get("/memories", response_model=list[MemoryOut])
def list_memories(
    conversation_id: str, status: Optional[str] = None, scope: Optional[str] = None
):
    return store.list_memories(conversation_id, status=status, scope=scope)


@router.get("/memories/search", response_model=list[MemoryOut])
def search_memories(conversation_id: str, q: str = Query(..., max_length=500)):
    # Full-text search across ALL statuses, ranked by BM25. Declared before the
    # /memories/{mem_id}/... routes so "search" isn't captured as a mem_id.
    return store.search_memories(conversation_id, q)


@router.get("/memories/{mem_id}/revisions", response_model=list[MemoryRevisionOut])
def memory_revisions(mem_id: str):
    if not store.get_row(mem_id):
        raise HTTPException(404, "memory not found")
    return store.list_revisions(mem_id)


class MemoryPatch(BaseModel):
    text: Optional[str] = Field(default=None, max_length=8000)
    forget: Optional[bool] = None
    pinned: Optional[bool] = None


@router.patch("/memories/{mem_id}", response_model=MemoryOut)
def patch_memory(mem_id: str, body: MemoryPatch):
    row = store.get_row(mem_id)
    if not row:
        raise HTTPException(404, "memory not found")
    if body.pinned is not None:
        store.set_pinned(mem_id, body.pinned)
    if body.forget:
        store.set_status(mem_id, Status.forgotten)
        store.add_revision(
            memory_id=mem_id,
            change_type="forgotten",
            old_text=row["text"],
            new_text=row["text"],
            old_confidence=row["confidence"],
            new_confidence=row["confidence"],
            old_status=row["status"],
            new_status=Status.forgotten.value,
            reason="Manually forgotten in the inspector.",
        )
    if body.text is not None and body.text != row["text"]:
        dup = memory.duplicate_of(body.text, row["conversation_id"], mem_id)
        if dup:
            other = store.get_row(dup[0])
            raise HTTPException(
                409,
                detail={
                    "error": "duplicate",
                    "message": f"Edit matches an existing memory (cosine={dup[1]:.2f}).",
                    "conflict_id": dup[0],
                    "conflict_text": other["text"] if other else None,
                },
            )
        try:
            new_emb = embeddings.embed_one(body.text)
        except Exception as e:  # noqa: BLE001 - degrade like the pipeline, don't 500
            raise HTTPException(503, "embedding unavailable, edit not saved") from e
        store.update_text(mem_id, body.text, new_emb)
        store.add_revision(
            memory_id=mem_id,
            change_type="edited",
            old_text=row["text"],
            new_text=body.text,
            old_confidence=row["confidence"],
            new_confidence=row["confidence"],
            old_status=row["status"],
            new_status=row["status"],
            reason="Manually edited in the inspector.",
        )
    return store.row_to_out(store.get_row(mem_id))


@router.delete("/memories/{mem_id}")
def delete_memory(mem_id: str):
    if not store.get_row(mem_id):
        raise HTTPException(404, "memory not found")
    store.delete_memory(mem_id)
    return {"deleted": mem_id}
