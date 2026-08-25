# Command reference

Every command this project ships, in one place. The long-form explanation of
*why* each option exists lives in [README.md](README.md); this file is the cheat
sheet.

Requires **Node.js ≥ 22.4.0** and an installed Chrome/Chromium/Edge.

---

## Setup

```bash
npm install                 # 4 dependencies; the capture engine is vendored
cp .env.example .env        # optional - every value has a CLI flag too
```

Nothing is fetched for the browser engine: `vendor/capture-engine` is checked in.

---

## npm scripts

| Command | What it runs |
|---|---|
| `npm start -- <url> [flags]` | `node bin/archive.js` - the CLI |
| `npm run archive` | `runner.ps1` - the guided runner (PowerShell) |
| `npm run archive:sh` | `runner.sh` - the guided runner (bash) |
| `npm test` | `node --test "test/**/*.test.js"` |

`npm start` needs the `--` separator before any flag, or npm eats it.

---

## Archiving a site

```bash
node bin/archive.js <url> [flags]
```

```bash
# 50 pages, following links up to 2 levels deep
node bin/archive.js https://example.com --max-pages 50 --depth 2

# only the seeds (start URL + sitemap URLs), nothing followed
node bin/archive.js https://example.com --depth 0

# see what would be taken, archive nothing
node bin/archive.js https://example.com --dry-run

# find out what file types the site holds, and nothing else
node bin/archive.js https://example.com --survey

# continue an interrupted or page-capped run
node bin/archive.js https://example.com --max-pages 200 --resume

# one section of the site, PDFs and spreadsheets included
node bin/archive.js https://example.com --include "/docs/" --exclude "/docs/archive/" --assets documents

# built-in help
node bin/archive.js --help
node bin/archive.js --version
```

`--resume` only continues a crawl whose start URL matches **exactly**; one
character off and it quietly starts over. The guided runner takes the URL from
the saved state for you.

**Ctrl+C once** stops gracefully - the current wave finishes and resume state is
saved. **Ctrl+C twice** exits immediately without saving.

---

## The guided runner

Asks for the settings instead of making you remember flags. Both scripts ask the
same questions and build the same `node bin/archive.js …` command, which they
print before running it.

```powershell
.\runner.ps1                # Windows / PowerShell   (npm run archive)
```

```bash
./runner.sh                 # macOS, Linux, Git Bash (npm run archive:sh)
```

Double-clicking `runner.cmd` in Explorer works too, and keeps the window open
after the crawl finishes.

> **Windows:** use `.\runner.ps1`, never `.\runner.sh` - PowerShell cannot
> execute a `.sh` file, and the window Windows opens for it closes the instant
> the script ends, which looks like a crash.

Arguments passed through go straight to the CLI with no prompts:

```powershell
.\runner.ps1 https://example.com --max-pages 50 --depth 2
.\runner.ps1 --help
```

Colour is dropped automatically when output is redirected or `NO_COLOR` is set.

---

## Flags

### Scope and pacing

| Flag | Default | What it does |
|---|---|---|
| `-p, --max-pages <n>` | `100` | How many pages to archive |
| `-d, --depth <n>` | `3` | Link depth from the seeds (`0` = seeds only) |
| `--include <regex>` | — | Only crawl matching URLs (repeatable) |
| `--exclude <regex>` | — | Never crawl matching URLs (wins over `--include`) |
| `--all-domains` | off | Follow links off the start domain |
| `--sitemap <url>` | auto | Seed from this sitemap instead of auto-discovering one |
| `--no-sitemap` | — | Do not seed from sitemap.xml at all |
| `-c, --concurrency <n>` | `2` | Parallel discovery fetches |
| `-w, --workers <n>` | `4` | Parallel browser tabs per archive batch |
| `--batch <n>` | `8` | Pages discovered before each archive batch |
| `--delay <ms>` | `500` | Minimum spacing between requests to the site |
| `-t, --timeout <ms>` | `30000` | Per-request and per-page timeout |
| `--deferred-images-idle <ms>` | `500` | Lazy-image wait per page |
| `--wait <ms>` | `600` | Settle time after load, before capture |
| `--no-follow-redirects` | — | Do not follow HTTP redirects |
| `--respect-robots` | off | Honor robots.txt disallow rules |
| `--user-agent <ua>` | from `.env` | User-Agent for discovery requests and the browser |

