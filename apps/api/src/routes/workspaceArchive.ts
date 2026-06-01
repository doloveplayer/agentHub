import { readdirSync, readFileSync, statSync } from 'fs';
import { basename, relative, resolve, sep } from 'path';
import { resolveWorkspaceFilePath } from './workspaceFileAccess.js';

export interface ArchiveFile {
  archivePath: string;
  absolutePath: string;
  content: Buffer;
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

export function workspaceDownloadName(path: string, isDirectory: boolean): string {
  const clean = path.replace(/^\/workspace\/?/, '').replace(/\/+$/, '');
  const rawName = clean ? basename(clean) : 'workspace';
  const safe = rawName.replace(/[^a-zA-Z0-9._-]/g, '_') || 'workspace';
  return isDirectory ? `${safe}.zip` : safe;
}

export function collectArchiveFiles(workspaceRoot: string, inputPath: string): ArchiveFile[] {
  const resolved = resolveWorkspaceFilePath(workspaceRoot, inputPath);
  if (!resolved.ok) throw Object.assign(new Error(resolved.error), { status: resolved.status });

  const stat = statSync(resolved.absolutePath);
  if (!stat.isDirectory()) {
    return [{
      archivePath: basename(resolved.absolutePath),
      absolutePath: resolved.absolutePath,
      content: readFileSync(resolved.absolutePath),
    }];
  }

  const files: ArchiveFile[] = [];
  collectDirectory(workspaceRoot, resolved.absolutePath, files);
  return files.sort((a, b) => a.archivePath.localeCompare(b.archivePath));
}

export function buildWorkspaceZip(files: ArchiveFile[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.archivePath.replace(/\\/g, '/'));
    const crc = crc32(file.content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(file.content.length, 18);
    localHeader.writeUInt32LE(file.content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, name, file.content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(file.content.length, 20);
    centralHeader.writeUInt32LE(file.content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + file.content.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

function collectDirectory(workspaceRoot: string, dirPath: string, files: ArchiveFile[]): void {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = resolve(dirPath, entry.name);
    if (!isInsideWorkspace(workspaceRoot, absolutePath)) continue;
    if (entry.isDirectory()) {
      collectDirectory(workspaceRoot, absolutePath, files);
    } else if (entry.isFile()) {
      files.push({
        archivePath: relative(workspaceRoot, absolutePath).split(sep).join('/'),
        absolutePath,
        content: readFileSync(absolutePath),
      });
    }
  }
}

function isInsideWorkspace(workspaceRoot: string, absolutePath: string): boolean {
  const rootWithSeparator = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`;
  return absolutePath === workspaceRoot || absolutePath.startsWith(rootWithSeparator);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
