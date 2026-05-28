import { Hono } from 'hono';
import type { Context } from 'hono';
import { mkdir, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { prisma } from '../db/prisma.js';
import { getUser } from '../lib/auth.js';

const avatar = new Hono();

const ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);
const MAX_SIZE = 2 * 1024 * 1024; // 2MB
const EXTENSION_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// POST /api/avatar/upload — multipart file upload
avatar.post('/upload', async (c) => {
  const result = await getUser(c);
  if (result instanceof Response) return result;
  const user = result;

  // Parse multipart body
  let body: Record<string, any>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: 'Failed to parse request body. Expected multipart/form-data.' }, 400);
  }

  const fileEntry = body['avatar'];
  if (!fileEntry) {
    return c.json({ error: 'No file provided. Use form field name "avatar".' }, 400);
  }

  // The file can be a File object or fallback raw data
  let fileBuffer: Buffer;
  let fileName: string;
  let mimeType: string;

  if (typeof fileEntry === 'object' && fileEntry !== null && 'arrayBuffer' in fileEntry) {
    // Web standard File object
    const file = fileEntry as File;
    fileBuffer = Buffer.from(await file.arrayBuffer());
    fileName = file.name || 'avatar';
    mimeType = file.type || 'application/octet-stream';
  } else if (typeof fileEntry === 'object' && fileEntry !== null && 'data' in fileEntry) {
    // Some runtimes return { data, filename, mimetype }
    fileBuffer = Buffer.from(fileEntry.data);
    fileName = fileEntry.filename || 'avatar';
    mimeType = fileEntry.mimetype || 'application/octet-stream';
  } else if (Buffer.isBuffer(fileEntry)) {
    fileBuffer = fileEntry;
    fileName = 'avatar';
    mimeType = 'application/octet-stream';
  } else {
    return c.json({ error: 'Unsupported file format' }, 400);
  }

  // Validate file size
  if (fileBuffer.length > MAX_SIZE) {
    return c.json({ error: 'File too large. Maximum size is 2MB.' }, 413);
  }

  // Validate MIME type
  if (!ALLOWED_TYPES.has(mimeType)) {
    return c.json({ error: `Invalid file type: ${mimeType}. Allowed: png, jpg, jpeg, gif, webp.` }, 400);
  }

  // Determine extension
  const ext = EXTENSION_MAP[mimeType] || '.png';
  const avatarFilename = `${user.userId}${ext}`;
  const avatarDir = resolve('.uploads', 'avatars');
  const avatarPath = resolve(avatarDir, avatarFilename);

  // Ensure uploads directory exists
  await mkdir(avatarDir, { recursive: true });

  // Write file
  await writeFile(avatarPath, fileBuffer);

  // Update User.avatarUrl in DB
  const url = `/uploads/avatars/${avatarFilename}`;
  await prisma.user.update({
    where: { id: user.userId },
    data: { avatarUrl: url },
  });

  return c.json({ url });
});

export default avatar;
