"""Fast, dependency-light smoke tests — no network, no model download.

Guards the deterministic pieces that are easy to break silently: the trace-payload
JSON guard, Groq strict-schema derivation, and embedding cosine.
"""

from app import embeddings, store
from app.llm import _groq_schema
from app.models import Judgment


def test_loads_degrades_on_garbage():
    assert store._loads("not json") == {}
    assert store._loads(None) == {}
    assert store._loads("[1,2,3]") == {}  # non-dict -> {}
    assert store._loads('{"a": 1}') == {"a": 1}


def test_groq_schema_is_strict():
    s = _groq_schema(Judgment)
    assert s["type"] == "object"
    assert s["additionalProperties"] is False
    # every property must be required under Groq strict mode
    assert set(s["required"]) == set(s["properties"].keys())


def test_groq_schema_strips_numeric_bounds():
    # Candidate.confidence has ge/le; strict mode rejects those keys.
    from app.models import Candidate

    conf = _groq_schema(Candidate)["properties"]["confidence"]
    assert "minimum" not in conf and "maximum" not in conf


def test_cosine_of_identical_is_one():
    a = [0.6, 0.8]
    assert abs(embeddings.cosine(a, a) - 1.0) < 1e-6
