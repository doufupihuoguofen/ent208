# Resonance — EchoPlay 🎵

> "小黑盒 × SoundCloud" — 以情绪为纽带的游戏音乐社交社区

## 项目结构

```
ent208/
├── index.html          # 前端 Demo (原生 HTML/CSS/JS + Web Audio API)
├── backend/            # Node.js 20 + Express + TypeScript + Prisma ORM
│   ├── src/
│   │   ├── routes/     # auth / posts / users / recommend
│   │   ├── services/   # recommendService (混合推荐算法)
│   │   ├── middleware/ # JWT 认证 / 文件上传 / 错误处理
│   │   └── config/     # Prisma + Redis
│   └── prisma/
│       └── schema.prisma  # PostgreSQL schema
├── audio-service/      # Python 3.11 + FastAPI + Librosa + Celery
│   └── app/
│       ├── main.py         # FastAPI 路由
│       ├── extractor.py    # 128维音频特征向量提取
│       ├── tasks.py        # Celery 异步任务
│       ├── db.py           # PostgreSQL 写入
│       └── pinecone_client.py  # 向量数据库（可选）
├── docker-compose.yml  # PostgreSQL + Redis + Backend + Audio Service + Celery
└── .env.example        # 环境变量模板
```

## 快速启动

### 前置条件
- Docker + Docker Compose
- Node.js 20+（本地开发）
- Python 3.11+（本地开发）

### Docker 一键启动

```bash
cp .env.example .env
# 编辑 .env 填写 JWT_SECRET 等
docker compose up -d
```

服务端口：
| 服务 | 端口 |
|------|------|
| Express 后端 API | 3001 |
| Python 音频微服务 | 8000 |
| PostgreSQL | 5432 |
| Redis | 6379 |

### 本地开发

**后端：**
```bash
cd backend
cp .env.example .env     # 填写 DATABASE_URL / REDIS_URL / JWT_SECRET
npm install
npx prisma migrate dev   # 建表
npm run dev              # http://localhost:3001
```

**音频微服务：**
```bash
cd audio-service
cp .env.example .env
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
# Celery worker（另开终端）:
celery -A app.tasks worker -Q resonance-audio --loglevel=info
```

## 核心 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/register` | 注册 |
| POST | `/api/auth/login` | 登录，返回 JWT |
| GET  | `/api/auth/me` | 当前用户信息 |
| GET  | `/api/posts` | 帖子列表（支持 game/mood/genre 过滤）|
| POST | `/api/posts` | 发帖（含音频上传）|
| POST | `/api/posts/:id/like` | 点赞/取消 |
| POST | `/api/posts/:id/comments` | 评论 |
| GET  | `/api/recommend` | 个性化推荐（JWT 必选）|
| POST | `/api/users/:id/follow` | 关注/取消 |
| POST | `/extract/sync` (音频服务) | 同步提取 128 维特征向量 |

## 推荐算法

```
score = audio_cosine × 0.4 + game_preference × 0.3 + social_graph × 0.2 + hot_score × 0.1
```

- **audio_cosine**: 用户偏好向量与帖子音频 embedding 余弦相似度
- **game_preference**: 用户 Steam 游玩时长加权匹配
- **social_graph**: 是否由关注用户发布
- **hot_score**: 综合点赞/播放/分享的热度分

## 数据库表

| 表名 | 说明 |
|------|------|
| users | 用户基础信息 + OAuth IDs |
| posts | 帖子（音频 URL + 3D 标签：游戏×心情×风格）|
| audio_features | 128 维 embedding + Librosa 原始特征 |
| game_library | Steam 游戏库同步 |
| interactions | 播放/跳过/点赞/收藏/分享 行为追踪 |
| follows | 社交关系图 |
| badges / user_badges | 成就系统 |
| user_profiles | 用户偏好向量（实时更新）|

## 技术栈

- **前端**: 原生 HTML/CSS/JS + Web Audio API（Demo）→ React 18 + TypeScript（规划）
- **后端**: Node.js 20 + Express + TypeScript + Prisma ORM
- **音频**: Python 3.11 + Librosa + FastAPI + Celery
- **数据库**: PostgreSQL 15 + Redis 7 + Pinecone（向量，可选）
- **部署**: Docker Compose → Kubernetes + GitHub Actions CI/CD
