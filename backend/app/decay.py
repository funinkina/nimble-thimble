"""Recency * usage decay. Computed at read time so it is never stored stale.

A fresh, never-used memory scores ~USAGE_BASE (retrievable). Each retrieval bumps
use_count (usage weight climbs toward 1.0) and resets the recency clock. An old,
unused memory fades toward DECAY_FLOOR but is never deleted — it stays in the
inspector, just ranked lower.
"""
from __future__ import annotations

from datetime import datetime, timezone

from . import config


def _parse(ts: str | None) -> datetime | None:
    if not ts:
        return None
    return datetime.fromisoformat(ts)


def recency_weight(reference_ts: str | None, now: datetime | None = None) -> float:
    now = now or datetime.now(timezone.utc)
    ref = _parse(reference_ts)
    if ref is None:
        return 1.0
    days = max(0.0, (now - ref).total_seconds() / 86400.0)
    return 0.5 ** (days / config.DECAY_HALF_LIFE_DAYS)


def usage_weight(use_count: int) -> float:
    # USAGE_BASE for 0 uses, saturating toward 1.0 as use_count -> infinity
    climb = 1.0 - 0.5 ** (use_count / config.USAGE_SATURATION)
    return config.USAGE_BASE + (1.0 - config.USAGE_BASE) * climb


def decay_score(last_used_at: str | None, created_at: str, use_count: int,
                now: datetime | None = None) -> float:
    reference = last_used_at or created_at
    score = recency_weight(reference, now) * usage_weight(use_count)
    return max(config.DECAY_FLOOR, round(score, 4))
