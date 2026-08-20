# SingleFile Auto Archiver

A fork of [SingleFile-MV3](https://github.com/gildas-lormeau/SingleFile-MV3) that turns SingleFile into a hands-free web archiver:

- **Every page you visit is saved automatically** as a single `.html` file — no clicking the extension button.
- Pages are written straight into a **folder you choose** (via the File System Access API), not the Downloads history.
- If you navigate away **before a save finishes**, the URL is recorded in **`queue.txt`** inside that folder.
- Every **~10 seconds** the extension polls `queue.txt`, opens each pending URL in a background tab (so your logins/cookies apply), saves it, and removes the line.
- You can also **hand-type URLs into `queue.txt`** (one per line, a bare URL is fine) and they will be archived within seconds.

## Install (unpacked)

1. Nothing to install or build. `lib/` here is the prebuilt bundle and the
   extension's build tooling is deliberately not vendored — see
   "Rebuilding `lib/`" below before editing anything under `src/core/`.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select this folder.
3. The setup page opens automatically. Click **Choose archive folder…** and pick where saved pages + `queue.txt` should live. When Chrome asks for permission, pick **Allow on every visit** (Chrome 122+) so access survives restarts.

That's it — browse normally. To revisit the setup page later, open
`chrome-extension://<extension-id>/src/ui/pages/auto-archive.html`.

## queue.txt format

```
2026-08-11T13:37:00.000Z	https://example.com/page	0
https://a-url-you-typed-yourself.example
# lines starting with # are ignored
```

Fields are `timestamp  URL  attempt-count`, tab- or space-separated; only the URL is required. Entries written by the extension are retried once they are older than 30 seconds (so in-flight saves aren't duplicated and retries back off); hand-typed bare URLs are picked up by the next 10-second tick immediately. After 5 failed attempts an entry is moved to `queue-failed.txt`. At most 10 URLs are replayed per poll.

## How it works (changes vs. upstream)

| File | Change |
|---|---|
| `src/core/bg/archive-fs.js` | **New.** File System Access layer: persists the folder handle in IndexedDB, writes pages, reads/writes `queue.txt` / `queue-failed.txt`. Runs in the offscreen document and the setup page (service workers can't use `createWritable`). |
| `src/core/bg/auto-archive.js` | **New.** Queue manager in the service worker: enqueues on navigation, removes entries on successful save, queue poller (10 s ticker in the offscreen document + 30 s `chrome.alarms` backstop) replays pending URLs via `business.saveUrls()` in background tabs, suppresses duplicate auto-saves of replay tabs, enables auto-save for all tabs on install, opens the setup page on install or when folder permission is lost. |
| `src/core/bg/offscreen.js` / `offscreen-document.js` | Message plumbing between service worker and offscreen document for the four archive operations. |
| `src/core/bg/autosave.js` | Enqueues each navigated URL before saving; writes the finished page into the archive folder instead of Downloads when a folder is connected; marks queue entries saved. |
| `src/core/bg/downloads.js` | Same folder-write branch for the manual/queue-replay save pipeline. |
| `src/core/bg/business.js` | Fixed a missing `await` on `autoSaveIsEnabled()`. |
| `src/core/bg/config.js` | Defaults changed to save on page **load** (`autoSaveLoad: true`, `autoSaveLoadOrUnload: false`). |
| `src/ui/pages/auto-archive.html` + `src/ui/bg/ui-auto-archive.js` | **New.** Setup page: folder picker, permission re-grant, queue viewer, "run queue now". |
| `manifest.json` | Renamed, added `alarms` permission. |

If no folder is connected (or access is lost), saves fall back to the normal browser Downloads folder so nothing is dropped, and the setup page is opened once so you can reconnect.

## Caveats

- Chrome 122+ recommended: earlier versions cannot persist folder permission across browser restarts, so you'll re-grant access (one click on the setup page) after each restart.
- Queued URLs are re-fetched at poll time in a background tab — you get the page as it is *then*, not as it was when you rushed past it.
- Saving every page on every site generates a lot of files; use SingleFile's URL rules in the options page to exclude domains.
- All upstream SingleFile options (filename template, cloud destinations, etc.) still work; cloud destinations take precedence over the folder if you enable them.

## Rebuilding `lib/`

Chrome loads the archiving logic from the **bundles in `lib/`**, not from
`src/core/`. `manifest.json` points its content scripts and service worker at
`lib/single-file-bootstrap.bundle.js`, `lib/single-file-frames.bundle.js` and
`lib/single-file-extension-background.js`; only the UI pages under
`src/ui/pages/` and `src/core/devtools/` are read from source. So **editing
`src/core/bg/*.js` changes nothing until `lib/` is rebuilt.**

This vendored copy intentionally ships without that build tooling — no
`package.json`, no rollup config, no dependencies to install. To change
archiving behaviour, rebuild in a clone of the upstream fork and copy the
regenerated `lib/` back here:

```bash
git clone https://github.com/nayan-dey/singlefile-auto-archiver
cd singlefile-auto-archiver
npm install
npx rollup -c rollup.config.js
cat lib/chrome-browser-polyfill.js lib/single-file-frames.js \
    lib/single-file-extension-frames.js > lib/single-file-frames.bundle.js
cat lib/chrome-browser-polyfill.js lib/single-file-bootstrap.js \
    lib/single-file-extension-bootstrap.js lib/single-file-infobar.js \
    > lib/single-file-bootstrap.bundle.js
cp -r lib src manifest.json _locales /path/to/web-archiver/extension/
```

The two `cat` steps matter: rollup does not emit the `.bundle.js` files, they
are concatenations, and the manifest loads the concatenated ones.
