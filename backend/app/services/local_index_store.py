from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

STORE_PATH = Path(__file__).resolve().parents[2] / "tmp" / "local_search_index.json"
STORE_PATH.parent.mkdir(parents=True, exist_ok=True)

_LOCK = threading.Lock()


def _read_store() -> list[dict[str, Any]]:
    if not STORE_PATH.exists():
        return []

    try:
        with STORE_PATH.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (json.JSONDecodeError, OSError):
        return []

    return data if isinstance(data, list) else []


def _write_store(items: list[dict[str, Any]]) -> None:
    with STORE_PATH.open("w", encoding="utf-8") as handle:
        json.dump(items, handle, ensure_ascii=True, indent=2)


def save_index_record(record: dict[str, Any]) -> None:
    key = (record.get("user_id"), record.get("photo_id"))

    with _LOCK:
        items = _read_store()
        updated_items = [
            item for item in items
            if (item.get("user_id"), item.get("photo_id")) != key
        ]
        updated_items.append(record)
        _write_store(updated_items)


def get_index_records_for_user(user_id: str) -> list[dict[str, Any]]:
    with _LOCK:
        return [
            item for item in _read_store()
            if item.get("user_id") == user_id
        ]


def get_index_record_for_photo(user_id: str, photo_id: str) -> dict[str, Any] | None:
    with _LOCK:
        for item in _read_store():
            if item.get("user_id") == user_id and item.get("photo_id") == photo_id:
                return item

    return None


def get_all_index_records() -> list[dict[str, Any]]:
    with _LOCK:
        return _read_store()


def delete_index_records_for_user(user_id: str) -> int:
    with _LOCK:
        items = _read_store()
        kept_items = [item for item in items if item.get("user_id") != user_id]
        deleted_count = len(items) - len(kept_items)

        if deleted_count > 0:
            _write_store(kept_items)

        return deleted_count


def delete_index_record_for_photo(user_id: str, photo_id: str) -> int:
    with _LOCK:
        items = _read_store()
        kept_items = [
            item for item in items
            if not (item.get("user_id") == user_id and item.get("photo_id") == photo_id)
        ]
        deleted_count = len(items) - len(kept_items)

        if deleted_count > 0:
            _write_store(kept_items)

        return deleted_count


def rename_face_cluster_references(*, user_id: str, cluster_id: str, new_name: str) -> bool:
    changed = False

    with _LOCK:
        items = _read_store()

        for item in items:
            if item.get("user_id") != user_id:
                continue

            face_clusters = item.get("face_clusters")
            if not isinstance(face_clusters, list):
                continue

            next_clusters: list[dict[str, Any]] = []
            cluster_updated = False

            for cluster in face_clusters:
                if not isinstance(cluster, dict):
                    continue

                if str(cluster.get("id")) == cluster_id:
                    next_clusters.append({
                        "id": cluster_id,
                        "name": new_name,
                    })
                    cluster_updated = True
                else:
                    next_clusters.append(cluster)

            if not cluster_updated:
                continue

            deduped_names: list[str] = []
            for cluster in next_clusters:
                cluster_name = cluster.get("name")
                if isinstance(cluster_name, str) and cluster_name and cluster_name not in deduped_names:
                    deduped_names.append(cluster_name)

            item["face_clusters"] = next_clusters
            item["persons"] = deduped_names
            changed = True

        if changed:
            _write_store(items)

    return changed
