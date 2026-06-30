#!/usr/bin/env bash
# One-shot setup + run for the memory-chat app (macOS / Linux).
#   ./run.sh            install deps if needed, then run backend + frontend
#   ./run.sh --setup    install deps only, don't start servers
# Ctrl-C stops both servers.
#
# Never modifies your system: no global installs. Uses `uv` if you already have
# it, otherwise builds a project-local venv at backend/.venv with your own
# Python. Nothing is installed outside this repo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
BACKEND_PORT=8000
FRONTEND_PORT=5173

# deps mirror backend/pyproject.toml [project].dependencies (used only on the
# pip fallback; the uv path reads pyproject/uv.lock directly).
PY_DEPS=(
  "fastapi>=0.115"
  "uvicorn[standard]>=0.34"
  "groq>=0.13"
  "fastembed>=0.4"
  "sqlite-vec>=0.1.6"
  "numpy>=1.26"
  "python-dotenv>=1.0"
)

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '\033[36m▸ %s\033[0m\n' "$1"; }
warn() { printf '\033[33m! %s\033[0m\n' "$1"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

USE_UV=0          # 1 = drive backend through uv; 0 = use backend/.venv
VENV="$BACKEND/.venv"
VPY="$VENV/bin/python"

# ── backend toolchain detection (no installs) ───────────────────────────────
# Picks uv if present. Otherwise finds a system Python in [3.12, 3.14).
pick_python() {
  for cand in python3.13 python3.12 python3 python; do
    command -v "$cand" >/dev/null 2>&1 || continue
    if "$cand" -c 'import sys; raise SystemExit(0 if (3,12)<=sys.version_info[:2]<(3,14) else 1)' 2>/dev/null; then
      echo "$cand"; return 0
    fi
  done
  return 1
}

detect_backend() {
  if command -v uv >/dev/null 2>&1; then
    USE_UV=1
    info "Using uv for the backend"
    return
  fi
  warn "uv not found — falling back to a project-local venv (no system changes)"
  SYS_PY="$(pick_python || true)"
  [ -n "${SYS_PY:-}" ] || die "No suitable Python found. Need 3.12 or 3.13 (fastembed/onnxruntime lack 3.14 wheels). Install one, or install uv (https://docs.astral.sh/uv/), then re-run. Nothing was changed on your system."
  info "Using $("$SYS_PY" --version 2>&1) at $(command -v "$SYS_PY")"
}

ensure_node() {
  command -v npm >/dev/null 2>&1 && return
  die "Node.js / npm not found. Install Node 18+ from https://nodejs.org (or your package manager), then re-run."
}

# ── groq key ────────────────────────────────────────────────────────────────
has_key() {
  local f="$BACKEND/.env"
  [ -f "$f" ] || return 1
  grep -Eq '^[[:space:]]*GROQ_API_KEY=[[:space:]]*[^[:space:].].*' "$f"
}

GROQ_KEY=""
resolve_key() {
  if has_key; then info "Groq key found in backend/.env"; return; fi
  warn "No Groq key in backend/.env (get one at https://console.groq.com/keys)"
  if [ -t 0 ]; then read -rsp "Paste GROQ_API_KEY: " GROQ_KEY; echo
  else read -rsp "Paste GROQ_API_KEY: " GROQ_KEY < /dev/tty; echo; fi
  [ -n "$GROQ_KEY" ] || die "No key entered. Aborting."
  info "Key injected into the backend process for this run only (not written to disk)."
}

# ── install (project-local only) ────────────────────────────────────────────
setup() {
  if [ "$USE_UV" = 1 ]; then
    bold "Setting up backend (uv sync)…"
    ( cd "$BACKEND" && uv sync )
  else
    if [ ! -x "$VPY" ]; then
      bold "Creating backend venv at backend/.venv…"
      "$SYS_PY" -m venv "$VENV"
    fi
    bold "Setting up backend (pip install into backend/.venv)…"
    "$VPY" -m pip install --upgrade pip >/dev/null
    "$VPY" -m pip install "${PY_DEPS[@]}"
  fi
  bold "Setting up frontend (npm install)…"
  ( cd "$FRONTEND" && npm install )
}

# ── run ─────────────────────────────────────────────────────────────────────
PIDS=()
cleanup() {
  trap - INT TERM EXIT
  echo
  info "Stopping servers…"
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] || continue
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  info "Stopped."
}

backend_cmd() {
  if [ "$USE_UV" = 1 ]; then echo "uv run uvicorn app.main:app --port $BACKEND_PORT"
  else echo "$VPY -m uvicorn app.main:app --port $BACKEND_PORT"; fi
}

run() {
  trap cleanup INT TERM EXIT
  local SETSID=""
  command -v setsid >/dev/null 2>&1 && SETSID="setsid"

  bold "Starting backend  → http://localhost:$BACKEND_PORT"
  ( cd "$BACKEND" && exec env ${GROQ_KEY:+GROQ_API_KEY="$GROQ_KEY"} $SETSID $(backend_cmd) ) &
  PIDS+=("$!")

  bold "Starting frontend → http://localhost:$FRONTEND_PORT"
  ( cd "$FRONTEND" && exec $SETSID npm run dev -- --port "$FRONTEND_PORT" ) &
  PIDS+=("$!")

  echo
  bold "Both running. Open http://localhost:$FRONTEND_PORT"
  warn "First chat downloads the embedding model (~0.21 GB) once — initial reply is slow."
  info "Press Ctrl-C to stop both."
  wait -n 2>/dev/null || wait
}

# ── main ────────────────────────────────────────────────────────────────────
detect_backend
ensure_node
setup
if [ "${1:-}" = "--setup" ]; then bold "Setup complete. Run ./run.sh to start the servers."; exit 0; fi
resolve_key
run
