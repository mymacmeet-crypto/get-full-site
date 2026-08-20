# Repurposing web-archiver for LLM dataset extraction

A review of the current codebase against one goal: **a clean, reliable HTML dataset
extraction pipeline for LLM training** — not a general-purpose website archiver.

Nothing in this document has been implemented. Measurements come from live probes
against `ontheline.trincoll.edu` and the vendored capture engine.

---

## The headline finding

**1.1% of every byte the archiver currently stores is visible text.**

Three real pages measured 1,176 KB on disk and held 12.6 KB of content — about
4 KB per page.

| Component of stored bytes | Size | Share |
|---|---|---|
| base64 `data:` URIs (inlined fonts, images, CSS) | 1,004 KB | 85.4% |
| Other markup | ~159 KB | 13.5% |
| **Visible text** | **12.6 KB** | **1.1%** |
| Inline `<script>` | 0 KB | 0% (already blocked) |

Per page:

| File | Total | base64 | `<style>` | Text | Text % |
|---|---|---|---|---|---|
| `about-the-book.html` | 303,791 | 242,097 | 259,410 | 5,466 | 1.8% |
| `index-ea470d5e.html` | 453,377 | 393,187 | 259,392 | 3,771 | 0.8% |
| `index.html` | 447,491 | 393,187 | 256,578 | 3,673 | 0.8% |

(`data:` and `<style>` overlap — the base64 fonts and images live *inside* the
inlined stylesheet, which is why the two columns sum past the total.)

This is not a tuning problem, it is a purpose mismatch. SingleFile exists to
reproduce a page **visually**, so inlining every font, image and stylesheet is
the entire point of it. For a text corpus that is roughly 90× overhead which
whatever consumes the dataset has to strip again anyway.

---

## The fix is mostly configuration, and it was tested

Probed the vendored engine directly with options it already supports. Same page,
same browser render, same reveal pass — only resource handling changed:

| Capture configuration | Bytes | vs now | Text % | `<h1>` | Links | Image URLs |
|---|---|---|---|---|---|---|
| Current default — visual replica | 303,791 | — | 1.8% | kept | 69 | base64 |
| `blockStylesheets` + `blockFonts` | 42,677 | **7.1× smaller** | 8.0% | kept | 69 | base64 (21 KB) |
| … plus `blockImages` + `removedElementsSelector` | 8,109 | 37× smaller | 41.9% | **destroyed** | — | **lost** |

**Row 2 is free.** A 7× reduction with zero content loss — every heading, every
paragraph, all 69 links intact. Take it immediately.

### Row 3 is a trap, in two separate ways

1. **Selector stripping deleted the `<h1>`.** The engine's
   `removedElementsSelector` is blind, and this site puts its article title
   inside `<header>` — a tag that means site chrome on one page and article
   structure on the next. Blanket tag lists silently eat content.

2. **`blockImages` rewrites `src` to `data:,`** — the original URL is gone, so
   you lose the image reference and its `alt` provenance, not merely its bytes.

Both point the same way: **boilerplate removal belongs in your pipeline**, where
it can be content-aware, not in the capture engine's blunt options.

---

## What is already good enough — do not change

The crawling half of this codebase suits dataset work as-is. Most of the
"Crawling" requirements are already met.

| Component | Why it stays |
|---|---|
| `src/queue.js` | Tracks *pending*, *known* and *visited* as three separate sets, so a URL cannot be enqueued or processed twice. Redirect targets and canonical URLs are marked visited as aliases. This is the dedup logic most crawlers get wrong. |
| `normalizeUrl` (`src/utils/url.js`) | Already drops fragments, lowercases the host, strips default ports, collapses duplicate slashes, removes trailing slashes and **sorts query parameters**. Covers fragments, redirects and most duplicate-URL cases. One gap only — see below. |
| Canonical handling (`src/crawler.js`) | A page declaring an already-seen `<link rel="canonical">` is skipped as duplicate content; an unseen canonical is claimed so the same content is never taken twice. Exactly right for a dataset — lean on it harder. |
| `src/rateLimiter.js` | Spaces requests globally across all workers. Politeness and safe concurrency are handled. |
| `src/fetcher.js` | Honours `Retry-After` with exponential backoff and capped retries. |
| `src/state.js` | Atomic resume via temp-file + rename. Large-site crawling is already interruptible. |
| `src/sitemap.js` | Discovers and follows sitemap indexes, seeds highest-`<priority>` first. The "sitemap-based crawling" future item already exists. |
| `src/browser/reveal.js` | Still valuable. An article body that fades in on scroll is as invisible to an extractor as to a visual capture — without the scroll you record an empty page. Keep the script, drop the stylesheet. |
| Wave architecture + `mapWithConcurrency` | Concurrency is already bounded and safe. |

