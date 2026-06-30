"""Local cross-encoder reranker (fastembed). A bi-encoder (the embedder) scores
query and memory independently; a cross-encoder reads them together, so it ranks
a shortlist far more accurately. Used as the final stage of hybrid retrieval.

Model downloads once on first use, like the embed model. No API key.
"""

from __future__ import annotations

from . import config

_model = None


def _get_model():
    global _model
    if _model is None:
        from fastembed.rerank.cross_encoder import TextCrossEncoder  # lazy import

        _model = TextCrossEncoder(model_name=config.RERANK_MODEL)
    return _model


def rerank(query: str, documents: list[str]) -> list[float]:
    """Relevance score per document against the query, aligned to input order.
    Higher = more relevant. Empty input -> empty output."""
    if not documents:
        return []
    return list(_get_model().rerank(query, documents))
