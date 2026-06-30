from fastapi import APIRouter

from .. import db, store
from ..models import Metrics

router = APIRouter()


@router.get("/metrics", response_model=Metrics)
def get_metrics(conversation_id: str):
    by_status = {
        r["status"]: r["n"]
        for r in db.query(
            "SELECT status, COUNT(*) AS n FROM memories WHERE conversation_id=? GROUP BY status",
            (conversation_id,),
        )
    }
    by_scope = {
        r["scope"]: r["n"]
        for r in db.query(
            "SELECT scope, COUNT(*) AS n FROM memories WHERE conversation_id=? GROUP BY scope",
            (conversation_id,),
        )
    }

    total_candidates = dedup_count = supersede_count = update_count = 0
    cosines: list[float] = []
    metas: list[dict] = []

    for t in store.all_traces(conversation_id):
        stage, p = t["stage"], t["payload"]
        if isinstance(p.get("llm"), dict):
            metas.append(p["llm"])
        if stage == "extract":
            total_candidates += len(p.get("candidates", []))
        elif stage == "dedup":
            for d in p.get("dropped", []):
                dedup_count += 1
                if isinstance(d.get("llm"), dict):
                    metas.append(d["llm"])
        elif stage == "conflict":
            for r in p.get("resolutions", []):
                if isinstance(r.get("llm"), dict):
                    metas.append(r["llm"])
                if r.get("action") == "superseded":
                    supersede_count += 1
                elif r.get("action") == "updated":
                    update_count += 1
        elif stage == "retrieve":
            cosines += [row["cosine"] for row in p.get("retrieved", [])]

    in_tok = sum(m.get("input_tokens", 0) for m in metas)
    out_tok = sum(m.get("output_tokens", 0) for m in metas)
    lat = [m.get("latency_ms", 0) for m in metas if m.get("latency_ms")]

    return Metrics(
        memories_by_status=by_status,
        memories_by_scope=by_scope,
        total_user_messages=store.count_user_messages(conversation_id),
        total_candidates=total_candidates,
        dedup_count=dedup_count,
        supersede_count=supersede_count,
        update_count=update_count,
        forgotten_count=by_status.get("forgotten", 0),
        avg_retrieval_cosine=round(sum(cosines) / len(cosines), 4) if cosines else 0.0,
        llm_calls=len(metas),
        llm_input_tokens=in_tok,
        llm_output_tokens=out_tok,
        avg_llm_latency_ms=round(sum(lat) / len(lat), 1) if lat else 0.0,
    )
