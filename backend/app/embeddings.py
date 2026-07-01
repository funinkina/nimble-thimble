"""Local embeddings via fastembed. Vectors are L2-normalized so cosine = dot."""

from __future__ import annotations
from functools import lru_cache
import numpy as np
from . import config

_model = None


def _get_model():
    global _model
    if _model is None:
        from fastembed import TextEmbedding  # lazy: avoids slow import at module load

        _model = TextEmbedding(model_name=config.EMBED_MODEL)
    return _model


def embed(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    vecs = list(_get_model().embed(texts))
    out = []
    for v in vecs:
        v = np.asarray(v, dtype=np.float32)
        n = np.linalg.norm(v)
        if n > 0:
            v = v / n
        out.append(v.tolist())
    return out


@lru_cache(maxsize=2048)
def _embed_one_cached(text: str) -> tuple[float, ...]:
    return tuple(embed([text])[0])


def embed_one(text: str) -> list[float]:
    # deterministic (same text -> same vector); memoize repeated texts
    # (re-asked queries, re-embed on edit) to skip the model forward pass.
    return list(_embed_one_cached(text))


def cosine(a: list[float], b: list[float]) -> float:
    av, bv = np.asarray(a, dtype=np.float32), np.asarray(b, dtype=np.float32)
    return float(np.dot(av, bv))
