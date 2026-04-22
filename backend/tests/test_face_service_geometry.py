from __future__ import annotations

import unittest
from unittest.mock import patch

import numpy as np

from app.services import face_service


class FaceServiceGeometryTests(unittest.TestCase):
    def test_min_face_score_filters_low_confidence_detections(self) -> None:
        class DummyFace:
            bbox = np.array([5.0, 5.0, 20.0, 20.0], dtype=np.float32)
            embedding = np.array([0.1, 0.2], dtype=np.float32)
            det_score = 0.60

        class DummyModel:
            def get(self, _img: np.ndarray) -> list[DummyFace]:
                return [DummyFace()]

        with patch("app.services.face_service.prepare_detection_image", return_value=(np.zeros((32, 32, 3), dtype=np.uint8), np.eye(3, dtype=np.float32))), \
             patch("app.services.face_service.get_face_model", return_value=DummyModel()), \
             patch("app.services.face_service.map_bbox_to_original", return_value=[5.0, 5.0, 20.0, 20.0]):
            filtered_faces = face_service.run_detection_attempt(
                np.zeros((32, 32, 3), dtype=np.uint8),
                det_size=(640, 640),
                det_thresh=0.5,
                min_face_score=0.70,
            )
            accepted_faces = face_service.run_detection_attempt(
                np.zeros((32, 32, 3), dtype=np.uint8),
                det_size=(640, 640),
                det_thresh=0.5,
                min_face_score=0.50,
            )

        self.assertEqual(filtered_faces, [])
        self.assertEqual(len(accepted_faces), 1)
        self.assertAlmostEqual(float(accepted_faces[0]["score"]), 0.60, delta=1e-6)

    def test_min_face_box_edge_filters_tiny_detections(self) -> None:
        class DummyFace:
            def __init__(self, bbox: list[float]) -> None:
                self.bbox = np.array(bbox, dtype=np.float32)
                self.embedding = np.array([0.1, 0.2], dtype=np.float32)
                self.det_score = 0.95

        class DummyModel:
            def get(self, _img: np.ndarray) -> list[DummyFace]:
                return [
                    DummyFace([5.0, 5.0, 20.0, 24.0]),
                    DummyFace([40.0, 40.0, 90.0, 92.0]),
                ]

        with patch("app.services.face_service.get_face_model", return_value=DummyModel()):
            filtered_faces = face_service.run_detection_attempt(
                np.zeros((128, 128, 3), dtype=np.uint8),
                det_size=(640, 640),
                det_thresh=0.5,
                min_face_score=0.70,
                min_face_box_edge=32.0,
            )

        self.assertEqual(len(filtered_faces), 1)
        self.assertEqual(filtered_faces[0]["bbox"], [40.0, 40.0, 90.0, 92.0])

    def test_center_crop_bbox_maps_back_to_original_coordinates(self) -> None:
        original = np.zeros((1000, 800, 3), dtype=np.uint8)
        original_bbox = [250.0, 200.0, 550.0, 700.0]

        processed_img, forward_matrix = face_service.prepare_detection_image(
            original,
            crop_ratio=0.85,
            target_min_edge=1800,
        )

        self.assertGreater(processed_img.shape[0], original.shape[0] // 2)

        original_points = np.array(
            [
                [original_bbox[0], original_bbox[1]],
                [original_bbox[2], original_bbox[1]],
                [original_bbox[2], original_bbox[3]],
                [original_bbox[0], original_bbox[3]],
            ],
            dtype=np.float32,
        )
        processed_points = face_service.transform_points(forward_matrix, original_points)
        processed_bbox = [
            float(np.min(processed_points[:, 0])),
            float(np.min(processed_points[:, 1])),
            float(np.max(processed_points[:, 0])),
            float(np.max(processed_points[:, 1])),
        ]

        remapped_bbox = face_service.map_bbox_to_original(
            processed_bbox,
            forward_matrix=forward_matrix,
            original_width=original.shape[1],
            original_height=original.shape[0],
        )

        for remapped, expected in zip(remapped_bbox, original_bbox):
            self.assertAlmostEqual(remapped, expected, delta=1.0)

    def test_rotated_bbox_center_maps_back_inside_original_bounds(self) -> None:
        original = np.zeros((900, 700, 3), dtype=np.uint8)
        original_center = np.array([[350.0, 420.0]], dtype=np.float32)

        _processed_img, forward_matrix = face_service.prepare_detection_image(
            original,
            rotation_angle=15.0,
        )
        processed_center = face_service.transform_points(forward_matrix, original_center)[0]
        processed_bbox = [
            float(processed_center[0] - 20.0),
            float(processed_center[1] - 20.0),
            float(processed_center[0] + 20.0),
            float(processed_center[1] + 20.0),
        ]

        remapped_bbox = face_service.map_bbox_to_original(
            processed_bbox,
            forward_matrix=forward_matrix,
            original_width=original.shape[1],
            original_height=original.shape[0],
        )
        remapped_center = (
            (remapped_bbox[0] + remapped_bbox[2]) / 2.0,
            (remapped_bbox[1] + remapped_bbox[3]) / 2.0,
        )

        self.assertAlmostEqual(remapped_center[0], float(original_center[0][0]), delta=2.5)
        self.assertAlmostEqual(remapped_center[1], float(original_center[0][1]), delta=2.5)
        self.assertGreaterEqual(remapped_bbox[0], 0.0)
        self.assertGreaterEqual(remapped_bbox[1], 0.0)
        self.assertLessEqual(remapped_bbox[2], original.shape[1] - 1)
        self.assertLessEqual(remapped_bbox[3], original.shape[0] - 1)

    def test_detection_stops_after_default_success(self) -> None:
        fake_face = [{"bbox": [0.0, 0.0, 10.0, 10.0], "embedding": [0.1, 0.2]}]

        with patch("app.services.face_service.run_detection_attempt", side_effect=[fake_face]) as mocked_attempt:
            result = face_service.detect_faces_in_image(
                np.zeros((128, 128, 3), dtype=np.uint8),
                enable_hard_portrait_fallback=True,
            )

        self.assertEqual(result.attempt_label, "default")
        self.assertEqual(result.faces, fake_face)
        self.assertEqual(mocked_attempt.call_count, 1)

    def test_fast_mode_only_runs_default_attempt(self) -> None:
        with patch("app.services.face_service.run_detection_attempt", return_value=[]) as mocked_attempt:
            result = face_service.detect_faces_in_image(
                np.zeros((128, 128, 3), dtype=np.uint8),
                detection_mode="fast",
                enable_hard_portrait_fallback=True,
            )

        self.assertIsNone(result.attempt_label)
        self.assertEqual(result.faces, [])
        self.assertEqual(mocked_attempt.call_count, 1)

    def test_expensive_mode_runs_one_full_frame_attempt(self) -> None:
        with patch("app.services.face_service.run_detection_attempt", return_value=[]) as mocked_attempt:
            result = face_service.detect_faces_in_image(
                np.zeros((128, 128, 3), dtype=np.uint8),
                detection_mode="expensive",
                enable_hard_portrait_fallback=True,
            )

        self.assertIsNone(result.attempt_label)
        self.assertEqual(result.faces, [])
        self.assertEqual(mocked_attempt.call_count, 1)
        self.assertEqual(mocked_attempt.call_args.kwargs["det_size"], (640, 640))
        self.assertEqual(mocked_attempt.call_args.kwargs["det_thresh"], 0.65)
        self.assertEqual(mocked_attempt.call_args.kwargs["min_face_score"], 0.65)
        self.assertEqual(mocked_attempt.call_args.kwargs["min_face_box_edge"], 32.0)
        self.assertIsNone(mocked_attempt.call_args.kwargs.get("target_max_edge"))
        self.assertIsNone(mocked_attempt.call_args.kwargs.get("target_min_edge"))
        self.assertIsNone(mocked_attempt.call_args.kwargs.get("crop_ratio"))
        self.assertIsNone(mocked_attempt.call_args.kwargs.get("rotation_angle"))

    def test_fallback_mode_starts_with_high_detail_attempt(self) -> None:
        fake_face = [{"bbox": [0.0, 0.0, 10.0, 10.0], "embedding": [0.1, 0.2]}]

        with patch("app.services.face_service.run_detection_attempt", side_effect=[fake_face]) as mocked_attempt:
            result = face_service.detect_faces_in_image(
                np.zeros((128, 128, 3), dtype=np.uint8),
                detection_mode="fallback",
                enable_hard_portrait_fallback=True,
            )

        self.assertEqual(result.attempt_label, "high_detail")
        self.assertEqual(result.faces, fake_face)
        self.assertEqual(mocked_attempt.call_count, 1)

    def test_hard_portrait_fallback_uses_crop_zoom_first(self) -> None:
        fake_face = [{"bbox": [0.0, 0.0, 10.0, 10.0], "embedding": [0.1, 0.2]}]
        side_effect = [[], [], [], fake_face]

        with patch("app.services.face_service.run_detection_attempt", side_effect=side_effect) as mocked_attempt:
            result = face_service.detect_faces_in_image(
                np.zeros((128, 128, 3), dtype=np.uint8),
                enable_hard_portrait_fallback=True,
            )

        self.assertEqual(result.attempt_label, "crop_zoom")
        self.assertEqual(result.faces, fake_face)
        self.assertEqual(mocked_attempt.call_count, 4)

    def test_without_hard_portrait_fallback_only_full_frame_attempts_run(self) -> None:
        with patch("app.services.face_service.run_detection_attempt", return_value=[]) as mocked_attempt:
            result = face_service.detect_faces_in_image(
                np.zeros((128, 128, 3), dtype=np.uint8),
                enable_hard_portrait_fallback=False,
            )

        self.assertIsNone(result.attempt_label)
        self.assertEqual(result.faces, [])
        self.assertEqual(mocked_attempt.call_count, len(face_service.FULL_FRAME_ATTEMPTS))


if __name__ == "__main__":
    unittest.main()
