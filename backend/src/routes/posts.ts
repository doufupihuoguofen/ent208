import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { authMiddleware, optionalAuth } from '../middleware/auth';
import { audioUpload } from '../middleware/upload';
import axios from 'axios';
import fs from 'fs';

const router = Router();

// GET /api/posts  — list with optional filters
router.get('/', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { game, mood, genre, limit = '20', offset = '0' } = req.query as Record<string, string>;

    const where: Record<string, unknown> = {};
    if (game) where.gameTags = { has: game };
    if (mood) where.moodTag = mood;
    if (genre) where.musicGenre = genre;

    const [posts, total] = await Promise.all([
      prisma.post.findMany({
        where,
        orderBy: { hotScore: 'desc' },
        take: Math.min(Number(limit), 100),
        skip: Number(offset),
        include: {
          user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          audioFeature: { select: { spectralCentroid: true, tempo: true, status: true } },
        },
      }),
      prisma.post.count({ where }),
    ]);

    res.json({ posts, total, limit: Number(limit), offset: Number(offset) });
  } catch (err) {
    next(err);
  }
});

// GET /api/posts/:id
router.get('/:id', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const postId = req.params['id'] as string;
    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: {
        user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        audioFeature: true,
        comments: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
    });
    if (!post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    // Track play interaction if authenticated
    if (req.user) {
      prisma.interaction
        .create({
          data: { userId: req.user.userId, postId: post.id, type: 'PLAY' },
        })
        .catch(() => null);
    }

    res.json(post);
  } catch (err) {
    next(err);
  }
});

// POST /api/posts  — create post with optional audio upload
router.post(
  '/',
  authMiddleware,
  audioUpload.single('audio'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { title, content, gameTags, moodTag, musicGenre, fingerprint, license } =
        req.body as {
          title: string;
          content?: string;
          gameTags?: string;
          moodTag?: string;
          musicGenre?: string;
          fingerprint?: string;
          license?: string;
        };

      if (!title) {
        res.status(400).json({ error: 'title is required' });
        return;
      }

      const parsedGameTags = gameTags ? JSON.parse(gameTags) : [];
      const parsedFingerprint = fingerprint ? JSON.parse(fingerprint) : undefined;

      let audioUrl: string | undefined;
      if (req.file) {
        // In production: upload to S3 and return CDN URL
        audioUrl = `/uploads/${req.file.filename}`;
      }

      const post = await prisma.post.create({
        data: {
          userId: req.user!.userId,
          title,
          content,
          audioUrl,
          gameTags: parsedGameTags,
          moodTag,
          musicGenre,
          fingerprint: parsedFingerprint,
          license: license || 'CC-BY-NC',
        },
        include: {
          user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        },
      });

      // Increment user post count
      await prisma.user.update({
        where: { id: req.user!.userId },
        data: { postCount: { increment: 1 } },
      });

      // Asynchronously trigger audio feature extraction
      if (req.file) {
        triggerFeatureExtraction(post.id, req.user!.userId, req.file.path).catch((err) => {
          console.error('[Audio] feature extraction trigger failed:', err.message);
        });
      }

      res.status(201).json(post);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/posts/:id/like
router.post('/:id/like', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params['id'] as string;
    const userId = req.user!.userId;

    const existing = await prisma.interaction.findFirst({
      where: { userId, postId: id, type: 'LIKE' },
    });

    if (existing) {
      // Unlike
      await prisma.interaction.delete({ where: { id: existing.id } });
      await prisma.post.update({ where: { id }, data: { likeCount: { decrement: 1 } } });
      res.json({ liked: false });
    } else {
      await prisma.interaction.create({ data: { userId, postId: id, type: 'LIKE' } });
      await prisma.post.update({ where: { id }, data: { likeCount: { increment: 1 } } });
      res.json({ liked: true });
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/posts/:id/comments
router.post(
  '/:id/comments',
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const postId = req.params['id'] as string;
      const { content } = req.body as { content: string };
      if (!content) {
        res.status(400).json({ error: 'content is required' });
        return;
      }

      const comment = await prisma.comment.create({
        data: { postId, userId: req.user!.userId, content },
      });
      await prisma.post.update({
        where: { id: postId },
        data: { commentCount: { increment: 1 } },
      });
      await prisma.interaction.create({
        data: { userId: req.user!.userId, postId, type: 'COMMENT' },
      });

      res.status(201).json(comment);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/posts/:id/save
router.post(
  '/:id/save',
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params['id'] as string;
      const userId = req.user!.userId;

      const existing = await prisma.interaction.findFirst({
        where: { userId, postId: id, type: 'SAVE' },
      });

      if (existing) {
        await prisma.interaction.delete({ where: { id: existing.id } });
        res.json({ saved: false });
      } else {
        await prisma.interaction.create({ data: { userId, postId: id, type: 'SAVE' } });
        res.json({ saved: true });
      }
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/interactions/play  — track play duration
router.post(
  '/interactions/play',
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { postId, duration } = req.body as { postId: string; duration: number };
      if (!postId) {
        res.status(400).json({ error: 'postId required' });
        return;
      }

      await prisma.interaction.create({
        data: { userId: req.user!.userId, postId, type: 'PLAY', duration },
      });
      await prisma.post.update({ where: { id: postId }, data: { playCount: { increment: 1 } } });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// Helper: call Python audio-service to extract features
async function triggerFeatureExtraction(
  postId: string,
  userId: string,
  filePath: string,
): Promise<void> {
  const audioServiceUrl = process.env.AUDIO_SERVICE_URL || 'http://localhost:8000';
  const form = new FormData();
  form.append('post_id', postId);
  form.append('user_id', userId);

  const fileBuffer = fs.readFileSync(filePath);
  const blob = new Blob([fileBuffer]);
  form.append('file', blob, 'audio.wav');

  await axios.post(`${audioServiceUrl}/extract`, form);
}

export default router;
