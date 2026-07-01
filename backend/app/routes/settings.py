from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config, settings

router = APIRouter()


@router.get("/settings")
def get_settings():
    return {
        "spec": config.SETTINGS_SPEC,
        "values": settings.current(),
        "defaults": config.SETTINGS_DEFAULTS,
        "info": config.INFO_FIELDS,
    }


class SettingsPatch(BaseModel):
    changes: dict


@router.patch("/settings")
def patch_settings(body: SettingsPatch):
    try:
        return settings.update(body.changes)
    except ValueError as e:
        raise HTTPException(422, str(e))


@router.post("/settings/reset")
def reset_settings():
    return settings.reset()
