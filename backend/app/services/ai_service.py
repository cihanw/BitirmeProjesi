"""
ai_service.py - OpenAI gpt-image-1 powered GenAI service.

Modes:
  * edit_image -> OpenAI image edit, takes an existing photo plus an
                  instruction prompt, and returns an edited image data URI.

Rate limiting: simple in-memory rolling-hour bucket per user_id.
"""
from __future__ import annotations

import base64
import io
import threading
import time
from typing import Any

from app.core.config import settings

# ---------------------------------------------------------------------------
# Simple in-memory rate-limiter
# ---------------------------------------------------------------------------
_rate_store: dict[str, list[float]] = {}
_rate_lock = threading.Lock()


def check_rate_limit(user_id: str) -> tuple[bool, int]:
    """Return (is_allowed, requests_used_this_hour)."""
    limit = settings.AI_RATE_LIMIT_PER_HOUR
    now = time.time()
    window = 3600.0

    with _rate_lock:
        timestamps = _rate_store.get(user_id, [])
        timestamps = [t for t in timestamps if now - t < window]
        used = len(timestamps)

        if used >= limit:
            _rate_store[user_id] = timestamps
            return False, used

        timestamps.append(now)
        _rate_store[user_id] = timestamps
        return True, used + 1


def get_credits_remaining(user_id: str) -> int:
    """How many requests are left in the current hour window."""
    limit = settings.AI_RATE_LIMIT_PER_HOUR
    now = time.time()
    window = 3600.0

    with _rate_lock:
        timestamps = _rate_store.get(user_id, [])
        used = sum(1 for t in timestamps if now - t < window)
        return max(0, limit - used)


# ---------------------------------------------------------------------------
# OpenAI gpt-image-1 image editing
# ---------------------------------------------------------------------------

def _get_openai_client():  # type: ignore[return]
    """Return an initialised OpenAI client or raise RuntimeError."""
    from openai import OpenAI  # local import — only needed when this function runs

    api_key = settings.OPENAI_API_KEY
    if not api_key:
        raise RuntimeError(
            "OPENAI_API_KEY is not set. Add it to .env and restart the server."
        )
    return OpenAI(api_key=api_key)


def edit_image(prompt: str, image_b64: str) -> dict[str, Any]:
    """
    Send a photo + editing instruction to OpenAI gpt-image-1.

    Returns:
        {
            "type": "image",
            "b64": str,   # data-URI: data:image/png;base64,...
        }
    """
    client = _get_openai_client()

    # Decode the raw base64 → bytes → in-memory PNG file object
    image_bytes = base64.b64decode(image_b64)
    image_file = io.BytesIO(image_bytes)
    image_file.name = "photo.png"  # OpenAI SDK reads the .name attribute for mime detection

    try:
        response = client.images.edit(
            model="gpt-image-1",
            image=image_file,
            prompt=prompt,
            n=1,
            size="1024x1024",
        )
    except Exception as exc:
        error_msg = str(exc)
        raise RuntimeError(f"OpenAI image edit failed: {error_msg}") from exc

    # gpt-image-1 always returns b64_json
    b64_data = response.data[0].b64_json
    if not b64_data:
        raise RuntimeError("OpenAI response did not include image data.")

    return {
        "type": "image",
        "b64": f"data:image/png;base64,{b64_data}",
    }


def decode_image_uri(image_uri: str) -> str:
    """
    Accept a data-URI (data:image/jpeg;base64,...) and return the raw base64 string.
    Raises ValueError if the URI is malformed.
    """
    if not image_uri.startswith("data:"):
        raise ValueError("image_uri must be a data-URI")

    _, _, data = image_uri.partition(",")
    if not data:
        raise ValueError("data-URI has no payload")

    return data
