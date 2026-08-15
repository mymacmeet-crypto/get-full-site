# web-archiver

Give it one URL. It crawls that domain and saves the pages you asked for as
standalone HTML files — each page a single file with its CSS, images and fonts
inlined, so it opens offline with nothing missing.

It merges two halves that used to be separate projects: a crawler that decides
*which* pages to take, and a capture engine that produces the archive
([SingleFile](https://github.com/gildas-lormeau/single-file-cli), vendored under
`vendor/capture-engine`). It runs **in-process**, so one browser serves the
whole crawl instead of one browser per page.

## Output layout

One folder per input domain, holding exactly two folders:

```
archive/
  example.com/
    report/
      crawl-report.json      every page, skip reason and failure
      sitemap.xml            archived URL -> which flat file holds it
      capture-errors.log     browser-side failures, when any
      sitemaps/              copies of the site's own sitemap.xml
      .crawl-state.json      resume state (removed on a clean finish)
    raw-html/
      index.html
      about.html
      domains-root.html
      domains-root-db.html
```

`raw-html/` is **flat by design** — no subfolders, ever. A page's path becomes
part of its filename:

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
| `--overwrite` | off | Re-archive pages whose file already exists |
| `--resume` | off | Continue a saved crawl of the same start URL |
| `--respect-robots` | off | Honor robots.txt disallow rules |
| `-o, --output <dir>` | `./archive` | Base output directory |
| `-v, --verbose` / `-q, --quiet` | — | Logging level |

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
parsing, link extraction and the flat-filename scheme. They make no network
calls and launch no browser.
