"""Runtime-editable settings, persisted in the `settings` table and mirrored onto
the config module. Every knob here is read fresh on each pipeline call, so mutating
the module attribute takes effect immediately — no restart, no rebuild.

Startup applies saved overrides via load_from_db(); the API validates against
config.SETTINGS_SPEC, persists, then mutates config in one step.
"""

from __future__ import annotations

import json

from . import config, db

_SPEC = {s["key"]: s for s in config.SETTINGS_SPEC}


def _coerce(spec: dict, raw):
    t = spec["type"]
    if t == "bool":
        return bool(raw)
    if t == "int":
        return int(raw)
    if t == "float":
        return float(raw)
    raise ValueError(f"unknown type {t}")


def _validate(spec: dict, val):
    if spec["type"] in ("int", "float"):
        lo, hi = spec.get("min"), spec.get("max")
        if lo is not None and val < lo:
            raise ValueError(f"{spec['key']} must be >= {lo}")
        if hi is not None and val > hi:
            raise ValueError(f"{spec['key']} must be <= {hi}")


def current() -> dict:
    return {k: getattr(config, k) for k in config.EDITABLE_KEYS}


def load_from_db() -> None:
    """Apply persisted overrides onto the config module at startup. Bad/stale rows
    (renamed key, out-of-range) are skipped rather than crashing boot."""
    for row in db.query("SELECT key, value FROM settings"):
        spec = _SPEC.get(row["key"])
        if not spec:
            continue
        try:
            val = _coerce(spec, json.loads(row["value"]))
            _validate(spec, val)
        except (ValueError, TypeError, json.JSONDecodeError):
            continue
        setattr(config, row["key"], val)


def update(changes: dict) -> dict:
    """Validate every change, then persist + apply atomically. Raises ValueError on
    the first bad key/value so nothing partial is written."""
    if not isinstance(changes, dict) or not changes:
        raise ValueError("no changes provided")
    applied: dict = {}
    for key, raw in changes.items():
        spec = _SPEC.get(key)
        if not spec:
            raise ValueError(f"unknown or non-editable setting: {key}")
        val = _coerce(spec, raw)
        _validate(spec, val)
        applied[key] = val
    # Keep the ordering invariant the pipeline assumes: a candidate must be able to
    # reach the LLM judge band, so CONFLICT_LOW < DEDUP_THRESHOLD after the change.
    merged = {**current(), **applied}
    if merged["CONFLICT_LOW"] >= merged["DEDUP_THRESHOLD"]:
        raise ValueError("CONFLICT_LOW must be less than DEDUP_THRESHOLD")

    def _do(c):
        for k, v in applied.items():
            c.execute(
                "INSERT INTO settings(key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (k, json.dumps(v)),
            )

    db.write(_do)
    for k, v in applied.items():
        setattr(config, k, v)
    return current()


def reset() -> dict:
    """Drop all overrides and restore the code defaults captured at import."""
    db.write(lambda c: c.execute("DELETE FROM settings"))
    for k, v in config.SETTINGS_DEFAULTS.items():
        setattr(config, k, v)
    return current()