**Two patterns to reuse rather than reinvent:**

- `FlatNames` (`src/utils/paths.js`) — stable, collision-safe URL→filename
  mapping. Use it verbatim for dataset filenames.
- The content-hash dedup in `src/assets.js` — exactly the shape page-level dedup
  needs, including the synchronous claim that makes it safe under concurrency.

---

## Immediate changes — all small and surgical

| Change | Where | Size |
|---|---|---|
| **Stop inlining stylesheets and fonts.** Add `blockStylesheets: true`, `blockFonts: true`. Measured 7× smaller, no content loss. Highest value-to-effort change available. | `src/archiver.js` | ~5 lines |
| **Strip tracking parameters.** Parameters are sorted but never removed, so `?utm_source=`, `?fbclid=`, `?gclid=` each produce a *distinct* URL for identical content — the same page entering the dataset repeatedly. Drop a deny-list before the sort. | `src/utils/url.js` | ~10 lines |
| **Hash page content and dedup on it.** Only asset *bytes* are hashed today; pages are deduped by URL and canonical alone, so two URLs serving identical content with no canonical tag both land in the dataset. | `src/crawler.js` | ~15 lines |
| **Flip three engine defaults** (see below). | `src/archiver.js` | config |
| **Default assets off** (`--assets none` in dataset mode). The HTML is the product; downloading PDFs costs bandwidth and wall-clock you do not need. Keep the flag — a PDF corpus may matter later. | `src/config.js` | 1 line |

### The three engine defaults to flip

- `removeHiddenElements: true` — safe here **because** the reveal pass runs
  first, so genuine content is visible before anything is pruned, and what stays
  hidden is mega-menus and modals you do not want. (It is `false` today
  specifically to protect visual fidelity.)
- `compressHTML: false` — consistent, parseable markup instead of minified.
- `saveFavicon`, `insertMetaCSP`, `insertSingleFileComment` off — all noise in a
  training sample.

---

## What to remove or disable

All of this is machinery built for offline browsing. None of it helps a dataset,
and each piece costs bytes, time or noise.

| Item | Reason |
|---|---|
| **Link rewriting** — `src/rewrite.js` and `data-original-href` | A dataset traces provenance through its manifest, not by mutating markup. Rewritten hrefs actively *corrupt* a sample by replacing real URLs with local paths. Keep the module for archive mode; skip it in dataset mode. |
| **The reveal stylesheet** — `src/browser/reveal.css` | Exists so a page still *looks* right when reopened with scripts blocked. A dataset renders nothing, so injecting CSS only adds a `<style>` block to every sample. Keep `reveal.js`. |
| **The four archive outputs** — `sitemap.xml`, `archive-index.json`, `assets.txt`, `assets-manifest.json` | These answer "what does this archive hold?". A dataset wants one answer in one format: `dataset.jsonl`. Collapse them. |
| **`blockImages` and `removedElementsSelector`** | Tempting, measured, and both destructive — see the trap above. Strip residual base64 in post-processing instead, where you control what survives. |

---

## What to add

### 1. A content extractor — `src/content.js` · medium · core

The one genuinely new component. Readability-style main-content detection:

- Score candidate blocks by text density and link density, take the winning
  subtree.
- Keep the semantic tags that carry meaning: `h1`–`h6`, `p`, `ul`/`ol`/`li`,
  `table`, `pre`/`code`, `blockquote`, `a`, `img[alt]`.
- Drop everything presentational.
- Content-aware, so it does not repeat the `<h1>` mistake.

**Have it emit a normalized DOM, not a string.** That single decision is what
lets Markdown and plain-text serializers drop in later without a rewrite.

### 2. `dataset.jsonl` as the primary index · small

One JSON object per line:

```json
{
  "id": "sha256(url)[:16]",
  "url": "https://example.com/page",
  "canonical": "https://example.com/page",
  "title": "Page title",
  "lang": "en",
  "fetched_at": "2026-08-18T04:18:43Z",
  "content_sha256": "…",
  "html_bytes": 8109,
  "text_bytes": 3397,
  "text_ratio": 0.419,
  "html_path": "pages/page.html",
  "raw_path": "raw/page.html",
  "flags": []
}
```

