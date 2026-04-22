from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import cv2
import numpy as np
import torch
from insightface.app import FaceAnalysis

MODEL_NAME = "buffalo_l"
DEFAULT_DET_THRESH = 0.5
DEFAULT_DET_SIZE = (640, 640)
EXPENSIVE_FACE_SCORE_THRESHOLD = 0.65
MIN_PEOPLE_ALBUM_FACE_EDGE_PIXELS = 32.0
HARD_PORTRAIT_DET_SIZE = (1280, 1280)
HARD_PORTRAIT_DET_THRESH = 0.20
HARD_PORTRAIT_CROP_RATIO = 0.85
HARD_PORTRAIT_MIN_EDGE = 1800
ROTATION_ANGLES = (-15.0, 15.0)
EXPENSIVE_FACE_ATTEMPT = {
    "label": "expensive",
    "det_size": DEFAULT_DET_SIZE,
    "det_thresh": EXPENSIVE_FACE_SCORE_THRESHOLD,
    "min_face_score": EXPENSIVE_FACE_SCORE_THRESHOLD,
    "min_face_box_edge": MIN_PEOPLE_ALBUM_FACE_EDGE_PIXELS,
    "target_max_edge": None,
    "target_min_edge": None,
}

FULL_FRAME_ATTEMPTS = (
    {
        "label": "default",
        "det_size": DEFAULT_DET_SIZE,
        "det_thresh": DEFAULT_DET_THRESH,
        "min_face_score": 0.70,
        "target_max_edge": 1600,
        "target_min_edge": None,
    },
    {
        "label": "high_detail",
        "det_size": (1024, 1024),
        "det_thresh": 0.35,
        "min_face_score": 0.45,
        "target_max_edge": 2200,
        "target_min_edge": 1400,
    },
    {
        "label": "sensitive",
        "det_size": HARD_PORTRAIT_DET_SIZE,
        "det_thresh": 0.25,
        "min_face_score": 0.40,
        "target_max_edge": 2600,
        "target_min_edge": HARD_PORTRAIT_MIN_EDGE,
    },
)
FAST_FACE_ATTEMPTS = FULL_FRAME_ATTEMPTS[:1]
HUMAN_GUIDED_FULL_FRAME_ATTEMPTS = FULL_FRAME_ATTEMPTS[1:]
HARD_PORTRAIT_ATTEMPTS = (
    {
        "label": "crop_zoom",
        "det_size": HARD_PORTRAIT_DET_SIZE,
        "det_thresh": HARD_PORTRAIT_DET_THRESH,
        "min_face_score": 0.35,
        "crop_ratio": HARD_PORTRAIT_CROP_RATIO,
        "target_min_edge": HARD_PORTRAIT_MIN_EDGE,
    },
    {
        "label": "rotate_-15",
        "det_size": HARD_PORTRAIT_DET_SIZE,
        "det_thresh": HARD_PORTRAIT_DET_THRESH,
        "min_face_score": 0.35,
        "rotation_angle": ROTATION_ANGLES[0],
    },
    {
        "label": "rotate_15",
        "det_size": HARD_PORTRAIT_DET_SIZE,
        "det_thresh": HARD_PORTRAIT_DET_THRESH,
        "min_face_score": 0.35,
        "rotation_angle": ROTATION_ANGLES[1],
    },
    {
        "label": "crop_zoom_rotate_-15",
        "det_size": HARD_PORTRAIT_DET_SIZE,
        "det_thresh": HARD_PORTRAIT_DET_THRESH,
        "min_face_score": 0.35,
        "crop_ratio": HARD_PORTRAIT_CROP_RATIO,
        "target_min_edge": HARD_PORTRAIT_MIN_EDGE,
        "rotation_angle": ROTATION_ANGLES[0],
    },
    {
        "label": "crop_zoom_rotate_15",
        "det_size": HARD_PORTRAIT_DET_SIZE,
        "det_thresh": HARD_PORTRAIT_DET_THRESH,
        "min_face_score": 0.35,
        "crop_ratio": HARD_PORTRAIT_CROP_RATIO,
        "target_min_edge": HARD_PORTRAIT_MIN_EDGE,
        "rotation_angle": ROTATION_ANGLES[1],
    },
)

apps: dict[tuple[tuple[int, int], float], FaceAnalysis] = {}


@dataclass(frozen=True)
class DetectionAttemptResult:
    faces: list[dict[str, Any]]
    attempt_label: str | None


def get_face_model(*, det_size: tuple[int, int], det_thresh: float) -> FaceAnalysis:
    cache_key = (det_size, det_thresh)
    cached_app = apps.get(cache_key)

    if cached_app is None:
        ctx_id = 0 if torch.cuda.is_available() else -1
        print(
            f"Loading InsightFace ({MODEL_NAME}) with ctx_id={ctx_id}, "
            f"det_size={det_size}, det_thresh={det_thresh}..."
        )
        cached_app = FaceAnalysis(name=MODEL_NAME)
        cached_app.prepare(ctx_id=ctx_id, det_size=det_size, det_thresh=det_thresh)
        apps[cache_key] = cached_app

    return cached_app


