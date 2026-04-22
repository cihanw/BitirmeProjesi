from __future__ import annotations

import unittest
from io import BytesIO
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi import BackgroundTasks, UploadFile

from app.api.endpoints import upload


def make_upload_file(filename: str = "photo.jpg") -> UploadFile:
    return UploadFile(file=BytesIO(b"fake-image"), filename=filename)


class UploadEndpointDuplicateTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        upload._PENDING_UPLOADS.clear()
        upload._CANCELLED_UPLOAD_USERS.clear()

    def tearDown(self) -> None:
        upload._PENDING_UPLOADS.clear()
        upload._CANCELLED_UPLOAD_USERS.clear()

    async def test_already_processed_photo_skips_background_pipeline(self) -> None:
        background_tasks = BackgroundTasks()

        with patch("app.api.endpoints.upload._find_existing_image_uuid", return_value="existing-image"):
            response = await upload.upload_image(
                background_tasks=background_tasks,
                photo_id=" photo-1 ",
                captured_at=None,
                file=make_upload_file(),
                user_id="user-1",
            )

        self.assertEqual(response["status"], "already_processed")
        self.assertEqual(response["photo_id"], "photo-1")
        self.assertEqual(response["image_uuid"], "existing-image")
        self.assertEqual(len(background_tasks.tasks), 0)
        self.assertEqual(upload._PENDING_UPLOADS, {})

    async def test_in_flight_duplicate_photo_skips_second_pipeline_queue(self) -> None:
        first_tasks = BackgroundTasks()
        second_tasks = BackgroundTasks()

        with TemporaryDirectory() as temp_dir, \
             patch("app.api.endpoints.upload.TEMP_UPLOAD_DIR", temp_dir), \
             patch("app.api.endpoints.upload._find_existing_image_uuid", return_value=None), \
             patch("app.api.endpoints.upload.uuid4", return_value="queued-image"):
            first_response = await upload.upload_image(
                background_tasks=first_tasks,
                photo_id="photo-1",
                captured_at=None,
                file=make_upload_file("first.jpg"),
                user_id="user-1",
            )
            second_response = await upload.upload_image(
                background_tasks=second_tasks,
                photo_id="photo-1",
                captured_at=None,
                file=make_upload_file("second.jpg"),
                user_id="user-1",
            )

        self.assertEqual(first_response["status"], "success")
        self.assertEqual(first_response["image_uuid"], "queued-image")
        self.assertEqual(len(first_tasks.tasks), 1)
        self.assertEqual(second_response["status"], "already_queued")
        self.assertEqual(second_response["image_uuid"], "queued-image")
        self.assertEqual(len(second_tasks.tasks), 0)

    async def test_cancelled_user_upload_rejects_without_queueing_pipeline(self) -> None:
        background_tasks = BackgroundTasks()
        upload.mark_user_uploads_cancelled("user-1")

        with self.assertRaises(Exception) as raised:
            await upload.upload_image(
                background_tasks=background_tasks,
                photo_id="photo-1",
                captured_at=None,
                file=make_upload_file(),
                user_id="user-1",
            )

        self.assertEqual(getattr(raised.exception, "status_code", None), 410)
        self.assertEqual(len(background_tasks.tasks), 0)


if __name__ == "__main__":
    unittest.main()
