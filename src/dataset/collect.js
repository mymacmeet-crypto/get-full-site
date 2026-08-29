'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { RateLimiter } = require('../rateLimiter');
const { Logger } = require('../logger');
const { mapWithConcurrency, formatBytes, formatDuration } = require('../utils/misc');
const { fetchIndex, fetchDocument } = require('./source');
const { cleanEdsMarkdown } = require('../eds-markdown');
const {
  DATASET_FILENAME,
  MANIFEST_FILENAME,
  DOCUMENTS_DIRNAME,
  buildRecord,
  readDataset,
  writeDataset,
  writeManifest,
  writeDocumentFiles,
  removeDocumentFiles,
  isoFromEpoch,
  sectionOf,
} = require('./dataset');

/**
 * Collect a corpus from an Edge Delivery Services site.
 *
 * The whole run is: read the index, decide what needs fetching, fetch those as
 * Markdown, merge with what is already on disk, write dataset.jsonl. No
 * browser, no crawl frontier, no capture.
 */

/**
 * Does this index row forbid indexing?
 *
 * The `robots` column carries the same directives as a robots meta tag
 * ("noindex", "noindex, nofollow"). It is the publisher stating intent for
 * this exact document, which is more precise than robots.txt path patterns -
 * so it is honoured by default, and a corpus built for retrieval should not
 * contain pages the publisher marked as not-for-indexing.
 */
function isNoIndex(row) {
  const directives = String(row.robots || '')
    .toLowerCase()
    .split(',')
    .map((directive) => directive.trim());
  return directives.includes('noindex') || directives.includes('none');
}

/** Decide which rows are in scope, and record why the others are not. */
function selectRows(rows, config, skipped) {
  const selected = [];
  for (const row of rows) {
    if (!row || typeof row.path !== 'string' || !row.path.startsWith('/')) {
      skipped.push({ path: (row && row.path) || '(no path)', reason: 'no-usable-path' });
      continue;
    }
    if (!config.includeNoIndex && isNoIndex(row)) {
      skipped.push({ path: row.path, reason: 'robots-noindex' });
      continue;
    }
    if (config.excludePatterns.some((pattern) => pattern.test(row.path))) {
      skipped.push({ path: row.path, reason: 'excluded-pattern' });
      continue;
    }
    if (
      config.includePatterns.length > 0 &&
      !config.includePatterns.some((pattern) => pattern.test(row.path))
    ) {
      skipped.push({ path: row.path, reason: 'no-include-match' });
      continue;
    }
    selected.push(row);
  }
  return selected;
}

/**
 * Split the selected rows into "already have it, unchanged" and "must fetch".
 *
 * The test is the index's own `lastModified`. A document whose timestamp has
 * not moved since the stored record was fetched is reused as-is, which is what
 * makes a refresh of a 195-page site cost a single index request.
 *
 * A row with no `lastModified` at all is always re-fetched: without a
 * timestamp there is no evidence it is unchanged, and silently keeping a stale
 * record is worse than paying for one request.
 */
function planWork(rows, existing, config) {
  const fetchList = [];
  const reused = [];
  for (const row of rows) {
    const previous = existing.get(row.path);
    const stamp = isoFromEpoch(row.lastModified);
    const unchanged =
      previous && previous.text !== undefined && stamp && previous.lastModified === stamp;
    if (unchanged && !config.force) {
      reused.push(previous);
    } else {
      fetchList.push({ row, previous: previous || null, reason: !previous ? 'new' : 'changed' });
    }
  }
  return { fetchList, reused };
}

