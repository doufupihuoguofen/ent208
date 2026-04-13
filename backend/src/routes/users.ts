import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// GET /api/users/:username
router.get('/:username', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const username = req.params['username'] as string;
    const user = await prisma.user.findUnique({
      where: { username },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        bio: true,
        postCount: true,
        followerCount: true,
        followingCount: true,
        createdAt: true,
        userBadges: { include: { badge: true } },
        posts: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: {
            audioFeature: { select: { spectralCentroid: true, tempo: true } },
          },
        },
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json(user);
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/me  — update profile
router.put('/me', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { displayName, bio, copyrightLicense } = req.body as {
      displayName?: string;
      bio?: string;
      copyrightLicense?: string;
    };

    const user = await prisma.user.update({
      where: { id: req.user!.userId },
      data: {
        ...(displayName !== undefined && { displayName }),
        ...(bio !== undefined && { bio }),
        ...(copyrightLicense !== undefined && { copyrightLicense }),
      },
      select: { id: true, username: true, displayName: true, bio: true, copyrightLicense: true },
    });

    res.json(user);
  } catch (err) {
    next(err);
  }
});

// POST /api/users/:id/follow
router.post('/:id/follow', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const followingId = req.params['id'] as string;
    const followerId = req.user!.userId;

    if (followerId === followingId) {
      res.status(400).json({ error: 'Cannot follow yourself' });
      return;
    }

    const existing = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId, followingId } },
    });

    if (existing) {
      // Unfollow
      await prisma.follow.delete({ where: { id: existing.id } });
      await Promise.all([
        prisma.user.update({ where: { id: followerId }, data: { followingCount: { decrement: 1 } } }),
        prisma.user.update({ where: { id: followingId }, data: { followerCount: { decrement: 1 } } }),
      ]);
      res.json({ following: false });
    } else {
      await prisma.follow.create({ data: { followerId, followingId } });
      await Promise.all([
        prisma.user.update({ where: { id: followerId }, data: { followingCount: { increment: 1 } } }),
        prisma.user.update({ where: { id: followingId }, data: { followerCount: { increment: 1 } } }),
      ]);
      res.json({ following: true });
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/users/:id/followers
router.get('/:id/followers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const followingId = req.params['id'] as string;
    const follows = await prisma.follow.findMany({
      where: { followingId },
      include: {
        follower: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(follows.map((f) => f.follower));
  } catch (err) {
    next(err);
  }
});

// GET /api/users/:id/following
router.get('/:id/following', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const followerId = req.params['id'] as string;
    const follows = await prisma.follow.findMany({
      where: { followerId },
      include: {
        following: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(follows.map((f) => f.following));
  } catch (err) {
    next(err);
  }
});

export default router;
