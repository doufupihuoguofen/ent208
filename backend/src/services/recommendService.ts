import { prisma } from '../config/database';
import { redis } from '../config/redis';

const WEIGHTS = {
  audioSimilarity: 0.4,
  gamePreference: 0.3,
  socialGraph: 0.2,
  trending: 0.1,
};

const RECOMMEND_CACHE_TTL = 300; // 5 minutes

/**
 * Cosine similarity between two equal-length float arrays.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Get personalized post recommendations for a user.
 * Falls back to hot-score ranking for cold-start (no profile vector yet).
 */
export async function getRecommendations(
  userId: string,
  limit: number,
): Promise<string[]> {
  const cacheKey = `recommend:${userId}:${limit}`;

  // Try cache first
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached) as string[];

  const [userProfile, userGameLibrary, followingIds] = await Promise.all([
    prisma.userProfile.findUnique({ where: { userId } }),
    prisma.gameLibrary.findMany({ where: { userId }, select: { steamAppId: true, playtimeMinutes: true } }),
    prisma.follow.findMany({ where: { followerId: userId }, select: { followingId: true } }),
  ]);

  const followingSet = new Set(followingIds.map((f) => f.followingId));

  // Build game preference map: { steamAppId: normalizedWeight }
  const totalPlaytime = userGameLibrary.reduce((s, g) => s + g.playtimeMinutes, 0) || 1;
  const gameWeightMap: Record<string, number> = {};
  for (const g of userGameLibrary) {
    gameWeightMap[g.steamAppId] = g.playtimeMinutes / totalPlaytime;
  }

  // Fetch candidate posts with their features (exclude user's own)
  const candidates = await prisma.post.findMany({
    where: { userId: { not: userId } },
    orderBy: { hotScore: 'desc' },
    take: limit * 5, // over-fetch for scoring
    include: {
      audioFeature: { select: { embedding: true } },
    },
  });

  // Normalize hot scores to [0, 1]
  const maxHot = candidates.reduce((m, p) => Math.max(m, p.hotScore), 1);

  const scored = candidates.map((post) => {
    // 1. Audio similarity
    let audioScore = 0;
    if (userProfile?.preferenceVector.length && post.audioFeature?.embedding.length) {
      audioScore = cosineSimilarity(userProfile.preferenceVector, post.audioFeature.embedding);
    }

    // 2. Game preference match
    let gameScore = 0;
    if (post.gameTags.length > 0) {
      for (const tag of post.gameTags) {
        gameScore = Math.max(gameScore, gameWeightMap[tag] ?? 0);
      }
    }

    // 3. Social graph (authored by someone user follows)
    const socialScore = followingSet.has(post.userId) ? 1 : 0;

    // 4. Trending (normalized hot score)
    const trendingScore = maxHot > 0 ? post.hotScore / maxHot : 0;

    const total =
      audioScore * WEIGHTS.audioSimilarity +
      gameScore * WEIGHTS.gamePreference +
      socialScore * WEIGHTS.socialGraph +
      trendingScore * WEIGHTS.trending;

    return { id: post.id, score: total };
  });

  scored.sort((a, b) => b.score - a.score);
  const postIds = scored.slice(0, limit).map((p) => p.id);

  // Cache result
  await redis.setex(cacheKey, RECOMMEND_CACHE_TTL, JSON.stringify(postIds)).catch(() => null);

  return postIds;
}

/**
 * Update user preference vector using exponential moving average
 * after a meaningful interaction (e.g. full play or save).
 */
export async function updateUserPreferenceVector(
  userId: string,
  postId: string,
  weight: number, // 0–1, e.g. 1.0 for save, 0.6 for full play, 0.1 for skip
): Promise<void> {
  const audioFeature = await prisma.audioFeature.findUnique({
    where: { postId },
    select: { embedding: true },
  });
  if (!audioFeature || !audioFeature.embedding.length) return;

  const profile = await prisma.userProfile.findUnique({ where: { userId } });

  const alpha = weight * 0.05; // learning rate
  let newVector: number[];

  if (!profile || !profile.preferenceVector.length) {
    newVector = audioFeature.embedding;
  } else {
    const prev = profile.preferenceVector;
    newVector = prev.map((v, i) => (1 - alpha) * v + alpha * audioFeature.embedding[i]);
  }

  await prisma.userProfile.upsert({
    where: { userId },
    update: { preferenceVector: newVector },
    create: { userId, preferenceVector: newVector },
  });

  // Invalidate recommendation cache
  const keys = await redis.keys(`recommend:${userId}:*`).catch(() => [] as string[]);
  if (keys.length) await redis.del(...keys).catch(() => null);
}