### Run mode and output

| Flag | Default | What it does |
|---|---|---|
| `--dry-run` | off | Crawl and report, archive nothing |
| `--survey` | off | Fetch each page once for its links; write only `report/assets-inventory.survey.json` |
| `--resume` | off | Continue a saved crawl of the same start URL |
| `--overwrite` | off | Re-archive pages and files that already exist |
| `-o, --output <dir>` | `./archive` | Base output directory (overrides `OUTPUT_FOLDER`) |
| `--report <file>` | — | Write the JSON report to this exact path |
| `-v, --verbose` | — | Debug logging (conflicts with `--quiet`) |
| `-q, --quiet` | — | Warnings and errors only |

### Linked files

| Flag | Default | What it does |
|---|---|---|
| `--assets <list>` | `documents` | `documents`, `archives`, `media`, `code`, bare extensions, `all`, `none` |
| `--no-assets` | — | Download nothing but pages |
| `--asset-ext <ext>` | — | Add one extension (repeatable) |
| `--asset-domains <mode>` | `linked` | `same`, `linked` (also CDN files a page links directly), or `any` |
| `--max-assets <n>` | `1000` | Ceiling on files downloaded |
| `--max-asset-size <mb>` | `100` | Skip anything larger |
| `--asset-concurrency <n>` | `3` | Parallel downloads |
| `--no-rewrite-links` | — | Leave saved pages pointing at the live site |
| `--no-original-href` | — | Drop the `data-original-href` provenance attribute |

### Capture fidelity

| Flag | Default | What it does |
|---|---|---|
| `--no-reveal-animations` | — | Do not scroll pages before capturing them |
| `--reveal-scroll-ms <ms>` | `4000` | Scroll budget per page |
| `--remove-hidden` | off | Let the engine delete elements invisible at capture time |
| `--browser-script <file>` | — | Extra script injected before load (repeatable) |
| `--browser-stylesheet <file>` | — | Extra stylesheet injected after load (repeatable) |

---

## Collecting a text corpus

For sites built on Adobe Edge Delivery Services (aem.live and anything like it),
this skips the crawler and the browser entirely — the site's `query-index.json`
lists every published page, and each one is served as clean Markdown at
`<path>.md`.

```bash
node bin/dataset.js <url> [flags]        # or: npm run dataset -- <url>
```

```bash
# the whole site, into archive/<host>/dataset.jsonl
node bin/dataset.js https://www.aem.live

# see what would be collected, without collecting it
node bin/dataset.js https://www.aem.live --dry-run

# one section only
node bin/dataset.js https://www.aem.live --include "^/developer/"

# refresh: rerun the same command - unchanged documents are reused
node bin/dataset.js https://www.aem.live

# rebuild every document from scratch
node bin/dataset.js https://www.aem.live --force
```

Measured on www.aem.live: **181 documents, 1.8 MB, 19s** for a full collection;
a refresh with nothing changed takes **1.7s** and fetches no documents at all.
The same 68 pages through the archiver were 77 MB and ~4 minutes.

| Flag | Default | What it does |
|---|---|---|
| `--index <path>` | `/query-index.json` | Where the site's index lives |
| `--extension <ext>` | `.md` | Per-document extension (`.plain.html` for raw blocks) |
| `--include <regex>` | — | Only collect matching paths (repeatable) |
| `--exclude <regex>` | — | Never collect matching paths (wins over `--include`) |
| `--include-noindex` | off | Collect pages the index marks `noindex` too |
| `--force` | off | Re-fetch everything, ignoring `lastModified` |
| `-c, --concurrency <n>` | `6` | Parallel document fetches |
| `--delay <ms>` | `100` | Minimum spacing between requests |
| `-t, --timeout <ms>` | `30000` | Per-request timeout |
| `--dry-run` | off | Report the plan and write `dataset-manifest.dry-run.json`; fetch and collect nothing |
| `-o, --output <dir>` | `./archive` | Base output directory |
| `--dataset <file>` | — | Write the JSONL to this exact path |
| `--no-files` | — | Skip the per-document files, write only the JSONL and manifest |
| `--files-dir <dir>` | `<output>/<host>/markdown/` | Where the per-document files go |
| `-v, --verbose` / `-q, --quiet` | — | Logging level |

