import { readFileSync, statSync, readdirSync, copyFileSync, existsSync } from 'fs';
import { extname, basename, join } from 'path';
import { FILES_DIR } from './paths.js';
import { insertDocument, listDocuments } from './db.js';

const TYPE_MAP = {
  '.md': 'markdown',
  '.txt': 'text', '.log': 'text',
  '.json': 'text', '.yaml': 'text', '.yml': 'text',
  '.xml': 'text', '.csv': 'text',
  '.js': 'code', '.ts': 'code', '.py': 'code',
  '.go': 'code', '.rs': 'code', '.java': 'code',
  '.sh': 'code', '.c': 'code', '.cpp': 'code',
  '.rb': 'code', '.jsx': 'code', '.tsx': 'code',
  '.html': 'code', '.css': 'code', '.sql': 'code',
  '.pdf': 'pdf',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image',
  '.gif': 'image', '.webp': 'image', '.bmp': 'image', '.svg': 'image',
  '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio',
  '.flac': 'audio', '.m4a': 'audio', '.aac': 'audio',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video',
  '.avi': 'video', '.mkv': 'video',
};

const PDF_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const PDF_PARSE_TIMEOUT_MS = 30_000;   // 30 s

async function extractPdfContent(filePath, filename) {
  try {
    const stat = statSync(filePath);
    if (stat.size > PDF_MAX_BYTES) {
      return `[pdf file: ${filename}] Skipped: file exceeds ${PDF_MAX_BYTES / 1024 / 1024} MB size limit`;
    }

    const pdfParse = (await import('pdf-parse')).default;
    const buffer = readFileSync(filePath);

    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('PDF parsing timed out after 30 s')), PDF_PARSE_TIMEOUT_MS)
    );
    const data = await Promise.race([pdfParse(buffer), timeout]);
    return data.text;
  } catch (err) {
    return `[pdf file: ${filename}] Could not extract text: ${err.message}`;
  }
}

function extractContent(filePath, type, filename) {
  if (type === 'markdown' || type === 'text' || type === 'code') {
    return readFileSync(filePath, 'utf-8');
  }
  // image, audio, video — metadata only
  const fileSize = statSync(filePath).size;
  return `[${type} file: ${filename}] Size: ${fileSize} bytes`;
}

export async function ingestFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  const type = TYPE_MAP[ext];
  if (!type) return null;

  const filename = basename(filePath);
  const title = basename(filePath, ext);
  const stat = statSync(filePath);

  // Extract content
  let content;
  if (type === 'pdf') {
    content = await extractPdfContent(filePath, filename);
  } else {
    content = extractContent(filePath, type, filename);
  }

  // Copy file to FILES_DIR with timestamp prefix
  const destName = `${Date.now()}-${filename}`;
  const destPath = join(FILES_DIR, destName);
  copyFileSync(filePath, destPath);

  // Insert into DB
  const doc = insertDocument({
    title,
    content,
    source: filename,
    doc_type: type,
    file_path: destPath,
    file_size: stat.size,
  });

  return doc;
}

function collectFiles(dir) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath));
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (TYPE_MAP[ext]) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

export async function ingestDirectory(dirPath) {
  if (!existsSync(dirPath)) {
    throw new Error(`Directory not found: ${dirPath}`);
  }

  const files = collectFiles(dirPath);

  // Get all existing sources for duplicate detection
  const existing = listDocuments({ limit: 100000 });
  const existingSources = new Set(existing.map(d => d.source));

  let ingested = 0;
  let skipped = 0;
  const errors = [];

  for (const filePath of files) {
    const filename = basename(filePath);
    if (existingSources.has(filename)) {
      skipped++;
      continue;
    }
    try {
      await ingestFile(filePath);
      existingSources.add(filename); // prevent duplicates within same batch
      ingested++;
    } catch (err) {
      errors.push(`${filename}: ${err.message}`);
    }
  }

  return { ingested, skipped, errors };
}

export function ingestText(title, content, { tags, doc_type, source } = {}) {
  return insertDocument({
    title,
    content,
    source: source || 'manual',
    doc_type: doc_type || 'text',
    tags: Array.isArray(tags) ? tags.join(', ') : (tags || ''),
    file_size: Buffer.byteLength(content),
  });
}
