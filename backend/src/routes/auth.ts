import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/database';
import { authMiddleware } from '../middleware/auth';

const router = Router();

function signTokens(userId: string, username: string, email: string) {
  const payload = { userId, username, email };
  const accessToken = jwt.sign(payload, process.env.JWT_SECRET as string, {
    expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as jwt.SignOptions['expiresIn'],
  });
  const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET as string, {
    expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN || '30d') as jwt.SignOptions['expiresIn'],
  });
  return { accessToken, refreshToken };
}

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, email, password, displayName } = req.body as {
      username: string;
      email: string;
      password: string;
      displayName?: string;
    };

    if (!username || !email || !password) {
      res.status(400).json({ error: 'username, email, and password are required' });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }

    const existing = await prisma.user.findFirst({
      where: { OR: [{ username }, { email }] },
    });
    if (existing) {
      res.status(409).json({ error: 'Username or email already taken' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { username, email, passwordHash, displayName: displayName || username },
    });

    const tokens = signTokens(user.id, user.username, user.email);
    res.status(201).json({ user: { id: user.id, username: user.username, email: user.email }, ...tokens });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { identifier, password } = req.body as { identifier: string; password: string };
    if (!identifier || !password) {
      res.status(400).json({ error: 'identifier and password are required' });
      return;
    }

    const user = await prisma.user.findFirst({
      where: { OR: [{ username: identifier }, { email: identifier }] },
    });
    if (!user || !user.passwordHash) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const tokens = signTokens(user.id, user.username, user.email);
    res.json({ user: { id: user.id, username: user.username, email: user.email }, ...tokens });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = req.body as { refreshToken: string };
  if (!refreshToken) {
    res.status(400).json({ error: 'refreshToken required' });
    return;
  }
  try {
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET as string) as {
      userId: string;
      username: string;
      email: string;
    };
    const tokens = signTokens(payload.userId, payload.username, payload.email);
    res.json(tokens);
  } catch {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true,
        username: true,
        email: true,
        displayName: true,
        avatarUrl: true,
        bio: true,
        postCount: true,
        followerCount: true,
        followingCount: true,
        copyrightLicense: true,
        createdAt: true,
        userBadges: { include: { badge: true } },
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

export default router;
