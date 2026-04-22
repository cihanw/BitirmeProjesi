from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.services import pipeline


class _FakeSupabaseTable:
    def __init__(self, client: "_FakeSupabase", name: str) -> None:
        self.client = client
        self.name = name
        self.operation: str | None = None

    def upsert(self, payload, on_conflict: str | None = None) -> "_FakeSupabaseTable":
        self.operation = "upsert"
        self.client.upserts.append({
            "table": self.name,
            "payload": payload,
            "on_conflict": on_conflict,
        })
        return self

    def insert(self, payload) -> "_FakeSupabaseTable":
        self.operation = "insert"
        self.client.inserts.append({
            "table": self.name,
            "payload": payload,
        })
        return self

    def execute(self) -> SimpleNamespace:
        if self.name == "images" and self.operation == "upsert":
            return SimpleNamespace(data=[{"uuid": "stored-image-1"}])
        return SimpleNamespace(data=[])


class _FakeSupabase:
    def __init__(self) -> None:
        self.upserts: list[dict] = []
        self.inserts: list[dict] = []

    def table(self, name: str) -> _FakeSupabaseTable:
        return _FakeSupabaseTable(self, name)


class PipelineImageEmbeddingFlowTests(unittest.TestCase):
    def test_process_image_stores_siglip2_image_embedding_only(self) -> None:
        fast_faces = [{"bbox": [0.0, 0.0, 10.0, 10.0], "embedding": [0.1, 0.2]}]

        with patch("app.db.supabase.get_supabase", side_effect=Exception("disabled")), \
             patch("app.services.face_service.detect_and_encode_faces_with_attempt", return_value=(fast_faces, "expensive")) as mocked_detect, \
             patch("app.services.pipeline.build_content_hash", return_value="hash"), \
             patch("app.services.pipeline.generate_image_embedding", return_value=[0.3, 0.4, 0.5]), \
             patch("app.services.pipeline.assign_faces_to_clusters", return_value=([], [])), \
             patch("app.services.pipeline.save_index_record") as mocked_save_index_record, \
             patch("app.services.pipeline.os.path.exists", return_value=False):
            pipeline.process_image(
                image_path="ignored.jpg",
                user_id="user-1",
                photo_id="photo-1",
                image_uuid="image-1",
            )

        self.assertEqual(mocked_detect.call_count, 1)
        self.assertEqual(mocked_detect.call_args.kwargs["detection_mode"], "expensive")

        saved_record = mocked_save_index_record.call_args.args[0]
        self.assertEqual(saved_record["embedding"], [0.3, 0.4, 0.5])
        self.assertEqual(saved_record["content_hash"], "hash")
        self.assertNotIn("caption", saved_record)
        self.assertNotIn("tags", saved_record)

    def test_expensive_face_miss_does_not_run_fallback(self) -> None:
        with patch("app.db.supabase.get_supabase", side_effect=Exception("disabled")), \
             patch("app.services.face_service.detect_and_encode_faces_with_attempt", return_value=([], None)) as mocked_detect, \
             patch("app.services.pipeline.build_content_hash", return_value="hash"), \
             patch("app.services.pipeline.generate_image_embedding", return_value=[0.3, 0.4, 0.5]), \
             patch("app.services.pipeline.assign_faces_to_clusters", return_value=([], [])), \
             patch("app.services.pipeline.save_index_record"), \
             patch("app.services.pipeline.os.path.exists", return_value=False):
            pipeline.process_image(
                image_path="ignored.jpg",
                user_id="user-1",
                photo_id="photo-1",
                image_uuid="image-1",
            )

        self.assertEqual(mocked_detect.call_count, 1)
        self.assertEqual(mocked_detect.call_args.kwargs["detection_mode"], "expensive")

    def test_cancelled_pipeline_skips_model_work_and_persistence(self) -> None:
        with patch("app.db.supabase.get_supabase", side_effect=Exception("disabled")), \
             patch("app.services.pipeline.build_content_hash") as mocked_hash, \
             patch("app.services.pipeline.generate_image_embedding") as mocked_embedding, \
             patch("app.services.pipeline.save_index_record") as mocked_save_index_record, \
             patch("app.services.pipeline.os.path.exists", return_value=False):
            pipeline.process_image(
                image_path="ignored.jpg",
                user_id="user-1",
                photo_id="photo-1",
                image_uuid="image-1",
                is_cancelled=lambda: True,
            )

        mocked_hash.assert_not_called()
        mocked_embedding.assert_not_called()
        mocked_save_index_record.assert_not_called()

    def test_process_image_upserts_face_cluster_centroid_to_supabase(self) -> None:
        fake_supabase = _FakeSupabase()
        face_records = [
            {
                "cluster_id": "cluster-1",
                "cluster_name": "Person 1",
                "bounding_box": [1.0, 2.0, 3.0, 4.0],
            }
        ]
        cluster_records = [
            {
                "id": "cluster-1",
                "user_id": "user-1",
                "name": "Person 1",
                "centroid": [0.1, 0.2],
                "sample_count": 2,
            }
        ]

        with patch("app.db.supabase.get_supabase", return_value=fake_supabase), \
             patch("app.services.face_service.detect_and_encode_faces_with_attempt", return_value=([], "expensive")), \
             patch("app.services.pipeline.build_content_hash", return_value="hash"), \
             patch("app.services.pipeline.generate_image_embedding", return_value=[0.3, 0.4, 0.5]), \
             patch("app.services.pipeline.assign_faces_to_clusters", return_value=(face_records, cluster_records)), \
             patch("app.services.pipeline.save_index_record"), \
             patch("app.services.pipeline.os.path.exists", return_value=False):
            pipeline.process_image(
                image_path="ignored.jpg",
                user_id="user-1",
                photo_id="photo-1",
                image_uuid="image-1",
            )

        cluster_upsert = next(
            item for item in fake_supabase.upserts
            if item["table"] == "face_clusters"
        )
        self.assertEqual(cluster_upsert["on_conflict"], "id")
        self.assertEqual(cluster_upsert["payload"][0]["id"], "cluster-1")
        self.assertEqual(cluster_upsert["payload"][0]["centroid"], [0.1, 0.2])
        self.assertEqual(cluster_upsert["payload"][0]["sample_count"], 2)
        self.assertEqual(cluster_upsert["payload"][0]["cover_image_uuid"], "stored-image-1")
        self.assertEqual(cluster_upsert["payload"][0]["cover_photo_id"], "photo-1")


if __name__ == "__main__":
    unittest.main()
