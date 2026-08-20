'use strict';

const { urlExtension, groupForExtension, isSameDomain } = require('./utils/url');

/**
 * What file types the crawled site actually holds.
 *
 * Distinct from `options.assetExtensions` in the report, which only echoes the
 * types the run was *configured* to accept. That answers "what would we have
 * taken?"; this answers "what is there?" - and the gap between the two is the
 * useful part, because it names the types a crawl is walking past.
 *
 * Every asset-looking URL is counted here whether or not it was downloaded, so
 * the tally survives the three places a URL is otherwise dropped without trace:
 * a type outside `--assets`, a host outside the scope rule, and the depth or
 * page budget running out. Counting happens at discovery, before any of those
 * decisions are taken.
 *
 * Counts are of distinct URLs, not links: one PDF linked from forty pages is
 * one PDF. `pages` records how many pages pointed at each type, which is the
 * number that says whether a type is incidental or everywhere.
 */
class AssetInventory {
  constructor(startUrl) {
    this.startUrl = startUrl;
    // extension -> record, split by host so "what does this domain hold?" and
    // "what is it pulling from a CDN?" stay separate questions.
    this.internal = new Map();
    this.external = new Map();
    // url -> the extension it was counted under. A Map rather than a Set
    // because a URL like /download?id=42 has no extension in its path: its
    // type came from a response header, and re-parsing the URL later would
    // lose it. This is also what stops one link being counted twice.
    this._seen = new Map();
    // url -> its single outcome ('downloaded' | 'duplicate' | 'failed' |
    // 'skipped' | 'planned').
    //
    // An outcome is a property of a URL, not an event, and the callers cannot
    // guarantee they report each one once: AssetDownloader.enqueue() returns
    // false both for "wrong type" and for "already queued", so a PDF linked
    // from five pages would otherwise be marked skipped four extra times and
    // the outcome columns would exceed the URL count.
    this._outcome = new Map();
  }

  /**
   * Give a URL its one outcome, replacing any earlier one.
   *
   * Idempotent, and it moves the count when an outcome changes - a URL first
   * seen as skipped and later downloaded ends up counted only as downloaded.
   */
  _setOutcome(url, kind, bytes = 0) {
    const record = this._find(url);
    if (!record) return null;

    const previous = this._outcome.get(url);
    if (previous === kind) return record;
    if (previous) record[previous]--;

    this._outcome.set(url, kind);
    record[kind]++;
    // Only a stored copy contributes bytes; a duplicate shares another's file.
    if (kind === 'downloaded') record.bytes += bytes || 0;
    return record;
  }

  static _blank(extension) {
    return {
      extension,
      group: groupForExtension(extension),
      urls: 0,
      downloaded: 0,
      duplicate: 0,
      failed: 0,
      skipped: 0,
      // Dry runs only: types this run would have taken. Without it a dry run
      // leaves the outcome columns blank and they no longer add up to `urls`.
      planned: 0,
      bytes: 0,
      pages: new Set(), // pages of THIS run that linked this type
      // Pages counted by an earlier run of a resumed crawl. Kept apart from
      // the Set because those identities are not carried across; a resume
      // never revisits a page, so the two are disjoint and simply add.
      priorPages: 0,
      hosts: new Set(), // only meaningful for external assets
      // A few real examples, so a reader can eyeball what a type actually is
      // without opening the full URL list.
      samples: [],
    };
  }

  /**
   * Count one asset-looking URL. Returns the record, or null when the URL
   * carries no recognisable file extension - those are candidate pages, not
   * assets, and guessing otherwise would fill the inventory with noise.
   *
   * Safe to call repeatedly for the same URL: only the first call counts it.
   */
  record(url, sourceUrl, { extension } = {}) {
    const ext = (extension || urlExtension(url)).toLowerCase();
    if (!ext || !groupForExtension(ext)) return null;

    const internal = isSameDomain(url, this.startUrl);
    const table = internal ? this.internal : this.external;
    let record = table.get(ext);
    if (!record) {
      record = AssetInventory._blank(ext);
      table.set(ext, record);
    }

    if (sourceUrl) record.pages.add(sourceUrl);
    if (!internal) {
      try {
        record.hosts.add(new URL(url).hostname);
      } catch {
        /* an unparseable URL still counts, it just has no host */
      }
    }

    if (this._seen.has(url)) return record;
    this._seen.set(url, ext);
    record.urls++;
    if (record.samples.length < 3) record.samples.push(url);
    return record;
  }

