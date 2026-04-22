from fastapi import APIRouter, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field

from app.db.supabase import get_supabase
from app.core.security import DEV_LOCAL_USER_ID, security, verify_jwt
from app.api.endpoints.upload import mark_user_uploads_cancelled
from app.services.search_service import SearchService

router = APIRouter()

AUTH_USER_LOOKUP_PAGE_SIZE = 200
AUTH_USER_LOOKUP_MAX_PAGES = 50


class EmailStatusPayload(BaseModel):
    email: str = Field(..., min_length=3, max_length=320)


def get_account_delete_user_id(
    credentials: HTTPAuthorizationCredentials | None = Security(security),
) -> str:
    if not credentials:
        raise HTTPException(status_code=401, detail="Authorization credentials were not provided")

    payload = verify_jwt(credentials)
    user_id = payload.get("sub")
    if not user_id or user_id == DEV_LOCAL_USER_ID:
        raise HTTPException(status_code=401, detail="A real authenticated user is required")

    return str(user_id)


def normalize_email(email: str) -> str:
    return email.strip().lower()


def email_exists_in_supabase(email: str) -> bool:
    supabase = get_supabase()
    normalized_email = normalize_email(email)

    for page in range(1, AUTH_USER_LOOKUP_MAX_PAGES + 1):
        users = supabase.auth.admin.list_users(
            page=page,
            per_page=AUTH_USER_LOOKUP_PAGE_SIZE,
        )

        for user in users:
            if getattr(user, "deleted_at", None):
                continue

            user_email = getattr(user, "email", None)
            if isinstance(user_email, str) and normalize_email(user_email) == normalized_email:
                return True

        if len(users) < AUTH_USER_LOOKUP_PAGE_SIZE:
            return False

    raise RuntimeError("Auth user lookup reached pagination limit")


@router.post("/auth/email-status")
def get_email_status(payload: EmailStatusPayload):
    email = normalize_email(payload.email)
    if "@" not in email:
        raise HTTPException(status_code=400, detail="Invalid email")

    try:
        exists = email_exists_in_supabase(email)
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"Email lookup unavailable: {error}")

    return {
        "exists": exists,
    }


@router.delete("/auth/account")
def delete_account(
    user_id: str = Security(get_account_delete_user_id),
):
    """
    Permanently deletes the current user and all app-owned records.
    The auth user is hard-deleted so the same email can sign up again.
    """
    try:
        supabase = get_supabase()
    except Exception as config_error:
        raise HTTPException(status_code=503, detail=f"Supabase unavailable: {config_error}")

    cancelled_uploads = mark_user_uploads_cancelled(user_id)

    try:
        cleanup_summary = SearchService().clear_user_index_data(user_id=user_id, strict=True)
    except Exception as cleanup_error:
        raise HTTPException(status_code=500, detail=f"Account data cleanup failed: {cleanup_error}")

    profiles_deleted = 0
    try:
        deleted_profiles = (
            supabase.table("profiles")
            .delete()
            .eq("id", user_id)
            .execute()
        )
        profiles_deleted = len(getattr(deleted_profiles, "data", None) or [])
    except Exception as profile_error:
        raise HTTPException(status_code=500, detail=f"Profile cleanup failed: {profile_error}")

    try:
        supabase.auth.admin.delete_user(user_id, should_soft_delete=False)
    except Exception as auth_error:
        raise HTTPException(status_code=500, detail=f"Auth user deletion failed: {auth_error}")

    return {
        "status": "success",
        "summary": {
            **cleanup_summary,
            "supabase": {
                **cleanup_summary.get("supabase", {}),
                "profiles_deleted": profiles_deleted,
            },
            "pending_uploads_cancelled": cancelled_uploads,
            "auth_user_deleted": True,
        },
    }
