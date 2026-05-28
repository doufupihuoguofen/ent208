"""
Audio Feature Extractor
-----------------------
Extracts a 128-dimensional normalized embedding vector from a WAV/MP3 file
using Librosa, then persists it to PostgreSQL and (optionally) Pinecone.

Vector composition (128 dims total):
  [0]      spectral centroid (1)
  [1]      zero crossing rate (1)
  [2]      RMS energy (1)
  [3]      tempo (1)
  [4-16]   MFCCs mean (13)
  [17-29]  MFCCs std  (13)
  [30-41]  chroma mean (12)
  [42-53]  chroma std  (12)
  [54-65]  spectral contrast mean (6 bands -> padded to 12)
  [66-89]  mel spectrogram summary (24 bins)
  [90-101] tonnetz mean (6 -> padded to 12)
  [102-113] spectral bandwidth + rolloff stats (12)
  [114-127] onset strength stats + zero_pad to 128
"""

import io
import os
import logging
from typing import Optional

import numpy as np
import librosa
import librosa.feature

logger = logging.getLogger(__name__)

EMBEDDING_DIM = 128


def _pad_or_truncate(arr: np.ndarray, length: int) -> np.ndarray:
    """Ensure array has exactly `length` elements."""
    if len(arr) >= length:
        return arr[:length]
    return np.concatenate([arr, np.zeros(length - len(arr))])


def extract_features(audio_bytes: bytes, sr: int = 22050) -> dict:
    """
    Extract audio features from raw audio bytes.

    Returns:
        dict with keys:
            spectral_centroid  (float)
            zero_crossing_rate (float)
            energy             (float)
            tempo              (float)
            mfcc               (list[float], 13 dims)
            embedding          (list[float], 128 dims, L2-normalised)
    """
    # Load audio
    y, sr = librosa.load(io.BytesIO(audio_bytes), sr=sr, mono=True, duration=60.0)

    if len(y) == 0:
        raise ValueError("Audio file appears to be empty or unreadable")

    # ── Raw features ──────────────────────────────────────────────────────────
    spectral_centroid = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
    zero_crossing_rate = float(np.mean(librosa.feature.zero_crossing_rate(y=y)))
    energy = float(np.mean(librosa.feature.rms(y=y)))

    tempo_arr, _ = librosa.beat.beat_track(y=y, sr=sr)
    tempo = float(tempo_arr) if np.isscalar(tempo_arr) else float(tempo_arr[0])

    # MFCCs (13 coefficients)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
    mfcc_mean = np.mean(mfcc, axis=1)   # (13,)
    mfcc_std  = np.std(mfcc,  axis=1)   # (13,)

    # ── Embedding vector assembly (128 dims) ──────────────────────────────────
    parts: list[np.ndarray] = []

    # [0-3] scalar features
    parts.append(np.array([spectral_centroid, zero_crossing_rate, energy, tempo]))

    # [4-29] MFCCs (26)
    parts.append(mfcc_mean)
    parts.append(mfcc_std)

    # [30-53] Chroma (24)
    chroma = librosa.feature.chroma_stft(y=y, sr=sr)
    parts.append(_pad_or_truncate(np.mean(chroma, axis=1), 12))
    parts.append(_pad_or_truncate(np.std(chroma,  axis=1), 12))

    # [54-65] Spectral contrast (12)
    contrast = librosa.feature.spectral_contrast(y=y, sr=sr)
    parts.append(_pad_or_truncate(np.mean(contrast, axis=1), 6))
    parts.append(_pad_or_truncate(np.std(contrast,  axis=1), 6))

    # [66-89] Mel spectrogram summary (24)
    mel = librosa.feature.melspectrogram(y=y, sr=sr, n_mels=128)
    mel_db = librosa.power_to_db(mel, ref=np.max)
    # Summarise into 24 bins by averaging groups of 5–6 mel bins
    mel_summary = np.array([np.mean(mel_db[i * 5:(i + 1) * 5]) for i in range(24)])
    parts.append(mel_summary)

    # [90-101] Tonnetz (12)
    try:
        y_harmonic = librosa.effects.harmonic(y)
        tonnetz = librosa.feature.tonnetz(y=y_harmonic, sr=sr)
        parts.append(_pad_or_truncate(np.mean(tonnetz, axis=1), 6))
        parts.append(_pad_or_truncate(np.std(tonnetz,  axis=1), 6))
    except Exception:
        parts.append(np.zeros(12))

    # [102-113] Bandwidth + rolloff (12)
    bw = librosa.feature.spectral_bandwidth(y=y, sr=sr)
    rolloff = librosa.feature.spectral_rolloff(y=y, sr=sr)
    parts.append(_pad_or_truncate(
        np.array([np.mean(bw), np.std(bw), np.mean(rolloff), np.std(rolloff),
                  np.min(bw),  np.max(bw),  np.min(rolloff), np.max(rolloff),
                  float(np.percentile(bw, 25)), float(np.percentile(bw, 75)),
                  float(np.percentile(rolloff, 25)), float(np.percentile(rolloff, 75))]),
        12,
    ))

    # [114-127] Onset strength stats (14 → truncated to 14)
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    onset_stats = np.array([
        np.mean(onset_env), np.std(onset_env), np.min(onset_env), np.max(onset_env),
        float(np.percentile(onset_env, 25)), float(np.percentile(onset_env, 75)),
        float(np.percentile(onset_env, 10)), float(np.percentile(onset_env, 90)),
        float(np.sum(onset_env > np.mean(onset_env))),
        float(librosa.feature.zero_crossing_rate(onset_env)[0].mean()),
        0.0, 0.0, 0.0, 0.0,  # padding to 14
    ])
    parts.append(_pad_or_truncate(onset_stats, 14))

    # Concatenate & trim/pad to exactly 128
    raw = np.concatenate(parts, axis=0)
    raw = _pad_or_truncate(raw.astype(np.float32), EMBEDDING_DIM)

    # L2 normalise
    norm = np.linalg.norm(raw)
    embedding = (raw / norm).tolist() if norm > 1e-8 else raw.tolist()

    return {
        "spectral_centroid": spectral_centroid,
        "zero_crossing_rate": zero_crossing_rate,
        "energy": energy,
        "tempo": tempo,
        "mfcc": mfcc_mean.tolist(),
        "embedding": embedding,
    }
