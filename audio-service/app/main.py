"""
Resonance Audio Feature Extraction Service
FastAPI application exposing:
  POST /extract  — receive WAV/MP3, queue feature extraction
  POST /extract/sync — synchronous extraction (for testing)
  GET  /features/{post_id} — retrieve extracted features
  POST /similar  — find similar posts via Pinecone
  GET  /health
"""

import logging
import os
from typing import Annotated

import dotenv
dotenv.load_dotenv()

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.extractor import extract_features
from app.db import upsert_audio_feature
from app.pinecone_client import query_similar
from app.tasks import process_audio

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Resonance Audio Service",
    version="1.0.0",
    description="Audio feature extraction microservice for Resonance",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/extract")
async def enqueue_extraction(
    post_id: Annotated[str, Form()],
    user_id: Annotated[str, Form()],
    file: UploadFile = File(...),
):
    """
    Receive an audio file and enqueue Celery task for feature extraction.
    Returns immediately with the task ID.
    """
    audio_bytes = await file.read()
    if len(audio_bytes) == 0:
        raise HTTPException(status_code=400, detail="Empty audio file")

    # Enqueue Celery task (pass bytes as hex string for JSON serialisation)
    task = process_audio.delay(post_id, user_id, audio_bytes.hex())

    return {"task_id": task.id, "post_id": post_id, "status": "queued"}


@app.post("/extract/sync")
async def extract_sync(
    post_id: Annotated[str, Form()],
    user_id: Annotated[str, Form()],
    file: UploadFile = File(...),
):
    """
    Synchronous feature extraction (useful for testing / small files).
    Blocks until features are extracted and saved.
    """
    audio_bytes = await file.read()
    if len(audio_bytes) == 0:
        raise HTTPException(status_code=400, detail="Empty audio file")

    try:
        features = extract_features(audio_bytes)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Feature extraction failed: {exc}") from exc

    from app.pinecone_client import upsert_vector
    pinecone_id = upsert_vector(
        vector_id=post_id,
        embedding=features["embedding"],
        metadata={"user_id": user_id, "post_id": post_id},
    )

    try:
        upsert_audio_feature(
            post_id=post_id,
            user_id=user_id,
            features=features,
            pinecone_id=pinecone_id,
            status="DONE",
        )
    except Exception as exc:
        logger.warning("DB write failed (no DB in test?): %s", exc)

    return {
        "post_id": post_id,
        "spectral_centroid": features["spectral_centroid"],
        "zero_crossing_rate": features["zero_crossing_rate"],
        "energy": features["energy"],
        "tempo": features["tempo"],
        "mfcc": features["mfcc"],
        "embedding_dim": len(features["embedding"]),
        "embedding_preview": features["embedding"][:8],
    }


@app.post("/similar")
async def find_similar(body: dict):
    """
    Find similar posts using a query embedding vector.
    Body: { "embedding": [...], "top_k": 20, "filter": {} }
    """
    embedding = body.get("embedding")
    if not embedding or len(embedding) != 128:
        raise HTTPException(status_code=400, detail="embedding must be a 128-dim float array")

    top_k = min(int(body.get("top_k", 20)), 100)
    filter_dict = body.get("filter")

    results = query_similar(embedding, top_k=top_k, filter=filter_dict)
    return {"results": results}
