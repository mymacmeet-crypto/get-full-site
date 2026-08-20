# web-archiver

Give it one URL. It crawls that domain and saves the pages you asked for as
standalone HTML files — each page a single file with its CSS, images and fonts
inlined, so it opens offline with nothing missing. It scrolls each page before
saving it, so text that animates into view is in the file rather than left
invisible, and it downloads the documents a page links to, so the PDFs open
too.

It merges two halves that used to be separate projects: a crawler that decides
*which* pages to take, and a capture engine that produces the archive
([SingleFile](https://github.com/gildas-lormeau/single-file-cli), vendored under
`vendor/capture-engine`). It runs **in-process**, so one browser serves the
whole crawl instead of one browser per page.

## Output layout

One folder per input domain:

```
archive/
  example.com/
    report/
      crawl-report.json      every page, skip reason and failure
      sitemap.xml            every archived URL - pages and files - and the
                             local file that holds it
      archive-index.json     the same, as one flat array for scripts
      assets-inventory.json  what file types the site holds, downloaded or not
      assets.txt             downloaded file URLs, one per line
      assets-manifest.json   every downloaded file, its source pages and hash
      capture-errors.log     browser-side failures, when any
      sitemaps/              copies of the site's own sitemap.xml
      .crawl-state.json      resume state (removed on a clean finish)
    raw-html/
      index.html
      about.html
      domains-root.html
      domains-root-db.html
    assets/                  only when the crawl downloaded something
      docs-annual-report.pdf
      files-price-list.xlsx
```

`raw-html/` and `assets/` are **flat by design** — no subfolders, ever. A
page's path becomes part of its filename:

| URL | File |
|---|---|
| `https://example.com/` | `index.html` |
| `https://example.com/about` | `about.html` |
| `https://example.com/blog/post-1` | `blog-post-1.html` |
| `https://example.com/domains/root/db` | `domains-root-db.html` |
| `https://example.com/p?page=2` | `p_q_page-2.html` |

Flattening can make two different URLs want the same name (`/a/b` and `/a-b`).
Rather than let one silently overwrite the other, the second gets a short hash
of its URL appended. Nothing is ever lost to a name clash.

## Requirements

- **Node.js ≥ 22.4.0** — the capture engine needs the runtime's native `WebSocket`
- **Chrome, Chromium or Edge** installed. The engine drives a real browser over
  the DevTools Protocol, so a browser is required and cannot be vendored away.
  Set `BROWSER_EXECUTABLE_PATH` if auto-detection misses yours.

## Setup

```bash
git clone <this repo>
cd web-archiver
npm install        # this project's 4 dependencies
```

That is the whole setup. No submodules, no `npm run setup`, nothing fetched for
the browser engine — it is checked into this repository.

### What is vendored

```
vendor/
  capture-engine/    the page-capture engine, AGPL-3.0
  simple-cdp/        its Chrome DevTools Protocol driver, MIT
```

Both are plain source. Neither contains a `package.json` or a `node_modules`
directory, and neither is an npm dependency.

Dropping `package.json` has one consequence worth knowing. Both packages are
ESM, and they declared that through `"type": "module"` in the manifest we
removed. Without it Node resolves `.js` against the nearest package.json going
up — which is this project's, and it says `commonjs`. So every vendored `.js`
was renamed to `.mjs`, and the relative imports were rewritten to match; the
extension now carries the module type. The engine's one bare `simple-cdp`
import became a relative path to `../../simple-cdp/mod.mjs`, since a bare
specifier would need the `node_modules` lookup this layout no longer has.

Those changes are listed in full in `vendor/capture-engine/NOTICE`, as the AGPL
requires of a modified version. No other source line was altered.

## Usage

```bash
# 50 pages, following links up to 2 levels deep
node bin/archive.js https://example.com --max-pages 50 --depth 2

# only the seeds (start URL + sitemap URLs), nothing followed
node bin/archive.js https://example.com --depth 0

# see what would be taken, archive nothing
node bin/archive.js https://example.com --dry-run

# continue an interrupted or page-capped run
node bin/archive.js https://example.com --max-pages 200 --resume
```

### Interactive runner

The runner asks for the settings instead of making you remember flags. Use the
one that matches your shell — both ask the same questions and build the same
command:

```powershell
.\runner.ps1           # Windows / PowerShell   (or: npm run archive)
```

```bash
./runner.sh            # macOS, Linux, Git Bash (or: npm run archive:sh)
```

> **Windows:** run `.\runner.ps1`, not `.\runner.sh`. PowerShell cannot execute
> a `.sh` file — Windows hands it to whatever program is associated with `.sh`,
> which opens a second window and closes it the instant the script ends, so it
> looks like an instant crash. Double-clicking `runner.cmd` in Explorer works
> too and keeps the window open when the crawl finishes.

It checks the environment first (Node version, `npm install`, the vendored
engine — and offers to fix what is missing), then opens with two choices:

```
Start
──────────────────────────────────────────────
  1  Start with a new URL
  2  Resume a saved crawl        (2 saved)
```

**1** prompts for the URL, page budget, depth, output folder and whether this is
a dry run. Advanced options (filters, sitemap, workers, delay, timeout,
lazy-image wait, overwrite, robots) sit behind one **Configure advanced
options?** question, so the common path stays four questions long.

**2** scans the output folder for crawls the archiver saved — on an interrupt,
or on hitting `--max-pages` with URLs still pending — and lists them:

```
  1  https://example.com
     saved 2h ago - 47 archived, 128 pending
```

Pick one and it continues that crawl. Three things it handles for you:

- **The URL comes from the saved state, never retyped.** The archiver only
  resumes when the start URL matches exactly; one typed character off and it
  would quietly start over.
- **`--max-pages` counts the whole crawl, saved progress included**, so the old
  value would archive nothing. The prompt defaults to `already done + still
  pending` — the number that finishes the crawl.
- **The previous run's filters and tuning are carried over.** Losing an
  `--exclude` mid-crawl would send the resumed run into pages the original
  deliberately skipped. Answer yes to *Change filters or tuning?* and every
  prompt starts on the saved value.

Dry run is not offered when resuming: a dry run still consumes the page budget
and rewrites the saved state, which would corrupt the crawl you are continuing.

Before anything runs it prints the settings and the exact
`node bin/archive.js …` command they produce — copy that line to script the
same crawl later.

Already know the flags? Anything you pass goes straight to the CLI, no prompts:

```powershell
.\runner.ps1 https://example.com --max-pages 50 --depth 2
.\runner.ps1 --help
```

Colour is dropped automatically when the output is redirected or `NO_COLOR` is
set.

### Options

| Flag | Default | What it does |
|---|---|---|
| `-p, --max-pages <n>` | `100` | How many pages to archive |
| `-d, --depth <n>` | `3` | Link depth from the seeds (`0` = seeds only) |
| `--include <regex>` | — | Only crawl matching URLs (repeatable) |
| `--exclude <regex>` | — | Never crawl matching URLs (wins over `--include`) |
| `--all-domains` | off | Follow links off the start domain |
| `--sitemap <url>` / `--no-sitemap` | auto | Control sitemap.xml seeding |
| `-c, --concurrency <n>` | `2` | Parallel discovery fetches |
| `-w, --workers <n>` | `4` | Parallel browser tabs per archive batch |
| `--batch <n>` | `8` | Pages discovered before each archive batch |
| `--delay <ms>` | `500` | Minimum spacing between requests to the site |
| `-t, --timeout <ms>` | `30000` | Per-request and per-page timeout |
| `--deferred-images-idle <ms>` | `500` | Lazy-image wait per page (see below) |
| `--wait <ms>` | `600` | Settle time after load, before capture (see below) |
| `--overwrite` | off | Re-archive pages and files that already exist |
| `--resume` | off | Continue a saved crawl of the same start URL |
| `--respect-robots` | off | Honor robots.txt disallow rules |
| `-o, --output <dir>` | `./archive` | Base output directory |
| `-v, --verbose` / `-q, --quiet` | — | Logging level |

**Linked files** (see [Downloading linked files](#downloading-linked-files)):

| Flag | Default | What it does |
|---|---|---|
| `--assets <list>` | `documents` | Types to download: `documents`, `archives`, `media`, `code`, bare extensions, `all`, `none` |
| `--no-assets` | — | Download nothing but pages |
| `--survey` | — | Report what types a site holds and write nothing else (fast; see above) |
| `--asset-ext <ext>` | — | Add one extension (repeatable) |
| `--asset-domains <mode>` | `linked` | `same`, `linked` (also CDN-hosted files a page links directly) or `any` |
| `--max-assets <n>` | `1000` | Ceiling on files downloaded |
| `--max-asset-size <mb>` | `100` | Skip anything larger |
| `--asset-concurrency <n>` | `3` | Parallel downloads |
| `--no-rewrite-links` | — | Leave saved pages pointing at the live site |
| `--no-original-href` | — | Drop the `data-original-href` provenance attribute |

**Capture fidelity** (see [Text that animates in](#text-that-animates-in)):

| Flag | Default | What it does |
|---|---|---|
| `--no-reveal-animations` | — | Do not scroll pages before capturing them |
| `--reveal-scroll-ms <ms>` | `4000` | Scroll budget per page |
| `--remove-hidden` | off | Let the engine delete elements invisible at capture time |
| `--browser-script <file>` | — | Extra script injected before load (repeatable) |
| `--browser-stylesheet <file>` | — | Extra stylesheet injected after load (repeatable) |

Exit codes: `0` success, `2` nothing archived but failures occurred, `130`
interrupted (resumable), `1` startup error.

## How it works

The crawl runs in **waves** rather than page by page:

```
take a batch from the frontier
  -> discovery: plain HTTP GET per page (status, links, canonical, robots)
  -> archive:   the whole batch in ONE engine call, parallel tabs
  -> repeat
```

Two loads per page is deliberate. The cheap HTTP fetch is what yields the status
code, the canonical URL, the links and the non-HTML detection — the browser
capture reports none of that. The browser load is what produces a page that
works offline.

### Why in-process, measured

Archiving 4 Wikipedia pages, same machine and network:

| Approach | Total | Per page |
|---|---|---|
| CLI spawned per page, sequential | 36.1s | 9.0s |
| Shared browser via `--browser-server` | 30.5s | 7.6s |
| **In-process, batched, 4 tabs** | **10.1s** | **2.5s** |

The per-page process + Chrome launch costs ~1.4s, and pages cannot overlap when
each one owns its browser. Both problems disappear at once.

### Waiting for JavaScript-rendered pages

If a page builds its content with JavaScript after load, the capture can catch
the skeleton instead of the page. `--wait <ms>` pauses after the page settles
and before the capture runs:

```bash
node bin/archive.js https://example.com --wait 2500
```

It defaults to 600ms — the slack the reveal pass below needs after the page
settles — and to `0` when that pass is off. The cost is milder than it looks:
tabs run in parallel, so a wait is paid roughly once per batch rather than once
per page.

There are now three time knobs and they do different jobs:

| Flag | Waits for | When to raise it |
|---|---|---|
| `--delay <ms>` | Politeness between requests **to the site** | You are being rate-limited |
| `--deferred-images-idle <ms>` | Lazy-loaded **images** to settle | Image-heavy or infinite-scroll pages |
| `--wait <ms>` | Anything else the **page's JavaScript** renders | SPA-style sites, late-loading widgets |

If a page archives as an empty shell or a loading spinner, `--wait` is the one
you want.

### Text that animates in

A great many sites fade their text in as you scroll — AOS, WOW.js,
ScrollReveal, Elementor, GSAP, Framer Motion, or a few lines of
`IntersectionObserver`. Until that fires, the text sits at `opacity: 0`. A
headless capture never scrolls, so it never fires, and the text was lost two
different ways:

- the capture engine deletes elements that are invisible when the page is
  saved, so the text was **dropped from the file entirely**; or
- the text survived but its reveal class never arrived, so the saved page
  **opens with it still invisible**.

Every page is now scrolled top to bottom before it is captured. Three layers,
weakest assumption first:

1. **Scroll.** The site's own observers and scroll handlers fire and reveal the
   content themselves, exactly as they would for a reader. This is the honest
   fix and it needs no guesswork about the site.
2. **Finish animations.** Any CSS animation or transition still mid-flight is
   jumped to its end state, so nothing is captured half-transparent. (Infinite
   animations — spinners, marquees — cannot be finished and are left alone.)
3. **Force what is left.** Anything still invisible *while occupying layout
   space* is a reveal that never fired, and is made visible.

That third rule is what keeps the pass safe. Closed modals, collapsed
dropdowns and inactive tab panels are hidden with `display: none`, which
occupies no space — so they are never touched, and stay hidden in the archive
exactly as the site intended. The engine's element-deleting is also turned off
while the pass is on, since the pass is the better judge of what is genuinely
hidden; that costs some file size.

The scroll starts at `DOMContentLoaded`, so most of it overlaps the tail of
page load rather than adding to it. `--reveal-scroll-ms` caps it (default
4000ms) so an infinite-scroll feed cannot be chased forever.

Turn the whole thing off with `--no-reveal-animations`. The browser-side
sources are plain, readable files in `src/browser/` — `reveal.js` and
`reveal.css` — and `--browser-script` / `--browser-stylesheet` inject your own
alongside them.

Pages the pass changed carry `data-web-archiver-revealed="<n>"` on `<html>`,
so an archive says how much of it was forced rather than natural.

### Downloading linked files

A page's own images, CSS and fonts are inlined into the standalone HTML. A
**link** to a file is different: archiving the page does not fetch what is
behind the link, so a saved page's "Download the report (PDF)" used to lead
back to the live web — and to nothing at all once the site changed.

Files linked from crawled pages are now downloaded into `assets/`, and the
links in the saved pages are repointed at those local copies:

```html
<a href="../assets/docs-annual-report.pdf"
   data-original-href="https://example.com/docs/annual-report.pdf">Download</a>
```

The live URL is kept on `data-original-href`, so nothing about the original
page is lost. `--no-original-href` drops it; `--no-rewrite-links` leaves the
links pointing at the live site and just collects the files.

Defaults and behaviour:

- **`documents` only** — PDF, Word, Excel, PowerPoint, OpenDocument, CSV,
  ePub and friends. Add groups or single types with `--assets media` or
  `--asset-ext dwg`; take everything with `--assets all`.
- **Extension-less URLs are still caught.** `/download?id=42` gives nothing
  away until its response headers arrive; when they say `application/pdf`, the
  file is taken and saved with the right extension.
- **Embedded files too** — a PDF shown in an `<iframe>` or `<object>` viewer is
  downloaded even though nothing links to it.
- **Off-host files are taken when a crawled page links them directly**
  (`--asset-domains linked`), so a PDF on a CDN or an S3 bucket is not missed.
  `same` restricts to the crawled host; `any` removes the restriction.
- **The same file under two URLs is stored once.** Sites routinely link both an
  `http://` and an `https://` form of one path; both URLs still rewrite to a
  working local link, but only one copy is kept. On one real crawl that was 8
  files instead of 10, and 11.4 MB instead of 15.5 MB.
- **Files do not consume `--max-pages`.** They have their own `--max-assets`
  budget, and they ignore `--depth`: a PDF is the end of a path, not a step
  along one.
- **`--include` does not apply to them,** but `--exclude` does. A PDF linked
  from an included page is worth having even though its own URL sits elsewhere;
  `--exclude` means "never touch this".

### What the site holds, versus what you collected

Two different questions, answered in two different places — worth keeping apart:

| Report field | Answers |
|---|---|
| `options.assetExtensions` | **what this run was configured to accept.** A static echo of your `--assets` flag — with `--assets documents` it is always the same 25 extensions, on every site. |
| `assetInventory` | **what the crawl actually found.** Every file type seen while crawling, downloaded or not, with what became of each. |

The gap between them is the useful part: it names the types a crawl is walking
past. The console shows it too:

```
  Asset types found: 3 type(s), 122 URL(s)
    png      112   112 not in --assets
    pdf        9   6 downloaded, 2 duplicate URL, 1 failed
    on other hosts:
      pdf        2   2 downloaded  [github.com]
    not collected: png - add with --assets
```

Counts are of distinct URLs, not links — one PDF linked from forty pages is one
PDF, and `linkedFromPages` in the JSON records the forty. Assets on the crawled
host and on other hosts are counted separately, so a CDN-hosted corpus never
reads as the domain's own.

**Survey a site before committing to a download.** `--survey` fetches each page
once for its links, archives nothing, downloads nothing, and writes one file:

```bash
node bin/archive.js https://example.com --survey           # what is there?
node bin/archive.js https://example.com --assets pdf,zip   # now take it
```

A survey's cost is almost entirely the politeness delay — on a 57-page crawl the
normal 500ms default accounted for **96%** of the wall clock — so `--survey`
drops to `--delay 100` and `--concurrency 6`. Measured on
`ontheline.trincoll.edu`: **9.5s, against 29.7s for the same crawl under
`--dry-run`**, with identical findings. Pass `--delay` or `--concurrency`
yourself and your value wins, so a site that rate-limits can still be surveyed
gently.

It writes only `report/assets-inventory.json` — 209 lines rather than the 3,900
of a full report — which carries the tallies plus the crawl's shape, since "8
types" means one thing for a complete crawl and another for one stopped at its
page budget:

```json
{
  "startUrl": "https://ontheline.trincoll.edu",
  "crawl": { "pagesCrawled": 52, "maxDepth": 3, "complete": true, "mode": "survey" },
  "configuredToAccept": ["pdf", "docx", "..."],
  "totals": { "types": 8, "urls": 38 },
  "byHost": { "internal": { "types": [] }, "external": { "types": [] } }
}
```

### Where the downloaded URLs appear

Downloaded file URLs surface in four places, so whichever one you already
have open answers the question:

| Where | Shape | Good for |
|---|---|---|
| `report/sitemap.xml` | `<url><loc>` beside the pages, local file in a comment | "is this URL in the archive, and where?" |
| `report/archive-index.json` | one flat array of pages and files | scripting over the whole archive |
| `report/assets.txt` | bare URLs, one per line | `xargs curl`, `wget -i`, diffing two crawls |
| `report/assets-manifest.json` | full records — size, SHA-256, linking pages | auditing what was taken |
| `report/assets-inventory.json` | types found, downloaded or not, plus crawl context | deciding what to collect next |

The console summary also names the URLs it took, up to ten, then points at
`assets.txt` for the rest.

A file linked under several URLs gets an entry per URL, all naming the one
stored copy, so a lookup by any of them succeeds; the entry says which URL owns
the file. None of these are written for a dry run, which archives nothing for
them to point at — `crawl-report.json` still lists what would have been taken.

### The lazy-image default

The engine waits 1500ms per page for lazy-loaded images. Measured on one
Wikipedia article:

| Setting | Time | Output | Inlined images |
|---|---|---|---|
| `1500` (engine default) | 9.3s | 774,913 B | 24 |
| **`500` (this project's default)** | **6.7s** | 774,898 B | 24 |
| `0` (`--deferred-images-idle 0`) | 5.2s | 756,811 B | 24 |

500ms was ~28% faster with practically identical output. That holds for sites
that do not lean on lazy loading; **raise it for image-heavy or infinite-scroll
sites**, where a short wait will genuinely drop images.

By contrast, tuning *when the page is considered loaded* is not worth it —
`networkIdle`, `load` and `DOMContentLoaded` all landed within noise (9.2–9.6s)
with identical output. The time goes into the capture, not the waiting.

## Failure handling

The engine **exits 0 even when it fails** — an unreachable host or a 404 both
report success, and a 404 error page gets archived as if it were the real thing.
So a page counts as archived only when its file actually exists and is non-empty.
Browser-side failures are recovered from `singlefile-errors.log` and attached to
the right URL in the report, and a failed page returns its `--max-pages` slot so
the budget counts pages you actually got.

One bad page never stops a crawl: it is recorded and the wave moves on.

The same holds for linked files. A download that 404s, times out or exceeds
`--max-asset-size` is named in the report and the queue carries on; a partial
download is written to a temporary name and never appears under its real one,
so an interrupted run cannot leave a truncated file for `--resume` to mistake
for a complete one. A rewrite failure cannot fail a page either — the page is
already safely on disk by then, so only the link localisation is lost.

## Licensing

This project is **AGPL-3.0-or-later**, and that is a consequence of vendoring
rather than a preference. `vendor/capture-engine` is
[SingleFile](https://github.com/gildas-lormeau/single-file-cli) by Gildas
Lormeau, licensed AGPL-3.0. Including its source here rather than depending on
it means the AGPL covers the combined work, so the whole repository is AGPL.

Two things follow that are easy to miss:

- **The network clause.** If you run a modified version of this on a server that
  users reach over a network, those users are entitled to its source. The plain
  GPL does not do this; the AGPL does.
- **Renaming the directory changes nothing about authorship.** `capture-engine`
  is SingleFile. Its `LICENSE` and the AGPL headers in its sources are intact,
  and `vendor/capture-engine/NOTICE` records the version it came from and every
  modification made to it.

`vendor/simple-cdp` is **MIT** (© 2024 Gildas Lormeau) and imposes no copyleft
of its own; its `LICENSE.txt` is kept alongside it.

`NOTICE` at the repository root summarises all of this.

If you would rather this project were MIT, the way back is to stop shipping the
engine's source: put it behind a submodule or an npm dependency again, so its
code stays in its own project rather than this one.

## Tests

```bash
npm test
```

Unit tests cover URL normalization, scope rules, the crawl frontier, sitemap
parsing, link and embed extraction, the flat-filename scheme, asset
classification and queueing, the link rewriter, and every file the report
writes — including that the generated sitemap stays well-formed XML when a URL
contains an ampersand. They launch no browser and reach nothing outside the
machine — the few that exercise a real download run against a throwaway
`http.createServer` on a loopback port.