def to_homogeneous_matrix(matrix_2x3: np.ndarray) -> np.ndarray:
    return np.vstack([matrix_2x3, [0.0, 0.0, 1.0]]).astype(np.float32)


def transform_points(matrix: np.ndarray, points: np.ndarray) -> np.ndarray:
    homogeneous_points = np.hstack(
        [points.astype(np.float32), np.ones((points.shape[0], 1), dtype=np.float32)]
    )
    transformed = (matrix @ homogeneous_points.T).T
    return transformed[:, :2]


def clamp_bbox(bbox: list[float], *, original_width: int, original_height: int) -> list[float]:
    x1, y1, x2, y2 = bbox
    max_x = max(0, original_width - 1)
    max_y = max(0, original_height - 1)

    clamped = [
        float(min(max(x1, 0.0), max_x)),
        float(min(max(y1, 0.0), max_y)),
        float(min(max(x2, 0.0), max_x)),
        float(min(max(y2, 0.0), max_y)),
    ]
    return clamped


def map_bbox_to_original(
    bbox: list[float],
    *,
    forward_matrix: np.ndarray,
    original_width: int,
    original_height: int,
) -> list[float]:
    inverse_matrix = np.linalg.inv(forward_matrix)
    x1, y1, x2, y2 = bbox
    bbox_points = np.array(
        [
            [x1, y1],
            [x2, y1],
            [x2, y2],
            [x1, y2],
        ],
        dtype=np.float32,
    )
    original_points = transform_points(inverse_matrix, bbox_points)
    remapped_bbox = [
        float(np.min(original_points[:, 0])),
        float(np.min(original_points[:, 1])),
        float(np.max(original_points[:, 0])),
        float(np.max(original_points[:, 1])),
    ]
    return clamp_bbox(remapped_bbox, original_width=original_width, original_height=original_height)