async function collect(config) {
  const logger = new Logger(config.logLevel);
  const startedAt = Date.now();
  const origin = new URL(config.siteUrl).origin;
  const host = new URL(config.siteUrl).hostname;

  const outputDirectory = path.join(config.outputFolder, host);
  const datasetFile = config.datasetFile || path.join(outputDirectory, DATASET_FILENAME);
  const manifestFile = path.join(outputDirectory, MANIFEST_FILENAME);
  // Beside the dataset, not inside it: the JSONL is one file, so a folder named
  // after it would read as its contents.
  const documentsDirectory = config.writeFiles
    ? config.documentsDir || path.join(outputDirectory, DOCUMENTS_DIRNAME)
    : null;

  const rateLimiter = new RateLimiter(config.delayMs);
  const fetchOptions = {
    timeoutMs: config.timeoutMs,
    userAgent: config.userAgent,
    maxRetries: config.maxRetries,
    retryDelayMs: config.retryDelayMs,
    rateLimiter,
    logger,
    onRetry: ({ url, attempt, wait, reason }) =>
      logger.debug(`retry ${attempt} in ${wait}ms (${reason}): ${url}`),
  };

  logger.info(
    `Collecting ${origin} -> ${datasetFile} ` +
      `(concurrency=${config.concurrency}, delay=${config.delayMs}ms` +
      `${config.force ? ', force' : ''}${config.dryRun ? ', DRY RUN' : ''})`
  );

  const index = await fetchIndex(origin, { ...fetchOptions, indexPath: config.indexPath });
  logger.info(`Index: ${index.rows.length} row(s) from ${index.sources.length} request(s)`);

  const skipped = [];
  const selected = selectRows(index.rows, config, skipped);

  // Read what a previous run left, so unchanged documents survive this one.
  const existing = readDataset(datasetFile);
  if (existing.malformed) {
    logger.warn(`${existing.malformed} unreadable line(s) in ${DATASET_FILENAME} will be rebuilt`);
  }
  const { fetchList, reused } = planWork(selected, existing, config);

  logger.info(
    `${selected.length} document(s) in scope: ${fetchList.length} to fetch, ` +
      `${reused.length} unchanged` +
      `${skipped.length ? `, ${skipped.length} skipped` : ''}`
  );

  if (config.dryRun) {
    return finish({
      logger,
      startedAt,
      config,
      origin,
      index,
      selected,
      skipped,
      records: reused,
      planned: fetchList,
      fetched: [],
      failed: [],
      removed: droppedPaths(existing, selected),
      datasetFile,
      manifestFile,
      documentsDirectory,
      dryRun: true,
    });
  }

  const fetchedAt = new Date().toISOString();
  const failed = [];
  const fetched = [];
  let done = 0;

  await mapWithConcurrency(fetchList, config.concurrency, async (item) => {
    const result = await fetchDocument(origin, item.row.path, {
      ...fetchOptions,
      extension: config.extension,
    });
    done++;
    if (!result.ok || typeof result.text !== 'string') {
      failed.push({ path: item.row.path, url: result.url, error: result.error });
      logger.warn(`failed: ${item.row.path} -> ${result.error}`);
      return;
    }
    if (!result.text.trim()) {
      failed.push({ path: item.row.path, url: result.url, error: 'empty document' });
      logger.warn(`empty: ${item.row.path}`);
      return;
    }
    // What the site serves at <path>.md is the authoring document: the
    // author's prose wrapped in the block syntax the authoring tools use.
    // Across www.aem.live's 183 documents that scaffolding was 30.8% of every
    // line - tokens a retrieval corpus pays for and can never match on.
    // Title, description and URL are already fields of the record, so no front
    // matter is added here; it would only be embedded twice.
    const isMarkdown = config.extension === '.md';
    const text =
      isMarkdown && config.cleanBlocks !== false
        ? cleanEdsMarkdown(result.text, { frontMatter: false }).markdown
        : result.text;

    if (!text.trim()) {
      failed.push({ path: item.row.path, url: result.url, error: 'no content outside the blocks' });
      logger.warn(`empty after cleaning: ${item.row.path}`);
      return;
    }

    const record = buildRecord({
      row: item.row,
      origin,
      text,
      sourceUrl: result.url,
      fetchedAt,
      format: isMarkdown ? 'markdown' : 'html',
    });
    fetched.push(record);
    logger.debug(
      `[${done}/${fetchList.length}] ${item.reason} ${item.row.path} (${formatBytes(record.bytes)})`
    );
  });

  const records = [...reused, ...fetched];
  return finish({
    logger,
    startedAt,
    config,
    origin,
    index,
    selected,
    skipped,
    records,
    planned: [],
    fetched,
    failed,
    // A document that left the index is dropped from the corpus rather than
    // lingering: a retrieval index that still answers with unpublished pages is
    // worse than one missing them.
    removed: droppedPaths(existing, selected),
    datasetFile,
    manifestFile,
    documentsDirectory,
    dryRun: false,
  });
}

