// Mirror of the backend Pydantic schemas (app/models.py). Keep in sync.

export type Scope = "user_profile" | "preference" | "fact" | "context";
export type MemoryStatus = "active" | "updated" | "superseded" | "forgotten";
export type MemoryEventType =
  | "created"
  | "updated"
  | "superseded"
  | "duplicate"
  | "forgotten";

export interface Memory {
  id: string;
  text: string;
  scope: Scope;
  status: MemoryStatus;
  source_message_id: string | null;
  source_excerpt: string | null;
  reason: string | null;
  confidence: number;
  supersedes_id: string | null;
  superseded_by: string | null;
  pinned: boolean;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  decay_score: number;
  revision_count: number;
}

export type RevisionChangeType =
  | "created"
  | "refined"
  | "superseded"
  | "reinforced"
  | "edited"
  | "forgotten";

export interface MemoryRevision {
  id: string;
  memory_id: string;
  revision_index: number;
  change_type: RevisionChangeType;
  old_text: string | null;
  new_text: string | null;
  old_confidence: number | null;
  new_confidence: number | null;
  old_status: string | null;
  new_status: string | null;
  source_message_id: string | null;
  source_excerpt: string | null;
  reason: string | null;
  cosine: number | null;
  created_at: string;
}

export interface MemoryEvent {
  type: MemoryEventType;
  memory_id: string;
  detail: string;
}

export interface RetrievedRef {
  memory_id: string;
  text: string;
  cosine: number;
  decay: number;
  score: number;
  rank: number;
}

export interface ChatResponse {
  reply: string;
  message_id: string;
  memory_events: MemoryEvent[];
  retrieved: RetrievedRef[];
}

export type TraceStage = "extract" | "dedup" | "conflict" | "retrieve" | "reply";

export interface LlmMeta {
  model: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
}

export interface ExtractCandidate {
  text: string;
  scope: Scope;
  source_excerpt: string;
  confidence: number;
}

export interface ExtractPayload {
  candidates: ExtractCandidate[];
  forget_request: string | null;
  forget_resolution: string | null;
  llm: LlmMeta;
}

export interface DedupDropped {
  candidate: string;
  neighbour: string;
  neighbour_id?: string;
  cosine: number;
  reason: string;
  llm?: LlmMeta;
}

export interface DedupPayload {
  dropped: DedupDropped[];
}

export interface ConflictResolution {
  candidate: string;
  relation: string;
  neighbour: string | null;
  neighbour_id?: string;
  cosine: number | null;
  reason?: string;
  action: string;
  memory_id: string;
  llm?: LlmMeta;
}

export interface ConflictPayload {
  resolutions: ConflictResolution[];
}

export interface RetrieveRow {
  memory_id: string;
  text: string;
  scope: Scope;
  status: MemoryStatus;
  cosine: number;
  decay: number;
  score: number;
  rank: number;
  // hybrid sub-scores (present when BM25/rerank are enabled; null/absent otherwise)
  vec_rank?: number | null;
  bm25_rank?: number | null;
  rrf_score?: number | null;
  rerank_score?: number | null;
}

export interface RetrievePayload {
  retrieved: RetrieveRow[];
  threshold: number;
  hybrid?: boolean;
  reranked?: boolean;
}

export interface ReplyPayload {
  used_memory_ids: string[];
  reply_preview: string;
  llm: LlmMeta;
}

export type TracePayload =
  | ExtractPayload
  | DedupPayload
  | ConflictPayload
  | RetrievePayload
  | ReplyPayload
  | Record<string, unknown>;

export interface Trace {
  id: string;
  message_id: string;
  stage: TraceStage;
  payload: TracePayload;
  created_at: string;
}

export interface Metrics {
  memories_by_status: Record<string, number>;
  memories_by_scope: Record<string, number>;
  total_user_messages: number;
  total_candidates: number;
  dedup_count: number;
  supersede_count: number;
  update_count: number;
  forgotten_count: number;
  avg_retrieval_cosine: number;
  llm_calls: number;
  llm_input_tokens: number;
  llm_output_tokens: number;
  avg_llm_latency_ms: number;
}

// The blob the chat adapter stashes on each assistant message's metadata.custom.
export interface TurnMeta {
  message_id: string;
  retrieved: RetrievedRef[];
  memory_events: MemoryEvent[];
}

// Narrow the opaque metadata.custom blob back to a TurnMeta instead of a blind
// double-cast — returns undefined for streaming/incomplete messages. Returns the
// SAME object reference when valid (never a rebuilt one): this runs inside a
// useMessage selector backed by useSyncExternalStore, which compares by identity,
// so a fresh object every call would loop until "Maximum update depth exceeded".
export function asTurnMeta(v: unknown): TurnMeta | undefined {
  if (!v || typeof v !== "object") return undefined;
  const m = v as Record<string, unknown>;
  if (typeof m.message_id !== "string" || !Array.isArray(m.retrieved)) return undefined;
  if (!Array.isArray(m.memory_events)) return undefined;
  return v as TurnMeta;
}

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

// One message replayed into the runtime when restoring a chat. Assistant rows
// carry the owning user turn's id + retrieved refs to rebuild the badge/trace.
export interface RestoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  turn_message_id: string | null;
  retrieved: RetrievedRef[];
  memory_events: MemoryEvent[];
}
