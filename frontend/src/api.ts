import type {
  ChatResponse,
  Memory,
  MemoryStatus,
  Metrics,
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

export function postChat(message: string, signal?: AbortSignal): Promise<ChatResponse> {
  return req<ChatResponse>("/chat", {
    method: "POST",
    body: JSON.stringify({ message }),
    signal,
  });
}

export function getMemories(
  status?: MemoryStatus,
  scope?: Scope,
): Promise<Memory[]> {
  const q = new URLSearchParams();
  if (status) q.set("status", status);
  if (scope) q.set("scope", scope);
  const qs = q.toString();
  return req<Memory[]>(`/memories${qs ? `?${qs}` : ""}`);
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

export function getMetrics(): Promise<Metrics> {
  return req<Metrics>("/metrics");
}
