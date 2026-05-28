"""Database helpers for the audio service (SQLAlchemy core, no ORM models)."""

import os
from contextlib import contextmanager
from typing import Generator

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection

_engine = create_engine(
    os.environ["DATABASE_URL"],
    pool_size=5,
    max_overflow=10,
    pool_pre_ping=True,
)


@contextmanager
def get_conn() -> Generator[Connection, None, None]:
    with _engine.connect() as conn:
        yield conn
        conn.commit()


def upsert_audio_feature(
    post_id: str,
    user_id: str,
    features: dict,
    pinecone_id: str | None = None,
    status: str = "DONE",
    error_message: str | None = None,
) -> None:
    """Insert or update the audio_features row for a given post."""
    with get_conn() as conn:
        conn.execute(
            text(
                """
                INSERT INTO audio_features (
                    id, post_id, user_id,
                    spectral_centroid, zero_crossing_rate, energy, tempo,
                    mfcc, embedding, pinecone_id, status, error_message,
                    created_at, updated_at
                ) VALUES (
                    gen_random_uuid(), :post_id, :user_id,
                    :spectral_centroid, :zero_crossing_rate, :energy, :tempo,
                    :mfcc, :embedding, :pinecone_id, CAST(:status AS "AudioFeatureStatus"),
                    now(), now()
                )
                ON CONFLICT (post_id) DO UPDATE SET
                    spectral_centroid  = EXCLUDED.spectral_centroid,
                    zero_crossing_rate = EXCLUDED.zero_crossing_rate,
                    energy             = EXCLUDED.energy,
                    tempo              = EXCLUDED.tempo,
                    mfcc               = EXCLUDED.mfcc,
                    embedding          = EXCLUDED.embedding,
                    pinecone_id        = EXCLUDED.pinecone_id,
                    status             = EXCLUDED.status,
                    error_message      = EXCLUDED.error_message,
                    updated_at         = now()
                """
            ),
            {
                "post_id": post_id,
                "user_id": user_id,
                "spectral_centroid": features["spectral_centroid"],
                "zero_crossing_rate": features["zero_crossing_rate"],
                "energy": features["energy"],
                "tempo": features["tempo"],
                "mfcc": features["mfcc"],
                "embedding": features["embedding"],
                "pinecone_id": pinecone_id,
                "status": status,
                "error_message": error_message,
            },
        )


def set_feature_status(post_id: str, status: str, error_message: str | None = None) -> None:
    with get_conn() as conn:
        conn.execute(
            text(
                """
                UPDATE audio_features
                SET status = CAST(:status AS "AudioFeatureStatus"),
                    error_message = :error_message,
                    updated_at = now()
                WHERE post_id = :post_id
                """
            ),
            {"post_id": post_id, "status": status, "error_message": error_message},
        )
