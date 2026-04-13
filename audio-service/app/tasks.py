"""
Celery tasks for async audio processing.
Queue: resonance-audio
"""

import logging
import os

from celery import Celery

from app.extractor import extract_features
from app.db import upsert_audio_feature, set_feature_status
from app.pinecone_client import upsert_vector

logger = logging.getLogger(__name__)

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

celery_app = Celery(
    "resonance_audio",
    broker=REDIS_URL,
    backend=REDIS_URL,
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    task_routes={
        "app.tasks.process_audio": {"queue": "resonance-audio"},
    },
    worker_prefetch_multiplier=1,
    task_acks_late=True,
)


@celery_app.task(
    bind=True,
    name="app.tasks.process_audio",
    max_retries=3,
    default_retry_delay=10,
)
def process_audio(self, post_id: str, user_id: str, audio_bytes_hex: str) -> dict:
    """
    Process a single audio file:
    1. Extract features with Librosa
    2. Save to PostgreSQL audio_features table
    3. Upsert embedding to Pinecone (if configured)

    Args:
        post_id: UUID of the post
        user_id: UUID of the user
        audio_bytes_hex: hex-encoded raw audio bytes
    """
    logger.info("[Task] Processing audio for post=%s user=%s", post_id, user_id)

    # Mark as processing
    set_feature_status(post_id, "PROCESSING")

    try:
        audio_bytes = bytes.fromhex(audio_bytes_hex)
        features = extract_features(audio_bytes)

        # Write to Pinecone asynchronously (best effort)
        pinecone_id = upsert_vector(
            vector_id=post_id,
            embedding=features["embedding"],
            metadata={"user_id": user_id, "post_id": post_id},
        )

        # Persist to PostgreSQL
        upsert_audio_feature(
            post_id=post_id,
            user_id=user_id,
            features=features,
            pinecone_id=pinecone_id,
            status="DONE",
        )

        logger.info("[Task] Done post=%s tempo=%.1f", post_id, features["tempo"])
        return {"status": "done", "post_id": post_id}

    except Exception as exc:
        logger.error("[Task] Failed post=%s: %s", post_id, exc)
        try:
            set_feature_status(post_id, "FAILED", error_message=str(exc))
        except Exception:
            pass
        raise self.retry(exc=exc)