JSONL streams in Python one line at a time without loading the corpus — that is
the "easy to process programmatically" requirement, met.

### 3. Language detection · small

`<html lang>` first, since most sites declare it honestly; fall back to a small
n-gram check on the extracted text. Records the metadata you asked for and lets
you filter or shard by language later.

### 4. A validation and stats pass · small

Extend `src/report.js` rather than starting over — it already records skips,
failures and shortfall reasons.

- **`problems.jsonl`** — empty and near-empty pages, text ratio below threshold,
  duplicate content, malformed HTML, failed extraction.
- **`stats.json`** — page count, total and average size, duplicate count,
  language breakdown, text-ratio distribution.

### 5. SPA fallback for link discovery · small–medium

Discovery is `fetch` + cheerio (`src/extractor.js`), so a client-rendered nav
yields **zero** links and the crawl stops at the seed. The engine already exposes
browser-rendered links as `pageData.links` (`capture-api.mjs:180`). When static
extraction returns implausibly few links or characters, fall back to the rendered
DOM.

**Promote this to phase 1 if your target sites are SPAs.**

### 6. A lean capture path · larger · architectural

The honest long-term answer. The engine's *purpose* is inlining resources; you
will always be fighting it.

`simple-cdp` is already vendored and you already drive the browser. A
purpose-built path returning `documentElement.outerHTML` after load and the
reveal pass gives you:

- the post-JS DOM,
- original URLs intact,
- no inlining at all,
- and no resource fetching, so it is considerably faster.

Roughly 150 lines. **Do it after the extractor proves out, not before** — by then
the extractor defines exactly what capture has to deliver.

### 7. Near-duplicate detection · defer

SimHash or MinHash over word shingles, to catch template-heavy pages that differ
by a sentence and which exact hashing misses. Real value for corpus quality — but
do not build it before `stats.json` shows your sites actually have the problem.

---

## Proposed output layout

One flat folder of pages, as requested. `raw/` is opt-in: keep both
representations while tuning the extractor, then turn it off once you trust it.

```
dataset/
  example.com/
    pages/                 cleaned semantic HTML — one flat file per page
      index.html
      about.html
      blog-post-1.html
    raw/                   pre-extraction capture, only with --keep-raw
      index.html
    dataset.jsonl          one JSON object per page — the primary index
    stats.json             corpus totals, averages, language breakdown
    problems.jsonl         validation findings, one per line
```

Filenames come from the existing `FlatNames` — readable and already
collision-safe. Keep the stable `id` in the manifest rather than in the filename,
so a rename never invalidates a training sample's provenance.

---

## Recommended implementation order

Ordered so each phase is independently useful and nothing later is blocked by an
earlier decision. **Phase 1 alone gets you a usable corpus.**

### Phase 1 — configuration only · half a day

- `blockStylesheets` + `blockFonts`; flip the three engine defaults
- Tracking-parameter stripping
- Assets off; rewriting and the archive outputs off
- Add a `--mode dataset|archive` switch so both use cases share one codebase

*Payoff: 7× smaller output, fewer duplicate URLs, no new components.*

### Phase 2 — extraction and the manifest · the real work

- `src/content.js` — main-content detection, semantic allow-list, normalized DOM out
- `pages/` output plus `dataset.jsonl`
- Content hashing and exact-duplicate rejection
- Language detection and the metadata fields

*Payoff: this is the point where it becomes a dataset pipeline.*

### Phase 3 — validation and visibility · small

- `problems.jsonl` and `stats.json`
- SPA link-discovery fallback (move to phase 1 if your targets are SPAs)

*Payoff: you can see corpus quality instead of guessing at it.*

### Phase 4 — performance · larger

The dedicated CDP capture path. Deliberately last: by now the extractor defines
exactly what the capture stage must deliver, so the new path is written against a
known contract rather than a guess.

*Payoff: faster crawls, original URLs preserved, no inlining to undo.*

### Phase 5 — extensions, once the corpus argues for them

Markdown and plain-text serializers over the normalized DOM; near-duplicate
detection; incremental updates via conditional requests; dataset versioning. The
phase-2 design carries all of these — build each when `stats.json` shows you need
it.

---

## One thing to resist

**Do not delete the archive-mode code as you go.** A `--mode` switch keeps both
behaviours in one codebase for roughly no cost, and the visual-replica path is
genuinely useful for spot-checking what the extractor threw away.
