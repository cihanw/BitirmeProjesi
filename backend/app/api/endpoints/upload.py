from fastapi import APIRouter, UploadFile, File, Form, Depends, HTTPException, BackgroundTasks
import shutil
import os
from threading import Lock
from uuid import uuid4
from app.core.security import get_current_user_id
from app.services.local_index_store import get_index_record_for_photo

router = APIRouter()

TEMP_UPLOAD_DIR = "tmp/smart_gallery_uploads"
os.makedirs(TEMP_UPLOAD_DIR, exist_ok=True)

_PENDING_UPLOADS: dict[tuple[str, str], str] = {}
_CANCELLED_UPLOAD_USERS: set[str] = set()
_PENDING_UPLOADS_LOCK = Lock()


def _find_existing_image_uuid(user_id: str, photo_id: str) -> str | None:
    local_record = get_index_record_for_photo(user_id, photo_id)
    if local_record and local_record.get("uuid"):
        return str(local_record["uuid"])

    try:
        from app.db.supabase import get_supabase

        response = (
            get_supabase()
            .table("images")
            .select("uuid")
            .eq("user_id", user_id)
            .eq("photo_id", photo_id)
            .limit(1)
            .execute()
        )
    except Exception:
        return None

    rows = getattr(response, "data", None) or []
    if not rows:
        return None

    image_uuid = rows[0].get("uuid")
    return str(image_uuid) if image_uuid else None


def _release_pending_upload(key: tuple[str, str]) -> None:
    with _PENDING_UPLOADS_LOCK:
        _PENDING_UPLOADS.pop(key, None)


def _is_user_upload_cancelled(user_id: str) -> bool:
    with _PENDING_UPLOADS_LOCK:
        return user_id in _CANCELLED_UPLOAD_USERS


def mark_user_uploads_cancelled(user_id: str) -> int:
    with _PENDING_UPLOADS_LOCK:
        _CANCELLED_UPLOAD_USERS.add(user_id)
        pending_keys = [
            key for key in _PENDING_UPLOADS
            if key[0] == user_id
        ]
        for key in pending_keys:
            _PENDING_UPLOADS.pop(key, None)

    return len(pending_keys)


def _process_image_and_release(
    image_path: str,
    user_id: str,
    photo_id: str,
    image_uuid: str,
    captured_at: str | None,
    pending_key: tuple[str, str],
) -> None:
    try:
        if _is_user_upload_cancelled(user_id):
            return

        from app.services.pipeline import process_image

        process_image(
            image_path,
            user_id,
            photo_id,
            image_uuid,
            captured_at,
            is_cancelled=lambda: _is_user_upload_cancelled(user_id),
        )
    finally:
        _release_pending_upload(pending_key)
        if os.path.exists(image_path):
            os.remove(image_path)


@router.post("/upload")
async def upload_image(
    background_tasks: BackgroundTasks,
    photo_id: str = Form(...),
    captured_at: str | None = Form(None),
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user_id),
):
    """
    Accepts an image and photo_id from the mobile client.
    Saves to tmp and pushes the heavy AI pipeline to the background.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    cleaned_photo_id = photo_id.strip()
    if not cleaned_photo_id:
        raise HTTPException(status_code=400, detail="photo_id is required")

    if _is_user_upload_cancelled(user_id):
        raise HTTPException(status_code=410, detail="User upload processing has been cancelled")

    existing_image_uuid = _find_existing_image_uuid(user_id, cleaned_photo_id)
    if existing_image_uuid:
        return {
            "status": "already_processed",
            "message": "Image already processed",
            "photo_id": cleaned_photo_id,
            "user_id": user_id,
            "image_uuid": existing_image_uuid,
        }

    pending_key = (user_id, cleaned_photo_id)
    image_uuid = str(uuid4())
    with _PENDING_UPLOADS_LOCK:
        if user_id in _CANCELLED_UPLOAD_USERS:
            raise HTTPException(status_code=410, detail="User upload processing has been cancelled")

        pending_image_uuid = _PENDING_UPLOADS.get(pending_key)
        if pending_image_uuid:
            return {
                "status": "already_queued",
                "message": "Image already queued for processing",
                "photo_id": cleaned_photo_id,
                "user_id": user_id,
                "image_uuid": pending_image_uuid,
            }

        _PENDING_UPLOADS[pending_key] = image_uuid

    # 1. Ephemeral Save: Temporarily store the file
    tmp_path = os.path.join(TEMP_UPLOAD_DIR, f"{image_uuid}_{os.path.basename(file.filename)}")
    try:
        with open(tmp_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        # 2. Trigger Intelligence Pipeline in the background
        # It handles SigLIP2 image embeddings, InsightFace, Supabase limits, and cleanup.
        background_tasks.add_task(
            _process_image_and_release,
            tmp_path,
            user_id,
            cleaned_photo_id,
            image_uuid,
            captured_at,
            pending_key,
        )

        return {
            "status": "success",
            "message": "Image queued for processing",
            "photo_id": cleaned_photo_id,
            "user_id": user_id,
            "image_uuid": image_uuid,
        }
    except Exception as e:
        # If it fails before enqueuing, wipe the file immediately
        _release_pending_upload(pending_key)
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")
