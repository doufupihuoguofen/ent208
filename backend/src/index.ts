import 'dotenv/config';
import app from './app';
import { prisma } from './config/database';
import { redis } from './config/redis';

const PORT = Number(process.env.PORT) || 3001;

async function main() {
  // Connect to Postgres
  await prisma.$connect();
  console.log('[DB] PostgreSQL connected');

  // Connect to Redis (lazy – errors logged inside config/redis.ts)
  await redis.connect().catch(() => null);

  const server = app.listen(PORT, () => {
    console.log(`[Server] Resonance backend running on http://localhost:${PORT}`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[Server] SIGTERM received – shutting down gracefully');
    server.close(async () => {
      await prisma.$disconnect();
      await redis.quit();
      process.exit(0);
    });
  });
}

main().catch((err) => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});
