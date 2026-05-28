import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const key = process.env.AGENTHUB_ENCRYPTION_KEY;
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('AGENTHUB_ENCRYPTION_KEY not set — required in production');
    }
    // Development fallback: derive key from JWT secret
    const devKey = process.env.JWT_SECRET || 'agenthub-dev-fallback-key';
    return crypto.createHash('sha256').update(devKey).digest();
  }
  // If key is hex-encoded (exactly 64 hex chars), decode it
  if (/^[0-9a-fA-F]{64}$/.test(key)) return Buffer.from(key, 'hex');
  // Otherwise, hash it to get 32 bytes
  return crypto.createHash('sha256').update(key).digest();
}

export function encryptApiKey(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: iv:authTag:ciphertext (all hex)
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptApiKey(encoded: string): string {
  const key = getEncryptionKey();
  const [ivHex, authTagHex, cipherHex] = encoded.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(cipherHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

export function maskApiKey(key: string): string {
  if (key.length <= 7) return '***';
  return `${key.slice(0, 3)}***${key.slice(-4)}`;
}
