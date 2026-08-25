'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { sanitizeSegment } = require('../utils/paths');

const DATASET_FILENAME = 'dataset.jsonl';
const MANIFEST_FILENAME = 'dataset-manifest.json';
const DOCUMENTS_DIRNAME = 'markdown';
const MANIFEST_VERSION = 1;

/**
 * The corpus: one JSON object per line in dataset.jsonl, plus the manifest
 * that makes the next run incremental.
 *
 * JSONL rather than a directory of files because every consumer of a training
 * or retrieval corpus streams it line by line, and because a single file with
 * one record per document keeps the metadata beside the text instead of in a
 * parallel index that can drift out of step with it.
 *
 * Deliberately NOT chunked. Chunk boundaries are a retrieval-engine decision -
 * they depend on the embedding model's window and on how the retriever scores
 * overlap - so this stores whole documents with their structure intact and
 * leaves splitting to whatever consumes them.
 */

/** Epoch seconds (what a query index carries) as an ISO timestamp. */
function isoFromEpoch(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  // Tolerate a feed that already publishes milliseconds: a plain seconds value
  // for any plausible date is 10 digits, so anything far larger is already ms.
  const ms = seconds > 1e11 ? seconds : seconds * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** First path segment: the section a document belongs to ("developer", "docs"). */
function sectionOf(docPath) {
  const segments = String(docPath || '').split('/').filter(Boolean);
  return segments.length ? segments[0] : '(root)';
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * Build one dataset record from an index row and the fetched document.
 *
 * Field order matters a little: url and title first so a human scanning the
 * raw JSONL can tell what a line is without reading past the text blob.
 */
function buildRecord({ row, origin, text, sourceUrl, fetchedAt, format }) {
  const docPath = row.path;
  const record = {
    id: sha256(new URL(docPath, origin).toString()).slice(0, 16),
    url: new URL(docPath, origin).toString(),
    path: docPath,
    section: sectionOf(docPath),
    title: row.title || null,
    description: row.description || null,
    lastModified: isoFromEpoch(row.lastModified),
    publicationDate: isoFromEpoch(row.publicationDate),
    source: sourceUrl,
    format,
    bytes: Buffer.byteLength(text),
    sha256: sha256(text),
    fetchedAt,
    text,
  };
  // Carry through index columns this schema does not name, so a site with
  // extra metadata does not silently lose it. Known keys are already mapped
  // above; `image` and friends land here.
  const known = new Set([
    'path',
    'title',
    'description',
    'lastModified',
    'publicationDate',
    'robots',
  ]);
  const extra = {};
  for (const [key, value] of Object.entries(row)) {
    if (!known.has(key) && value !== '' && value !== null && value !== undefined) {
      extra[key] = value;
    }
  }
  if (Object.keys(extra).length) record.indexFields = extra;
  return record;
}

/** Read an existing dataset.jsonl into a Map keyed by path. Missing file = empty. */
function readDataset(file) {
  const byPath = new Map();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return byPath;
  }
  let malformed = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record && record.path) byPath.set(record.path, record);
    } catch {
      // A truncated last line (killed mid-write) must not lose the whole
      // corpus: skip it and let the run rebuild that record.
      malformed++;
    }
  }
  byPath.malformed = malformed;
  return byPath;
}

/** Write dataset.jsonl atomically, sorted by path so diffs between runs are readable. */
function writeDataset(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sorted = [...records].sort((a, b) => a.path.localeCompare(b.path));
  const body = sorted.map((record) => JSON.stringify(record)).join('\n');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, sorted.length ? `${body}\n` : '');
  fs.renameSync(tmp, file);
  return { file, count: sorted.length, bytes: Buffer.byteLength(body) };
}

/**
 * The manifest: what this run saw, and what state each document is in.
 *
 * This is what makes `--refresh` cheap. It records every document's
 * `lastModified` and content hash, so the next run re-fetches only what the
 * index says has changed and leaves the rest untouched.
 */
function writeManifest(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: MANIFEST_VERSION, ...payload }, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

function readManifest(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && data.version === MANIFEST_VERSION ? data : null;
  } catch {
    return null;
  }
}

/**
 * Where one document's own file goes, relative to the documents directory.
 *
 * The site's own folder structure is mirrored rather than flattened, because
 * the whole point of keeping the files is to read and grep them: `/developer/x`
 * becomes `developer/x.md`, so the corpus browses the way the site does.
 * (raw-html/ in the archiver is flat instead - different job, different rule:
 * there the filename has to survive a URL with a query string in it.)
 *
 * A path ending in `/` is a directory index, so `/docs/` becomes
 * `docs/index.md`, and `/` becomes `index.md`.
 *
 * Every segment goes through the archiver's own sanitizer, which strips the
 * characters Windows rejects, neutralises reserved names like `con`, and drops
 * leading dots. `.` and `..` segments are discarded outright: a path from a
 * remote index must never be able to write outside the output directory.
 */
function documentFilePath(docPath, extension = '.md') {
  const segments = String(docPath)
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .map((segment) => sanitizeSegment(decodeURIComponentSafe(segment)));

  if (docPath.endsWith('/') || segments.length === 0) segments.push('index');
  const last = segments.pop();
  // Don't end up with "x.md.md" when the path already carries the extension.
  const name = last.toLowerCase().endsWith(extension.toLowerCase()) ? last : `${last}${extension}`;
  return path.join(...segments, name);
}

function decodeURIComponentSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Write each document as its own file under `directory`, mirroring the site.
 *
 * Runs on every collection, including one where nothing was re-fetched: the
 * text is already in hand, writing 2 MB costs nothing, and it means the folder
 * always matches dataset.jsonl instead of drifting from it whenever a file is
 * deleted by hand.
 */
function writeDocumentFiles(directory, records, extension = '.md') {
  const written = [];
  for (const record of records) {
    if (typeof record.text !== 'string') continue;
    const relative = documentFilePath(record.path, extension);
    const file = path.join(directory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, record.text);
    written.push(relative);
  }
  return { directory, files: written };
}

/**
 * Delete the files of documents that are no longer in the corpus, then any
 * directories those files emptied.
 *
 * Without this an unpublished page keeps its file for ever, and a later grep
 * over the folder still finds content the dataset dropped.
 */
function removeDocumentFiles(directory, docPaths, extension = '.md') {
  const removed = [];
  for (const docPath of docPaths) {
    const file = path.join(directory, documentFilePath(docPath, extension));
    try {
      fs.unlinkSync(file);
      removed.push(file);
    } catch {
      continue; // already gone, or never written
    }
    // Walk up while the directories we just emptied stay empty, stopping at
    // the documents root so an unrelated empty folder is never touched.
    let parent = path.dirname(file);
    while (parent.startsWith(directory) && parent !== directory) {
      try {
        if (fs.readdirSync(parent).length > 0) break;
        fs.rmdirSync(parent);
      } catch {
        break;
      }
      parent = path.dirname(parent);
    }
  }
  return removed;
}

module.exports = {
  DATASET_FILENAME,
  MANIFEST_FILENAME,
  DOCUMENTS_DIRNAME,
  MANIFEST_VERSION,
  buildRecord,
  readDataset,
  writeDataset,
  writeManifest,
  readManifest,
  documentFilePath,
  writeDocumentFiles,
  removeDocumentFiles,
  isoFromEpoch,
  sectionOf,
  sha256,
};
