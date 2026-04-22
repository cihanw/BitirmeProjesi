"""
ai.py — Phase 7: /api/ai/edit endpoint.

POST /api/ai/edit
  Body (JSON):
    {
      "prompt":    str   required  — editing instruction e.g. "make the sky dramatic"
      "image_uri": str   required  — data-URI of the photo (data:image/jpeg;base64,...)
    }

  Returns:
    {
      "url":               str   — CDN URL of the AI-edited image (~1 hour expiry)
      "credits_remaining": int
    }

Rate limiting: AI_RATE_LIMIT_PER_HOUR requests per user per hour (default 10).
In DEV_BYPASS_AUTH mode user_id is "dev_user".
"""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, field_validator

from app.core.config import settings
from app.services.ai_service import (
    check_rate_limit,
    decode_image_uri,
    edit_image,
    get_credits_remaining,
)

router = APIRouter()


# ---------------------------------------------------------------------------
# Auth helper
# ---------------------------------------------------------------------------

def _resolve_user_id(authorization: str | None) -> str:
    if settings.DEV_BYPASS_AUTH:
        return "dev_user"

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

    token = authorization.removeprefix("Bearer ").strip()

    try:
        import jwt  # type: ignore[import]

        if not settings.JWT_SECRET:
            raise HTTPException(status_code=500, detail="JWT_SECRET is not configured")

        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=["HS256"])
        user_id: str = payload.get("sub") or payload.get("user_id") or ""
        if not user_id:
            raise HTTPException(status_code=401, detail="Token has no user_id/sub claim")
        return user_id
    except Exception as exc:
        raise HTTPException(status_code=401, detail=f"Invalid token: {exc}") from exc


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class EditRequest(BaseModel):
    prompt: str
    image_uri: str  # required for edit

    @field_validator("prompt")
    @classmethod
    def prompt_not_empty(cls, v: str) -> str:
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("prompt must not be empty")
        if len(cleaned) > 1000:
            raise ValueError("prompt must be 1000 characters or fewer")
        return cleaned

    @field_validator("image_uri")
    @classmethod
    def image_uri_not_empty(cls, v: str) -> str:
        if not v or not v.startswith("data:"):
            raise ValueError("image_uri must be a base64 data-URI")
        return v


class EditResponse(BaseModel):
    b64: str           # data-URI of the edited image (data:image/png;base64,...)
    credits_remaining: int


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.post("/ai/edit", response_model=EditResponse)
async def ai_edit(
    body: EditRequest,
    authorization: str | None = Header(default=None),
) -> EditResponse:
    """
    Edit a photo with AI using OpenAI gpt-image-1.

    The client sends the current photo as a base64 data-URI together with
    a natural-language editing instruction. The backend forwards the image
    and prompt to OpenAI, then returns the generated image as a data URI.
    """
    if not settings.OPENAI_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="AI service is not configured. Set OPENAI_API_KEY in server .env.",
        )

    user_id = _resolve_user_id(authorization)

    # Rate-limit check
    allowed, _ = check_rate_limit(user_id)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail={
                "error": "rate_limit_exceeded",
                "message": f"You have used all {settings.AI_RATE_LIMIT_PER_HOUR} AI edits for this hour. Please try again later.",
                "credits_remaining": 0,
            },
        )

    credits_remaining = get_credits_remaining(user_id)

    try:
        image_b64 = decode_image_uri(body.image_uri)
        result = edit_image(body.prompt, image_b64)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        error_msg = str(exc)
        if "quota" in error_msg.lower() or "billing" in error_msg.lower() or "insufficient_quota" in error_msg.lower():
            raise HTTPException(
                status_code=402,
                detail="OpenAI quota exceeded. Please check your billing settings.",
            ) from exc
        if "content_policy" in error_msg or "safety" in error_msg.lower() or "prohibited" in error_msg.lower():
            raise HTTPException(
                status_code=400,
                detail="Your prompt was rejected by the content safety filter. Try a different instruction.",
            ) from exc
        raise HTTPException(
            status_code=500,
            detail=f"AI edit failed: {error_msg}",
        ) from exc

    return EditResponse(
        b64=result["b64"],
        credits_remaining=credits_remaining,
    )
