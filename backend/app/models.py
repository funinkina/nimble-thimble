"""Pydantic schemas. The LLM-facing ones double as structured-output contracts."""

from __future__ import annotations

from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, Field


# ---- enums ----
class Scope(str, Enum):
    user_profile = "user_profile"  # stable identity: name, role, location
    preference = "preference"  # likes/dislikes, defaults, style
    fact = "fact"  # discrete world/personal facts
    context = "context"  # current task / short-lived situation


class Status(str, Enum):
    active = "active"
    updated = "updated"  # refined in place by a newer message; still current + retrievable
    superseded = "superseded"  # contradicted/replaced by a newer memory
    forgotten = "forgotten"  # explicitly forgotten by the user


# A memory is "live" (retrievable, and a valid dedup/conflict neighbour) when it is
# either freshly created (active) or refined in place (updated). A refined fact is
# still the current fact, so `updated` rows stay in play; only superseded/forgotten
# drop out. Single source of truth for every active-vs-live gate in the pipeline.
LIVE_STATUSES = (Status.active, Status.updated)
LIVE_STATUS_VALUES = tuple(s.value for s in LIVE_STATUSES)


class Relation(str, Enum):
    new = "new"  # unrelated to the neighbour, store fresh
    duplicate = "duplicate"  # same meaning, drop
    update = "update"  # same subject, refined value
    supersede = "supersede"  # contradicts the neighbour, replace it
    unrelated = "unrelated"  # neighbour was a false match, store fresh


# ---- LLM structured-output contracts ----
class Candidate(BaseModel):
    """One memory-worthy fact the model lifted from a user message."""

    text: str = Field(
        description="The fact, written as a standalone statement about the user."
    )
    scope: Scope = Field(description="Which kind of memory this is.")
    source_excerpt: str = Field(
        description="The exact span of the user message that evidences this fact."
    )
    confidence: float = Field(
        ge=0.0,
        le=1.0,
        description="How confident this is a durable, memory-worthy fact.",
    )


class Extraction(BaseModel):
    """Result of analysing one user turn. Empty list for chit-chat."""

    candidates: list[Candidate] = Field(default_factory=list)
    forget_request: str = Field(
        default="",
        description="If the user explicitly asked to forget/delete something, the subject to forget; otherwise an empty string.",
    )


class Judgment(BaseModel):
    """How a new candidate relates to its nearest existing memory."""

    relation: Relation
    reason: str = Field(
        description="One sentence explaining the relation, citing both texts."
    )


# ---- API response shapes ----
class MemoryOut(BaseModel):
    id: str
    text: str
    scope: Scope
    status: Status
    source_message_id: Optional[str]
    source_excerpt: Optional[str]
    reason: Optional[str]
    confidence: float
    supersedes_id: Optional[str]
    superseded_by: Optional[str] = None
    use_count: int
    last_used_at: Optional[str]
    created_at: str
    updated_at: str
    decay_score: float
    revision_count: int = 1


class MemoryRevisionOut(BaseModel):
    id: str
    memory_id: str
    revision_index: int
    change_type: Literal[
        "created", "refined", "superseded", "reinforced", "edited", "forgotten"
    ]
    old_text: Optional[str]
    new_text: Optional[str]
    old_confidence: Optional[float]
    new_confidence: Optional[float]
    old_status: Optional[str]
    new_status: Optional[str]
    source_message_id: Optional[str]
    source_excerpt: Optional[str]
    reason: Optional[str]
    cosine: Optional[float]
    created_at: str


class MemoryEvent(BaseModel):
    type: Literal["created", "updated", "superseded", "duplicate", "forgotten"]
    memory_id: str
    detail: str


class RetrievedRef(BaseModel):
    memory_id: str
    text: str
    cosine: float
    decay: float
    score: float
    rank: int


class ChatResponse(BaseModel):
    reply: str
    message_id: str
    memory_events: list[MemoryEvent]
    retrieved: list[RetrievedRef]


class ConversationOut(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str


class RestoredMessage(BaseModel):
    """One message replayed into the client runtime when restoring a chat.
    Assistant rows carry the owning user turn's id + retrieved refs so the
    [N MEMORIES USED] badge and trace selection work after reload."""

    id: str
    role: str
    content: str
    turn_message_id: Optional[str] = None
    retrieved: list[RetrievedRef] = []
    memory_events: list[MemoryEvent] = []


class TraceOut(BaseModel):
    id: str
    message_id: str
    stage: Literal["extract", "dedup", "conflict", "retrieve", "reply"]
    payload: dict
    created_at: str


class Metrics(BaseModel):
    memories_by_status: dict[str, int]
    memories_by_scope: dict[str, int]
    total_user_messages: int
    total_candidates: int
    dedup_count: int
    supersede_count: int
    update_count: int
    forgotten_count: int
    avg_retrieval_cosine: float
    llm_calls: int
    llm_input_tokens: int
    llm_output_tokens: int
    avg_llm_latency_ms: float
