from fastapi import APIRouter

from .. import store
from ..models import TraceOut

router = APIRouter()


@router.get("/traces/{message_id}", response_model=list[TraceOut])
def get_traces(message_id: str):
    return store.traces_for(message_id)