Writes two files under `<output>/<host>/`:

| File | Contents |
|---|---|
| `markdown/` | One `.md` file per document, in folders mirroring the site (`markdown/developer/aem-playground.md`) |
| `dataset.jsonl` | One JSON object per document, sorted by path |
| `dataset-manifest.json` | Totals, per-section counts, failures, and the per-document state the next refresh reads |
| `dataset-manifest.dry-run.json` | Written by `--dry-run` only: every document it would fetch, reuse, drop or skip. Never overwrites the real manifest. |

Each record: `id, url, path, section, title, description, lastModified,
publicationDate, source, format, bytes, sha256, fetchedAt, text` — plus
`indexFields` for any index column the schema does not name.

Exit codes: `0` success, `1` startup error, `2` nothing collected but documents
failed.

---

## Inspecting saved crawls

`tools/resumable.js` finds resumable crawls under an output folder and prints
them in formats a shell can read without a JSON parser. Both runners call it, so
you can too:

```bash
# one tab-separated line per crawl, newest first:
# index <TAB> url <TAB> age <TAB> archived <TAB> pending
node tools/resumable.js list ./archive

# key=value lines for one crawl (split on the FIRST "=")
node tools/resumable.js show ./archive 1

# the previous run's scope and tuning flags, one argument per line
node tools/resumable.js args ./archive 1
```

A crawl is resumable while `<output>/<host>/report/.crawl-state.json` exists.
The archiver writes that file on an interrupt, or when `--max-pages` is hit with
URLs still pending, and deletes it when a crawl finishes cleanly.

---

## Tests

```bash
npm test                                    # everything
node --test test/report.test.js             # one file
node --test --test-name-pattern "sitemap" "test/**/*.test.js"
```

The tests launch no browser and reach nothing outside the machine - the few that
exercise a real download bind a throwaway `http.createServer` on a loopback port.

CI (`.github/workflows/ci.yml`) runs `npm ci && npm test` on Ubuntu and Windows
against Node 22.x and 24.x, plus a syntax check on each runner script:

```bash
bash -n runner.sh                           # what CI checks for runner.sh
```

```powershell
# what CI checks for runner.ps1
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile("$PWD/runner.ps1", [ref]$null, [ref]$errors) | Out-Null
if ($errors) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }
```

---

## Browser extension

`extension/` is a prebuilt Chrome extension that saves pages as you browse them.
There is nothing to build or install:

```
chrome://extensions -> Developer mode -> Load unpacked -> select extension/
```

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Startup error (bad flag, unreachable start URL, bad config) |
| `2` | Nothing archived, but failures occurred |
| `130` | Interrupted - resume state saved, rerun with `--resume` |

---

## Environment variables

Set these in `.env`; `.env.example` carries the annotated list. Every one is
optional, and the matching CLI flag wins over it.

| Variable | Default | Notes |
|---|---|---|
| `OUTPUT_FOLDER` | `./archive` | Base directory holding archived sites |
| `USER_AGENT` | built-in | Discovery requests, robots.txt matching, the browser |
| `CAPTURE_ENGINE_DIR` | `vendor/capture-engine` | Only set if you moved it (`SINGLEFILE_DIR` still works) |
| `BROWSER_EXECUTABLE_PATH` | auto-detect | Chrome/Chromium/Edge binary |
| `WAIT_AFTER_LOAD_MS` | `600` | Settle time after load, before capture |
| `DEFERRED_IMAGES_MAX_IDLE_MS` | `500` | Lazy-image wait per page |
| `MAX_RETRIES` / `RETRY_DELAY_MS` | `3` / `1000` | Discovery and asset-download retries |
| `ASSET_TYPES` | `documents` | Comma-separated; same vocabulary as `--assets` |
| `ASSET_DOMAINS` | `linked` | `same`, `linked` or `any` |
| `MAX_ASSETS` / `MAX_ASSET_SIZE_MB` / `ASSET_CONCURRENCY` | `1000` / `100` / `3` | Asset pipeline ceilings |
| `REVEAL_ANIMATIONS` | `1` | `0` is the same as `--no-reveal-animations` |
| `REVEAL_SCROLL_MS` | `4000` | Scroll budget per page |
| `NO_COLOR` | — | Any value drops colour from the runners |
