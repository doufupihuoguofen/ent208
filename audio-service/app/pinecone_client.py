"""Pinecone vector store client (optional – skipped if PINECONE_API_KEY is unset)."""

import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

_index = None


def _get_index():
    global _index
    if _index is not None:
        return _index

    api_key = os.environ.get("PINECONE_API_KEY", "")
    if not api_key:
        return None

    try:
        from pinecone import Pinecone  # type: ignore

        pc = Pinecone(api_key=api_key)
        index_name = os.environ.get("PINECONE_INDEX_NAME", "resonance-audio")
        _index = pc.Index(index_name)
        logger.info("[Pinecone] connected to index '%s'", index_name)
    except Exception as exc:
        logger.warning("[Pinecone] init failed: %s", exc)
        _index = None

    return _index


def upsert_vector(
    vector_id: str,
    embedding: list[float],
    metadata: dict | None = None,
) -> Optional[str]:
    """
    Upsert an embedding vector into Pinecone.

    Returns the vector_id on success, None if Pinecone is disabled or fails.
    """
    index = _get_index()
    if index is None:
        return None

    try:
        index.upsert(
            vectors=[
                {
                    "id": vector_id,
                    "values": embedding,
                    "metadata": metadata or {},
                }
            ]
        )
        return vector_id
    except Exception as exc:
        logger.error("[Pinecone] upsert failed: %s", exc)
        return None


def query_similar(
    embedding: list[float],
    top_k: int = 20,
    filter: dict | None = None,
) -> list[dict]:
    """
    Query Pinecone for the top_k most similar vectors.
    Returns list of { id, score, metadata }.
    """
    index = _get_index()
    if index is None:
        return []

    try:
        result = index.query(
            vector=embedding,
            top_k=top_k,
            include_metadata=True,
            filter=filter,
        )
        return [
            {"id": m["id"], "score": m["score"], "metadata": m.get("metadata", {})}
            for m in result.get("matches", [])
        ]
    except Exception as exc:
        logger.error("[Pinecone] query failed: %s", exc)
        return []
