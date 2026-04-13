import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';

const ALLOWED_AUDIO_TYPES = ['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/ogg'];
const MAX_AUDIO_SIZE = 50 * 1024 * 1024; // 50MB

// Local disk storage (use multer-s3 in production)
const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, process.env.UPLOAD_DIR || '/tmp/resonance-uploads');
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

function audioFileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
): void {
  if (ALLOWED_AUDIO_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported audio type: ${file.mimetype}`));
  }
}

export const audioUpload = multer({
  storage: diskStorage,
  fileFilter: audioFileFilter,
  limits: { fileSize: MAX_AUDIO_SIZE },
});
