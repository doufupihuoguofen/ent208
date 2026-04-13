import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { authMiddleware } from '../middleware/auth';
import { getRecommendations } from '../services/recommendService';

const router = Router();

/**
 * GET /api/recommend
 * Returns a personalized list of posts for the authenticated user.
 * Query params: limit (default 20, max 50)
 */
router.get('/', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 50);
    const userId = req.user!.userId;

    const postIds = await getRecommendations(userId, limit);

    if (postIds.length === 0) {
      // Cold start: return trending posts
      const trending = await prisma.post.findMany({
        where: { userId: { not: userId } },
        orderBy: { hotScore: 'desc' },
        take: limit,
        include: {
          user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          audioFeature: { select: { spectralCentroid: true, tempo: true, status: true } },
        },
      });
      res.json({ posts: trending, source: 'trending' });
      return;
    }

    // Fetch in-order (preserve ranking)
    const posts = await prisma.post.findMany({
      where: { id: { in: postIds } },
      include: {
        user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        audioFeature: { select: { spectralCentroid: true, tempo: true, status: true } },
      },
    });

    // Re-sort to match ranked order
    const indexMap = new Map(postIds.map((id, i) => [id, i]));
    posts.sort((a, b) => (indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0));

    res.json({ posts, source: 'personalized' });
  } catch (err) {
    next(err);
  }
});

export default router;
