import os
import time
import hashlib
from collections.abc import Callable

from app.services.embedding_service import generate_image_embedding
from app.services.local_index_store import save_index_record
from app.services.people_service import assign_faces_to_clusters, build_face_cluster_upsert_payload


def build_content_hash(image_path: str) -> str:
    digest = hashlib.sha256()

    with open(image_path, "rb") as image_file:
        for chunk in iter(lambda: image_file.read(1024 * 1024), b""):
            digest.update(chunk)

    return digest.hexdigest()


def process_image(
    image_path: str,
    user_id: str,
    photo_id: str,
    image_uuid: str,
    captured_at: str | None = None,
    *,
    is_cancelled: Callable[[], bool] | None = None,
):
    """
    Background task pipeline.
    Runs SigLIP2 image embedding -> single expensive face detection -> person clustering ->
    persistence -> cleanup.
    """
    supabase = None

    def cancellation_requested(stage: str) -> bool:
        if not is_cancelled:
            return False

        try:
            cancelled = is_cancelled()
        except Exception as cancel_error:
            print(f"[{photo_id}] Cancellation check failed at {stage}: {cancel_error}")
            return False

        if cancelled:
            print(f"[{photo_id}] Pipeline cancelled at {stage}; skipping persistence.")
            return True

        return False

    try:
        from app.db.supabase import get_supabase

        supabase = get_supabase()
    except Exception as config_error:
        print(f"[{photo_id}] Supabase unavailable, using local-only persistence: {config_error}")

    try:
        if cancellation_requested("start"):
            return

        pipeline_started_at = time.perf_counter()
        content_hash = build_content_hash(image_path)
        faces: list[dict[str, object]] = []
        face_attempt: str | None = None

        print(f"[{photo_id}] Vectorizing image with SigLIP2...")
        embedding_started_at = time.perf_counter()
        embedding = generate_image_embedding(image_path)
        print(f"[{photo_id}] Image embedding completed in {time.perf_counter() - embedding_started_at:.2f}s")

        if cancellation_requested("after image embedding"):
            return

        try:
            from app.services.face_service import detect_and_encode_faces_with_attempt as detect_faces_with_attempt

            print(f"[{photo_id}] Detecting faces (single expensive pass)...")
            face_started_at = time.perf_counter()
            faces, face_attempt = detect_faces_with_attempt(
                image_path,
                detection_mode="expensive",
            )
            print(
                f"[{photo_id}] Face detection completed in "
                f"{time.perf_counter() - face_started_at:.2f}s "
                f"({len(faces)} faces, attempt={face_attempt or 'none'})"
            )
        except Exception as face_error:
            print(f"[{photo_id}] Fast face pipeline skipped: {face_error}")
            faces = []
            face_attempt = None

        if not faces:
            print(f"[{photo_id}] Face detection found 0 faces; no fallback pass configured")

        if cancellation_requested("before clustering"):
            return

        face_records, cluster_records = assign_faces_to_clusters(
            user_id=user_id,
            image_uuid=image_uuid,
            photo_id=photo_id,
            faces=faces,
            captured_at=captured_at,
        )
        detected_persons = list(dict.fromkeys([
            str(face_record["cluster_name"])
            for face_record in face_records
            if face_record.get("cluster_name")
        ]))
        face_cluster_refs = list(dict.fromkeys([
            (
                str(face_record["cluster_id"]),
                str(face_record["cluster_name"]),
            )
            for face_record in face_records
            if face_record.get("cluster_id") and face_record.get("cluster_name")
        ]))

        record = {
            "uuid": image_uuid,
            "user_id": user_id,
            "photo_id": photo_id,
            "embedding": embedding,
            "persons": detected_persons,
            "content_hash": content_hash,
            "face_clusters": [
                {
                    "id": cluster_id,
                    "name": cluster_name,
                }
                for cluster_id, cluster_name in face_cluster_refs
            ],
            "captured_at": captured_at,
        }
        supabase_record = {
            "uuid": image_uuid,
            "user_id": user_id,
            "photo_id": photo_id,
            "embedding": embedding,
            "persons": detected_persons,
            "captured_at": captured_at,
        }

        if cancellation_requested("before persistence"):
            return

        print(f"[{photo_id}] Saving local dev index...")
        save_index_record(record)

        if supabase is not None:
            print(f"[{photo_id}] Saving to Supabase...")
            try:
                img_res = supabase.table("images").upsert(
                    supabase_record,
                    on_conflict="user_id,photo_id",
                ).execute()

                stored_image_uuid = img_res.data[0]["uuid"]

                if cluster_records:
                    cluster_payload = [
                        build_face_cluster_upsert_payload(
                            cluster,
                            cover_image_uuid=str(stored_image_uuid),
                            cover_photo_id=photo_id,
                        )
                        for cluster in cluster_records
                    ]
                    try:
                        supabase.table("face_clusters").upsert(
                            cluster_payload,
                            on_conflict="id",
                        ).execute()
                    except Exception as cluster_error:
                        print(f"[{photo_id}] Skipping face cluster upsert: {cluster_error}")

                for fr in face_records:
                    try:
                        supabase.table("face_detections").insert({
                            "image_uuid": stored_image_uuid,
                            "cluster_id": fr["cluster_id"],
                            "bounding_box": fr["bounding_box"],
                        }).execute()
                    except Exception as face_detection_error:
                        print(f"[{photo_id}] Skipping face detection insert: {face_detection_error}")
            except Exception as db_error:
                print(f"[{photo_id}] Supabase persistence skipped: {db_error}")

        print(f"[{photo_id}] Pipeline completed successfully in {time.perf_counter() - pipeline_started_at:.2f}s")

    except Exception as e:
        print(f"Pipeline Failed for {photo_id}: {e}")

    finally:
        if os.path.exists(image_path):
            os.remove(image_path)
            print(f"[{photo_id}] Temporary file deleted.")