  /**
   * Find the record holding a URL that was already counted.
   *
   * Looks the extension up rather than re-deriving it, so a file whose type
   * came from a Content-Type header is still found.
   */
  _find(url) {
    const ext = this._seen.get(url) || urlExtension(url).toLowerCase();
    if (!ext) return null;
    const table = isSameDomain(url, this.startUrl) ? this.internal : this.external;
    return table.get(ext) || null;
  }

  /** Mark a counted URL as taken. A deduplicated copy adds no bytes. */
  markDownloaded(url, bytes = 0, { duplicate = false } = {}) {
    this._setOutcome(url, duplicate ? 'duplicate' : 'downloaded', bytes);
  }

  markFailed(url) {
    this._setOutcome(url, 'failed');
  }

  /** Would have been downloaded, had this not been a dry run. */
  markPlanned(url) {
    this._setOutcome(url, 'planned');
  }

  /**
   * Counted, but never fetched - wrong type, out of scope, budget, robots.
   *
   * Never overrides a decided outcome: callers reach this on the "already
   * handled" path too, and a downloaded file must not be relabelled skipped.
   */
  markSkipped(url) {
    if (this._outcome.has(url)) return;
    this._setOutcome(url, 'skipped');
  }

  get typeCount() {
    return this.internal.size + this.external.size;
  }

  get urlCount() {
    return this._seen.size;
  }

  /** True when at least one asset URL was seen, whatever became of it. */
  get hasFindings() {
    return this._seen.size > 0;
  }

  /** One table's records as plain JSON, most numerous type first. */
  static _serialize(table) {
    return [...table.values()]
      .map((record) => ({
        extension: record.extension,
        group: record.group,
        urls: record.urls,
        downloaded: record.downloaded,
        duplicate: record.duplicate,
        failed: record.failed,
        skipped: record.skipped,
        planned: record.planned,
        bytes: record.bytes,
        linkedFromPages: record.pages.size + record.priorPages,
        hosts: [...record.hosts].sort(),
        samples: record.samples,
      }))
      .sort((a, b) => b.urls - a.urls || a.extension.localeCompare(b.extension));
  }

  /** The report's `assetInventory` block. */
  toJSON() {
    const internal = AssetInventory._serialize(this.internal);
    const external = AssetInventory._serialize(this.external);
    const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
    return {
      // What this counts, stated in the report itself - the distinction from
      // options.assetExtensions is otherwise easy to misread.
      description:
        'File types found while crawling, whether or not they were downloaded. ' +
        'options.assetExtensions lists the types this run was configured to accept.',
      totals: {
        types: internal.length + external.length,
        urls: sum(internal, 'urls') + sum(external, 'urls'),
        downloaded: sum(internal, 'downloaded') + sum(external, 'downloaded'),
        bytes: sum(internal, 'bytes') + sum(external, 'bytes'),
      },
      byHost: {
        internal: { host: hostOf(this.startUrl), types: internal },
        external: { types: external },
      },
    };
  }

  /**
   * Snapshot for the resume state.
   *
   * Carries the counted-URL set as well as the tallies. Without it a resumed
   * crawl would recount any URL it meets again - a PDF linked from both an
   * old page and a new one - and report more files than the site has.
   */
  toState() {
    // [url, extension] pairs, so a resumed crawl can still identify the type
    // of a URL whose extension never appeared in its path.
    return {
      tallies: this.toJSON(),
      seen: [...this._seen.entries()],
      outcomes: [...this._outcome.entries()],
    };
  }

  /** Restore from a resumed crawl, so the tally spans the whole crawl. */
  restore(state) {
    if (!state) return;
    const data = state.tallies || state;
    if (!data.byHost) return;

    const load = (table, rows) => {
      for (const row of rows || []) {
        const record = AssetInventory._blank(row.extension);
        Object.assign(record, {
          group: row.group,
          urls: row.urls || 0,
          downloaded: row.downloaded || 0,
          duplicate: row.duplicate || 0,
          failed: row.failed || 0,
          skipped: row.skipped || 0,
          planned: row.planned || 0,
          bytes: row.bytes || 0,
          priorPages: row.linkedFromPages || 0,
          samples: row.samples || [],
        });
        for (const host of row.hosts || []) record.hosts.add(host);
        table.set(row.extension, record);
      }
    };
    load(this.internal, data.byHost.internal && data.byHost.internal.types);
    load(this.external, data.byHost.external && data.byHost.external.types);
    for (const entry of state.seen || []) {
      // Tolerate the older plain-URL form as well as [url, extension].
      if (Array.isArray(entry)) this._seen.set(entry[0], entry[1]);
      else this._seen.set(entry, urlExtension(entry).toLowerCase());
    }
    for (const [url, kind] of state.outcomes || []) this._outcome.set(url, kind);
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

module.exports = { AssetInventory };
