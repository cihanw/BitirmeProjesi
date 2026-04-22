from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.api.endpoints import auth


class _FakeAdminAuth:
    def __init__(self) -> None:
        self.deleted_user_id: str | None = None
        self.should_soft_delete: bool | None = None

    def list_users(self, *, page: int, per_page: int):  # noqa: ANN001
        if page == 1:
            return [
                SimpleNamespace(email="deleted@example.com", deleted_at="2026-01-01"),
                SimpleNamespace(email="Active@Example.com", deleted_at=None),
            ]
        return []

    def delete_user(self, user_id: str, *, should_soft_delete: bool) -> None:
        self.deleted_user_id = user_id
        self.should_soft_delete = should_soft_delete


class _FakeTableDelete:
    def delete(self) -> "_FakeTableDelete":
        return self

    def eq(self, _column: str, _value: str) -> "_FakeTableDelete":
        return self

    def execute(self):  # noqa: ANN201
        return SimpleNamespace(data=[{"id": "user-1"}])


class _FakeSupabase:
    def __init__(self) -> None:
        self.auth = SimpleNamespace(admin=_FakeAdminAuth())

    def table(self, _name: str) -> _FakeTableDelete:
        return _FakeTableDelete()


class AuthEndpointTests(unittest.TestCase):
    def test_email_exists_ignores_deleted_users_and_normalizes_email(self) -> None:
        fake_supabase = _FakeSupabase()

        with patch("app.api.endpoints.auth.get_supabase", return_value=fake_supabase):
            self.assertFalse(auth.email_exists_in_supabase("deleted@example.com"))
            self.assertTrue(auth.email_exists_in_supabase(" active@example.com "))

    def test_delete_account_hard_deletes_auth_user(self) -> None:
        fake_supabase = _FakeSupabase()

        with patch("app.api.endpoints.auth.get_supabase", return_value=fake_supabase), \
             patch("app.api.endpoints.auth.mark_user_uploads_cancelled", return_value=0), \
             patch("app.api.endpoints.auth.SearchService") as search_service:
            search_service.return_value.clear_user_index_data.return_value = {
                "supabase": {},
                "local": {},
            }

            response = auth.delete_account(user_id="user-1")

        self.assertEqual(response["status"], "success")
        self.assertTrue(response["summary"]["auth_user_deleted"])
        self.assertEqual(fake_supabase.auth.admin.deleted_user_id, "user-1")
        self.assertFalse(fake_supabase.auth.admin.should_soft_delete)


if __name__ == "__main__":
    unittest.main()