/** Paths present in the previous dataset but no longer selected by this run. */
function droppedPaths(existing, selected) {
  const live = new Set(selected.map((row) => row.path));
  return [...existing.keys()].filter((docPath) => !live.has(docPath));
}

/** `dataset-manifest.json` -> `dataset-manifest.dry-run.json`. */
function previewFile(manifestFile) {
  return manifestFile.replace(/(\.[^.]+)$/, '.dry-run$1');
}

/** How many documents fall in each top-level section. */
function countSections(items) {
  const counts = {};
  for (const item of items) {
    const section = item.section || sectionOf(item.path);
    counts[section] = (counts[section] || 0) + 1;
  }
  return counts;
}

function finish(context) {
  const {
    logger,
    startedAt,
    config,
    origin,
    index,
    selected,
    skipped,
    records,
    planned,
    fetched,
    failed,
    removed,
    datasetFile,
    manifestFile,
    documentsDirectory,
    dryRun,
  } = context;

  // On a dry run the sections come from what would be collected, not from the
  // handful of records already in hand.
  const bySection = countSections(dryRun ? selected : records);
  let totalBytes = 0;
  for (const record of records) totalBytes += record.bytes || 0;

  const skippedByReason = {};
  for (const entry of skipped) {
    skippedByReason[entry.reason] = (skippedByReason[entry.reason] || 0) + 1;
  }

  let written = null;
  let manifestPath = null;
  let documentFiles = null;
  if (dryRun) {
    // A dry run fetches no text, so there is no corpus to write - but it must
    // still leave something to read, the way `bin/archive.js --dry-run` leaves
    // crawl-report.dry-run.json. This is the plan: every document that would be
    // collected, what would happen to it, and every one that would be skipped
    // and why. The `.dry-run` name keeps it clear of a real run's manifest.
    manifestPath = writeManifest(previewFile(manifestFile), {
      site: origin,
      dryRun: true,
      previewedAt: new Date().toISOString(),
      wouldWrite: {
        dataset: datasetFile,
        documents: documentsDirectory,
      },
      index: { sources: index.sources, rows: index.rows.length },
      options: {
        extension: config.extension,
        includeNoIndex: config.includeNoIndex,
        include: config.includePatterns.map(String),
        exclude: config.excludePatterns.map(String),
      },
      totals: {
        wouldCollect: selected.length,
        wouldFetch: planned.length,
        wouldReuse: records.length,
        wouldRemove: removed.length,
        skipped: skipped.length,
      },
      bySection: countSections(selected),
      skippedByReason,
      wouldFetch: planned.map((item) => ({
        path: item.row.path,
        url: new URL(item.row.path, origin).toString(),
        title: item.row.title || null,
        lastModified: isoFromEpoch(item.row.lastModified),
        reason: item.reason,
      })),
      wouldReuse: records.map((record) => ({
        path: record.path,
        lastModified: record.lastModified,
      })),
      wouldRemove: removed,
      skippedDocuments: skipped,
    });
  }
  if (!dryRun) {
    written = writeDataset(datasetFile, records);
    if (documentsDirectory) {
      // Sweep first, then write. Two different paths can sanitize to the same
      // filename, and in that case the surviving document must be the one
      // written last - the other order would delete a document still in the
      // corpus.
      removeDocumentFiles(documentsDirectory, removed, config.extension);
      documentFiles = writeDocumentFiles(documentsDirectory, records, config.extension);
    }
    manifestPath = writeManifest(manifestFile, {
      site: origin,
      collectedAt: new Date().toISOString(),
      dataset: path.basename(datasetFile),
      documents: documentsDirectory ? path.basename(documentsDirectory) : null,
      index: { sources: index.sources, rows: index.rows.length },
      options: {
        extension: config.extension,
        includeNoIndex: config.includeNoIndex,
        include: config.includePatterns.map(String),
        exclude: config.excludePatterns.map(String),
      },
      totals: {
        documents: records.length,
        fetched: fetched.length,
        reused: records.length - fetched.length,
        failed: failed.length,
        removed: removed.length,
        skipped: skipped.length,
        bytes: totalBytes,
      },
      bySection,
      skippedByReason,
      // Enough to re-plan the next run without re-reading dataset.jsonl.
      documents: records
        .map((record) => ({
          path: record.path,
          lastModified: record.lastModified,
          sha256: record.sha256,
          bytes: record.bytes,
          fetchedAt: record.fetchedAt,
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      failures: failed,
      removedPaths: removed,
    });
  }

  const duration = Date.now() - startedAt;
  const lines = [
    '',
    `Dataset ${dryRun ? 'preview' : 'written'}: ${origin}`,
    `  Duration:          ${formatDuration(duration)}`,
    `  Index rows:        ${index.rows.length}`,
  ];
  if (dryRun) {
    // Report the plan, not the empty result. Counting the documents a dry run
    // holds in memory would print "Documents: 0" for a run that is about to
    // collect two hundred, which reads as "nothing found".
    lines.push(
      `  Would collect:     ${selected.length}`,
      `  Would fetch:       ${planned.length}`,
      `  Already have:      ${records.length}`
    );
  } else {
    lines.push(
      `  In scope:          ${selected.length}`,
      `  Documents:         ${records.length}` +
        `${totalBytes ? ` (${formatBytes(totalBytes)} of text)` : ''}`,
      `  Fetched now:       ${fetched.length}`,
      `  Reused unchanged:  ${records.length - fetched.length}`
    );
  }
  if (removed.length) {
    lines.push(
      `  ${dryRun ? 'Would drop:       ' : 'Dropped:          '} ${removed.length} no longer in the index`
    );
  }
  if (failed.length) lines.push(`  Failed:            ${failed.length}`);
  if (skipped.length) {
    const detail = Object.entries(skippedByReason)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason}: ${count}`)
      .join(', ');
    lines.push(`  Skipped:           ${skipped.length} (${detail})`);
  }
  const sections = Object.entries(bySection).sort((a, b) => b[1] - a[1]);
  if (sections.length) {
    lines.push('  By section:');
    for (const [section, count] of sections.slice(0, 12)) {
      lines.push(`    ${section.padEnd(18)} ${count}`);
    }
    if (sections.length > 12) lines.push(`    ... ${sections.length - 12} more`);
  }
  if (failed.length) {
    lines.push('  Failures:');
    for (const failure of failed.slice(0, 10)) {
      lines.push(`    - ${failure.path} -> ${failure.error}`);
    }
    if (failed.length > 10) lines.push(`    ... ${failed.length - 10} more`);
  }
  if (dryRun) {
    lines.push(
      '  Dry run - no documents were fetched and no corpus was written.',
      `  Preview:           ${manifestPath}`,
      `  Would write:       ${datasetFile}` +
        `${documentsDirectory ? ` and ${documentsDirectory}` : ''}`,
      '  Run the same command without --dry-run to collect it.'
    );
  } else {
    lines.push(`  Dataset:           ${written.file}`);
    if (documentFiles) {
      lines.push(`  Files:             ${documentFiles.files.length} in ${documentFiles.directory}`);
    }
    lines.push(`  Manifest:          ${manifestPath}`);
  }
  lines.push('');
  process.stdout.write(lines.join('\n'));
  logger.debug(`total wall time: ${formatDuration(duration)}`);

  return {
    site: origin,
    documents: records.length,
    fetched: fetched.length,
    reused: records.length - fetched.length,
    failed: failed.length,
    removed: removed.length,
    skipped: skipped.length,
    bytes: totalBytes,
    bySection,
    datasetFile: dryRun ? null : written.file,
    previewFile: dryRun ? manifestPath : null,
    documentsDirectory: documentFiles ? documentFiles.directory : null,
    documentFiles: documentFiles ? documentFiles.files.length : 0,
    manifestFile: manifestPath,
    dryRun,
  };
}

module.exports = { collect, isNoIndex, selectRows, planWork, droppedPaths };
