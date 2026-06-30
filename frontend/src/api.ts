import type {
  ChatResponse,
  Conversation,
  Memory,
  MemoryRevision,
  MemoryStatus,
  Metrics,
  RestoredMessage,
  Scope,
  Trace,
} from "./types";

const BASE = "http://localhost:8000";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ""}`);
  }
  return res.json() as Promise<T>;
}

export function postChat(
  message: string,
  conversationId: string,
  signal?: AbortSignal,
): Promise<ChatResponse> {
  return req<ChatResponse>("/chat", {
    method: "POST",
    body: JSON.stringify({ message, conversation_id: conversationId }),
    signal,
  });
}

export function getMemories(
  conversationId: string,
  status?: MemoryStatus,
  scope?: Scope,
): Promise<Memory[]> {
  const q = new URLSearchParams({ conversation_id: conversationId });
  if (status) q.set("status", status);
  if (scope) q.set("scope", scope);
  return req<Memory[]>(`/memories?${q.toString()}`);
}

export function getMemoryRevisions(id: string): Promise<MemoryRevision[]> {
  return req<MemoryRevision[]>(`/memories/${id}/revisions`);
}

export function listConversations(): Promise<Conversation[]> {
  return req<Conversation[]>("/conversations");
}

export function createConversation(title = ""): Promise<Conversation> {
  return req<Conversation>("/conversations", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
}

export function getConversationMessages(id: string): Promise<RestoredMessage[]> {
  return req<RestoredMessage[]>(`/conversations/${id}/messages`);
}

export function deleteConversation(id: string): Promise<{ deleted: string }> {
  return req<{ deleted: string }>(`/conversations/${id}`, { method: "DELETE" });
}

export function patchMemory(
  id: string,
  body: { text?: string; forget?: boolean },
): Promise<Memory> {
  return req<Memory>(`/memories/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteMemory(id: string): Promise<{ deleted: string }> {
  return req<{ deleted: string }>(`/memories/${id}`, { method: "DELETE" });
}

export function getTraces(messageId: string): Promise<Trace[]> {
  return req<Trace[]>(`/traces/${messageId}`);
}

export function getMetrics(conversationId: string): Promise<Metrics> {
  return req<Metrics>(`/metrics?conversation_id=${encodeURIComponent(conversationId)}`);
}
