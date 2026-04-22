from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from app.services import ai_service


class _FakeResponse:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self._payload).encode("utf-8")


class AIServiceTests(unittest.TestCase):
    def test_edit_image_calls_gemini_image_model_and_returns_data_uri(self) -> None:
        captured_request = None

        def fake_urlopen(request, timeout: int):  # noqa: ANN001
            nonlocal captured_request
            captured_request = request
            self.assertEqual(timeout, 120)
            return _FakeResponse({
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {
                                    "inlineData": {
                                        "mimeType": "image/png",
                                        "data": "edited-image-b64",
                                    }
                                }
                            ]
                        }
                    }
                ]
            })

        with patch.object(ai_service.settings, "GEMINI_API_KEY", "test-gemini-key"), \
             patch.object(ai_service.settings, "GEMINI_IMAGE_MODEL", "gemini-3.1-flash-image-preview"), \
             patch("app.services.ai_service.urllib.request.urlopen", side_effect=fake_urlopen):
            result = ai_service.edit_image("make it cinematic", "input-image-b64")

        self.assertEqual(result["type"], "image")
        self.assertEqual(result["b64"], "data:image/png;base64,edited-image-b64")
        self.assertIsNotNone(captured_request)
        assert captured_request is not None
        self.assertIn(
            "/models/gemini-3.1-flash-image-preview:generateContent",
            captured_request.full_url,
        )
        self.assertEqual(captured_request.get_header("X-goog-api-key"), "test-gemini-key")

        payload = json.loads(captured_request.data.decode("utf-8"))
        parts = payload["contents"][0]["parts"]
        self.assertIn("make it cinematic", parts[0]["text"])
        self.assertEqual(parts[1]["inline_data"]["data"], "input-image-b64")
        self.assertEqual(payload["generationConfig"]["responseModalities"], ["IMAGE"])

    def test_edit_image_requires_gemini_api_key(self) -> None:
        with patch.object(ai_service.settings, "GEMINI_API_KEY", None):
            with self.assertRaisesRegex(RuntimeError, "GEMINI_API_KEY"):
                ai_service.edit_image("make it cinematic", "input-image-b64")


if __name__ == "__main__":
    unittest.main()