def centered_crop_region(img: np.ndarray, crop_ratio: float) -> tuple[int, int, int, int]:
    original_height, original_width = img.shape[:2]
    crop_width = max(1, int(round(original_width * crop_ratio)))
    crop_height = max(1, int(round(original_height * crop_ratio)))
    offset_x = max(0, (original_width - crop_width) // 2)
    offset_y = max(0, (original_height - crop_height) // 2)
    return offset_x, offset_y, crop_width, crop_height


def apply_centered_crop(img: np.ndarray, crop_ratio: float) -> tuple[np.ndarray, np.ndarray]:
    offset_x, offset_y, crop_width, crop_height = centered_crop_region(img, crop_ratio)
    cropped = img[offset_y:offset_y + crop_height, offset_x:offset_x + crop_width].copy()
    crop_matrix = np.array(
        [
            [1.0, 0.0, -float(offset_x)],
            [0.0, 1.0, -float(offset_y)],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float32,
    )
    return cropped, crop_matrix


def resize_for_detection(
    img: np.ndarray,
    *,
    target_max_edge: int | None,
    target_min_edge: int | None,
) -> tuple[np.ndarray, float, np.ndarray]:
    original_height, original_width = img.shape[:2]
    longest_edge = max(original_height, original_width)
    scale = 1.0

    if target_max_edge and longest_edge > target_max_edge:
        scale = target_max_edge / float(longest_edge)
    elif target_min_edge and longest_edge < target_min_edge:
        scale = target_min_edge / float(longest_edge)

    if scale == 1.0:
        return img, scale, np.eye(3, dtype=np.float32)

    resized = cv2.resize(
        img,
        (
            max(1, int(round(original_width * scale))),
            max(1, int(round(original_height * scale))),
        ),
        interpolation=cv2.INTER_LINEAR if scale > 1.0 else cv2.INTER_AREA,
    )
    scale_matrix = np.array(
        [
            [scale, 0.0, 0.0],
            [0.0, scale, 0.0],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float32,
    )
    return resized, scale, scale_matrix


def rotate_image(img: np.ndarray, angle: float) -> tuple[np.ndarray, np.ndarray]:
    height, width = img.shape[:2]
    center = (width / 2.0, height / 2.0)
    rotation_matrix = cv2.getRotationMatrix2D(center, angle, 1.0)
    rotated = cv2.warpAffine(
        img,
        rotation_matrix,
        (width, height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT101,
    )
    return rotated, to_homogeneous_matrix(rotation_matrix)


def prepare_detection_image(
    img: np.ndarray,
    *,
    crop_ratio: float | None = None,
    target_max_edge: int | None = None,
    target_min_edge: int | None = None,
    rotation_angle: float | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    transformed_img = img
    forward_matrix = np.eye(3, dtype=np.float32)

    if crop_ratio is not None:
        transformed_img, crop_matrix = apply_centered_crop(transformed_img, crop_ratio)
        forward_matrix = crop_matrix @ forward_matrix

    transformed_img, _scale, scale_matrix = resize_for_detection(
        transformed_img,
        target_max_edge=target_max_edge,
        target_min_edge=target_min_edge,
    )
    forward_matrix = scale_matrix @ forward_matrix

    if rotation_angle is not None:
        transformed_img, rotation_matrix = rotate_image(transformed_img, rotation_angle)
        forward_matrix = rotation_matrix @ forward_matrix

    return transformed_img, forward_matrix


def run_detection_attempt(
    img: np.ndarray,
    *,
    det_size: tuple[int, int],
    det_thresh: float,
    min_face_score: float = 0.0,
    target_max_edge: int | None = None,
    target_min_edge: int | None = None,
    crop_ratio: float | None = None,
    rotation_angle: float | None = None,
    min_face_box_edge: float = 0.0,
) -> list[dict[str, Any]]:
    processed_img, forward_matrix = prepare_detection_image(
        img,
        crop_ratio=crop_ratio,
        target_max_edge=target_max_edge,
        target_min_edge=target_min_edge,
        rotation_angle=rotation_angle,
    )
    detected_faces = get_face_model(det_size=det_size, det_thresh=det_thresh).get(processed_img)
    original_height, original_width = img.shape[:2]

    results: list[dict[str, Any]] = []
    for face in detected_faces:
        det_score_value = getattr(face, "det_score", None)
        det_score = float(det_score_value) if det_score_value is not None else 1.0
        if det_score < min_face_score:
            continue

        remapped_bbox = map_bbox_to_original(
            face.bbox.tolist(),
            forward_matrix=forward_matrix,
            original_width=original_width,
            original_height=original_height,
        )
        face_width = remapped_bbox[2] - remapped_bbox[0]
        face_height = remapped_bbox[3] - remapped_bbox[1]
        if min(face_width, face_height) < min_face_box_edge:
            continue

        results.append(
            {
                "bbox": remapped_bbox,
                "embedding": face.embedding.tolist(),
                "score": det_score,
            }
        )

    return results


def build_attempt_sequence(
    *,
    detection_mode: str,
    enable_hard_portrait_fallback: bool,
) -> tuple[dict[str, Any], ...]:
    if detection_mode == "fast":
        return FAST_FACE_ATTEMPTS

    if detection_mode == "expensive":
        return (EXPENSIVE_FACE_ATTEMPT,)

    if detection_mode == "fallback":
        attempts = HUMAN_GUIDED_FULL_FRAME_ATTEMPTS
    elif detection_mode == "all":
        attempts = FULL_FRAME_ATTEMPTS
    else:
        raise ValueError(f"Unsupported detection_mode: {detection_mode}")

    if enable_hard_portrait_fallback:
        return attempts + HARD_PORTRAIT_ATTEMPTS

    return attempts


def detect_faces_in_image(
    img: np.ndarray,
    *,
    detection_mode: str = "all",
    enable_hard_portrait_fallback: bool = False,
) -> DetectionAttemptResult:
    attempts = build_attempt_sequence(
        detection_mode=detection_mode,
        enable_hard_portrait_fallback=enable_hard_portrait_fallback,
    )
    for attempt in attempts:
        faces = run_detection_attempt(
            img,
            det_size=attempt["det_size"],
            det_thresh=attempt["det_thresh"],
            min_face_score=attempt.get("min_face_score", 0.0),
            target_max_edge=attempt.get("target_max_edge"),
            target_min_edge=attempt.get("target_min_edge"),
            crop_ratio=attempt.get("crop_ratio"),
            rotation_angle=attempt.get("rotation_angle"),
            min_face_box_edge=attempt.get("min_face_box_edge", 0.0),
        )
        if faces:
            return DetectionAttemptResult(faces=faces, attempt_label=attempt["label"])

    return DetectionAttemptResult(faces=[], attempt_label=None)


def detect_and_encode_faces_with_attempt(
    image_path: str,
    *,
    detection_mode: str = "all",
    enable_hard_portrait_fallback: bool = False,
) -> tuple[list[dict[str, Any]], str | None]:
    try:
        img = cv2.imread(image_path)
        if img is None:
            raise ValueError(f"Could not read image at {image_path}")

        result = detect_faces_in_image(
            img,
            detection_mode=detection_mode,
            enable_hard_portrait_fallback=enable_hard_portrait_fallback,
        )
        return result.faces, result.attempt_label
    except Exception as error:
        print(f"Face Analysis Error for {image_path}: {error}")
        return [], None


def detect_and_encode_faces(image_path: str) -> list[dict[str, Any]]:
    faces, _attempt_label = detect_and_encode_faces_with_attempt(image_path)
    return faces
