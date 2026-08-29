# Web Archiver

A fork of [SingleFile-MV3](https://github.com/gildas-lormeau/SingleFile-MV3) that
turns SingleFile into a hands-free web archiver:

- **Every page you visit is saved automatically** — as a single `.html` file, as
  Markdown, or as both.
- Pages are written straight into a **folder you choose** (via the File System
  Access API), not the Downloads history.
- The toolbar popup carries the **Start/Stop switch**, the **Auto/Manual mode**,
  the **HTML/MD/Both format**, and a **list of every URL open in Chrome** with
  its archive status — tick any of them and press Download.
- Anything that does not finish is retried by a poller every ten seconds.

## Install (unpacked)

1. Nothing to install or build. `lib/` here is the prebuilt bundle; the build
   tooling is deliberately not vendored — see [Rebuilding `lib/`](#rebuilding-lib)
   before editing anything under `src/core/`.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load
   unpacked**, and select this folder.
3. Click the extension icon. It will be wearing a red **`!`** badge, because no
   archive folder is connected yet. Use **Choose folder…** in the popup, pick
   where saved pages should live, and when Chrome asks for permission pick
   **Allow on every visit** (Chrome 122+) so access survives restarts.

That's it — browse normally. The setup page is at
`chrome-extension://<extension-id>/src/ui/pages/auto-archive.html` and is also
reachable from the popup's footer.

> **The extension never opens a tab by itself.** An earlier version opened its
> setup page whenever the archive folder was not ready, throttled to once an
> hour through `chrome.storage.session`. That storage clears when the browser
> closes, so the throttle reset on every start and the page reopened *every
> single time Chrome launched*. The need is now reported as a `!` badge and a
> banner in the popup, and only a click opens anything.

## The popup

```
┌ Web Archiver ────────────────────────┐
│ [ Stop ]  Running.                    │
│ Mode    [ Auto ][ Manual ]            │
│ Format  [ HTML ][ MD ][ Both ]        │
│ Every page you visit is archived…     │
├───────────────────────────────────────┤
│ Open tabs (3)            Select all   │
│ ☑ GSMArena review        ✅ Downloaded│
│    gsmarena.com/phone_review          │
│ ☐ Docs — AEM             🕓 Queued    │
│    www.aem.live/docs/                 │
├───────────────────────────────────────┤
│ [ Download 1 selected ] [Save this…]  │
├───────────────────────────────────────┤
│ Setup & session log · Health          │
└───────────────────────────────────────┘
```

**Start / Stop** is the master switch. While stopped nothing is archived at all,
the queue poller included, and the toolbar icon carries a grey `off` badge. The
setting lives in `chrome.storage.local`, so stopped stays stopped across a
service worker restart and a browser restart.

**Auto / Manual** is the mode *within* running.

| | Auto | Manual |
|---|---|---|
| A page you visit | archived | not archived |
| A URL you tick and Download | archived | archived |
| Queue poller retrying a failed save | yes | yes |
| Badge | none | `man` |

Manual is not the same flag as Stop, deliberately. Stop switches the machinery
off; Manual leaves it running so a download you *asked* for is still retried,
and only stops pages capturing themselves as you browse.

Neither Stop nor Manual queues the pages you visit in the meantime — otherwise
switching back to Auto would archive the last hour of your browsing all at once.

**Format** decides what is written for each captured page: `HTML`, `MD`, or
`Both`. It applies to the archive folder; if you have enabled a cloud
destination in the options page, that still receives the HTML file as before.

**The tab list** shows one row per *distinct* URL open in Chrome, across every
window. The same page open in three tabs is one row — the archive is keyed by
URL, and offering it three times would offer three ways to write one file. Only
`http://` and `https://` pages appear. The status beside each row comes from
`session.txt`, so it reflects what is actually on disk.

**Save this page** archives the visible tab. It works while stopped and in
Manual mode: an explicit click is not the automatic archiving those switch off.

**Download** captures each ticked URL through its own tab where it can, because
that tab already holds the page as you see it — scrolled, logged in, with its
scripts having run. It asks first (`content.ping`) and reopens the URL in a
background tab when nothing answers. That matters more than it sounds: reloading
the extension orphans the content script in every tab that was already open, and
a save sent to one of those fails with a connection error that the task runner
deliberately ignores — so before the probe, a batch download of pre-existing tabs
queued everything and then did nothing at all.

`session.txt` is read-modify-written through a single promise chain. The file
layer serialises individual operations, which is not the same guarantee: four
tabs saving at once interleaved as read-read-write-write, and the second writer
saved a copy loaded before the first one's update. `INPROGRESS` and `DOWNLOADED`
were overwritten back to `QUEUE`, which is exactly what a batch download looked
like from the popup.

## What gets written

```
<the folder you chose>/
  session_2026-08-29_14-30-22/
      session.txt   ← url <TAB> STATUS <TAB> time <TAB> attempts
      debug.log     ← timestamped trace of what the extension did
      pages/        ← the saved HTML
          gsmarena.com_phone_review.html
      markdown/     ← the same pages as Markdown, when the format asks for it
          gsmarena.com_phone_review.md
```

One folder per **browser session**: the name is kept in `chrome.storage.session`,
which clears when Chrome closes. Starting a new session carries over every entry
of the previous one that was neither `DOWNLOADED` nor `FAILED`.

Filenames come from the URL — hostname, path, query and `#fragment`, with
separators and unsafe characters folded to `_`, capped at 120 characters. A
collision gets `_2`, `_3`. In a `Both` save the Markdown takes the HTML's
*resolved* name, so `page_2.html` is paired with `page_2.md` rather than an
unrelated `page.md`.

`STATUS` is one of `QUEUE`, `INPROGRESS`, `DOWNLOADED`, `FAILED`. You can also
type bare URLs into `session.txt` yourself, one per line; lines starting with `#`
are ignored.

## Markdown

Markdown is not a second capture. It is converted from the DOM the content
script already sent, *before* SingleFile inlines the assets — at that point
links and images still carry real URLs rather than megabytes of base64.

Two sources, in this order:

1. **The site's own Markdown.** Edge Delivery Services sites (aem.live and
   everything built on it) serve `<path>.md` beside every page: the authored
   source, without the nav or the footer. When a site offers that, it wins.
   It is asked **once per host** — the first page of a host probes, and a miss
   switches every later page on that host to conversion. Verdicts are kept in
   `chrome.storage.session`. A URL with a query string never asks, because
   `/search?q=x` and `/search?q=y` would both request `/search.md`.
2. **Conversion of the rendered DOM.** Everything else: site chrome stripped,
   content root extracted, GFM tables, relative URLs made absolute.

Both paths are ports of the crawler's `src/markdown.js`, `src/native-md.js` and
`src/eds-markdown.js` — same selectors, same thresholds, same Turndown
configuration, so the extension and the CLI produce the same corpus.
`src/eds-markdown.js` is pure string processing and was copied verbatim;
`src/markdown.js` had every cheerio call replaced by the DOM method it was
imitating, and its output is byte-identical on the same input.

**An `MD`-only save skips the capture entirely.** There is no HTML file to
write, so inlining every image, font and stylesheet would produce a blob nothing
then uses. On a media-heavy page that is most of the time a save takes. If the
conversion yields nothing, the capture runs after all and the HTML is written
rather than losing the page.

## The retry poller

| Trigger | Where | Period |
|---|---|---|
| Primary | `setInterval` in the offscreen document | 10 s |
| Backstop | `chrome.alarms` | 30 s — also revives a dead offscreen document |

Each run: drains URLs parked while the folder was unavailable, deduplicates,
then replays every `QUEUE` entry older than 10 s and every `INPROGRESS` entry
older than 5 minutes. At most 10 URLs per poll, at most 5 attempts before an
entry becomes `FAILED`. A replayed URL is opened in a background tab so your
logins and cookies apply, and `isReplaying` stops that tab's own page load from
starting a second, duplicate save.

The poller returns immediately while stopped. Manual mode does **not** stop it —
see the table above.

## How it works (changes vs. upstream)

| File | Change |
|---|---|
| `src/core/bg/archive-fs.js` | **New.** File System Access layer: persists the folder handle in IndexedDB, creates session folders, writes pages and Markdown, reads/writes `session.txt` and `debug.log`. Runs in the offscreen document and the setup page — service workers have no `createWritable`. |
| `src/core/bg/auto-archive.js` | **New.** Session and queue manager in the service worker: enqueues on navigation, tracks status, runs the poller, serves the popup's tab list and bulk download, opens nothing by itself. |
| `src/core/bg/archive-pause.js` | **New.** The Start/Stop flag, the only writer of it, and `heal()` — a one-off repair for installs disarmed by a retired profile-flipping implementation of Stop. |
| `src/core/bg/archive-settings.js` | **New.** The Auto/Manual mode and HTML/MD/Both format, cached in memory and invalidated by the storage change event. |
| `src/core/bg/archive-markdown.js` | **New.** DOM port of the crawler's `src/markdown.js`. |
| `src/core/bg/eds-markdown.js` | **New.** Verbatim port of the crawler's `src/eds-markdown.js`. |
| `src/core/bg/archive-native-md.js` | **New.** The per-host `<path>.md` probe. |
| `lib/vendor/turndown*.js` | **New.** Turndown's browser builds, loaded as `<script>` tags by `offscreen-document.html`; refreshed by `tools/vendor-turndown.js` in the parent repo. |
| `src/core/bg/offscreen.js` / `offscreen-document.js` | Message plumbing for the archive operations, plus the 10-second queue ticker and Markdown conversion. |
| `src/core/bg/autosave.js` | Enqueues each navigated URL before saving; writes into the archive folder in the chosen format instead of Downloads; per-tab status badges. |
| `src/core/bg/autosave-util.js` | `autoSaveIsEnabled()` returns false while stopped **and** in Manual mode. |
| `src/core/bg/business.js` | `explicitSave` bypasses `autoSaveIsEnabled()`, so a click still saves while stopped. Fixed a missing `await` on `autoSaveIsEnabled()`. |
| `src/core/bg/downloads.js` | The manual / queue-replay pipeline writes into the archive folder in the chosen format too. It is the *second* save pipeline and used to ignore the format entirely, so anything the poller retried came out as HTML. |
| `src/core/content/content-bootstrap.js` | Progressive snapshots for infinite-scroll pages, a minimal status dot, `content.ping`, and the `explicitSave` bypass — the content script gates `content.autosave` on its own cached `autoSaveEnabled`, so without it a click reached the tab and was silently dropped. |
| `src/ui/bg/ui-button.js` | Badges for stopped (`off`), manual (`man`) and no-folder (`!`). |
| `src/ui/pages/archive-popup.html` + `ui-archive-popup.js` | The popup described above. It holds no state and writes no profiles: every control is one message to the service worker, which echoes back what it stored. |
| `src/ui/pages/auto-archive.html` + `ui-auto-archive.js` | Setup page: folder picker, permission re-grant, session viewer, "run queue now". |
| `src/ui/pages/archive-health.html` + `ui-archive-health.js` | Throughput, failures, largest file, poller lag, offscreen heap. |
| `src/core/bg/index.js` | Injects a `refreshButtons` callback into `autoArchive.init()`, so flipping a switch repaints every tab's button without `core/bg` importing `ui/bg`. |
| `src/core/bg/config.js` | Defaults changed to a 2 s post-load settle and capture-on-load-or-unload. |
| `manifest.json`, `_locales/`, `src/ui/resources/icon_*.png` | Renamed to Web Archiver, `alarms` permission added, icons regenerated by `tools/make-extension-icons.js` in the parent repo. |

If no folder is connected (or access is lost), saves fall back to the normal
browser Downloads folder so nothing is dropped.

## Caveats

- Chrome 122+ recommended: earlier versions cannot persist folder permission
  across browser restarts, so you'll re-grant access after each restart.
- Queued URLs are re-fetched at poll time in a background tab — you get the page
  as it is *then*, not as it was when you rushed past it.
- Saving every page on every site generates a lot of files; use SingleFile's URL
  rules in the options page to exclude domains, or switch to Manual.
- All upstream SingleFile options (filename template, cloud destinations, etc.)
  still work; cloud destinations take precedence over the folder.

## Rebuilding `lib/`

Chrome loads the archiving logic from the **bundles in `lib/`**, not from
`src/core/`. `manifest.json` points its content scripts and service worker at
`lib/single-file-bootstrap.bundle.js`, `lib/single-file-frames.bundle.js` and
`lib/single-file-extension-background.js`; only the UI pages under
`src/ui/pages/`, their scripts in `src/ui/bg/`, and `src/core/devtools/` are read
from source. So **editing `src/core/bg/*.js` changes nothing until `lib/` is
rebuilt.**

This vendored copy intentionally ships without that build tooling — no
`package.json`, no rollup config, no dependencies to install. Rebuild in a clone
of the upstream fork and copy the regenerated `lib/` back:

```bash
git clone https://github.com/nayan-dey/singlefile-auto-archiver
cd singlefile-auto-archiver
npm install

# copy this directory's sources in first
cp -r /path/to/web-archiver/extension/src .
cp -r /path/to/web-archiver/extension/lib/vendor lib/
cp /path/to/web-archiver/extension/manifest.json .
cp -r /path/to/web-archiver/extension/_locales .

./build.sh
cp lib/*.js /path/to/web-archiver/extension/lib/
```

`build.sh` is `npx rollup -c rollup.config.js` followed by two `cat` steps.
Those matter: rollup does not emit the `.bundle.js` files, they are
concatenations, and the manifest loads the concatenated ones.

Three things worth knowing:

- **On Windows, `npx rollup` may not resolve.** Run the binary directly instead:
  `node node_modules/rollup/dist/bin/rollup -c rollup.config.js`, then the two
  `cat` lines from `build.sh` by hand.
- **`npm install` may not fetch rollup's native binary on Windows.** If
  `node_modules/@rollup/` holds only `rollup-linux-*`, rollup dies with
  `Cannot find module @rollup/rollup-win32-x64-msvc`. Install the one matching
  your installed rollup version (`npm i -D @rollup/rollup-win32-x64-msvc@<ver>`)
  rather than deleting the lockfile, which would bump every dependency.
- **`lib/vendor/` is not built by rollup.** It is copied, by
  `tools/vendor-turndown.js` in the parent repo, and the offscreen document loads
  it with `<script>` tags. Leave it alone unless Turndown itself is being
  updated.
