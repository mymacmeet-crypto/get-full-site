# SingleFile Auto Archiver

A fork of [SingleFile-MV3](https://github.com/gildas-lormeau/SingleFile-MV3) that turns SingleFile into a hands-free web archiver:

- **Every page you visit is saved automatically** as a single `.html` file — no clicking the extension button.
- **A Start/Stop button** in the toolbar popup switches that off and back on, with an `off` badge on the icon while it is stopped.
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

## Start / Stop

Click the extension icon. The popup opens with the switch at the top:

```
[ Stop ]  Running. Every page you visit is saved.
[ Start ] Stopped. Pages you visit are not being saved.
```

While stopped the toolbar icon carries a grey **off** badge, so a tab that has
quietly stopped being archived can't be mistaken for one that was saved. The
setting is kept in `chrome.storage.local`, so it survives a service worker
restart and a browser restart — stopped stays stopped until you press Start.

**Save now still works while stopped.** Clicking it is an explicit request, not
the automatic archiving that was switched off.

Stop does two things. It sets a `autoArchivePaused` flag, and it clears
`autoSaveLoad` / `autoSaveLoadOrUnload` on every profile except the disabled one.
The second is what the *currently shipped* `lib/` bundle actually obeys:
`autosave.onInit` re-reads the profile on every navigation and only enqueues and
captures a page when one of those two is set. Start puts each profile back
exactly as it was — the previous values are snapshotted under
`autoArchivePausedProfiles` rather than assumed, so a customised profile is not
overwritten with this fork's defaults.

> **One gap until `lib/` is rebuilt.** The flag is checked by
> `autoSaveIsEnabled()`, `onNavigation()` and `processQueue()` in `src/core/bg/`,
> but Chrome runs the bundles in `lib/`, which predate those checks. So with the
> bundle as shipped, Stop reliably prevents new pages from being queued or
> captured — but URLs *already* sitting in `session.txt` keep being replayed by
> the 10-second poller until the queue drains. Rebuilding `lib/` (below) closes
> that: `processQueue()` then returns immediately while stopped.

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
| `src/core/bg/archive-pause.js` | **New.** The Start/Stop flag and its storage keys, in one module because both the service worker and the UI pages read it and must agree on the key. |
| `src/core/bg/autosave-util.js` | `autoSaveIsEnabled()` returns false while stopped, checked before the URL-rule lookup and read fresh on every navigation. |
| `src/ui/bg/ui-archive-pause.js` | **New.** UI side of the switch: snapshots and restores each profile's auto-save triggers, and paints the `off` badge. |
| `src/ui/pages/archive-popup.html` + `src/ui/bg/ui-archive-popup.js` | The Start/Stop button and its status line. |
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

The Start/Stop switch is deliberately built so that the half which needs no
rebuild carries it: the button, the badge and the profile-flipping all live in
`src/ui/`, which Chrome *does* read from source. The service-worker checks in
`src/core/bg/` are the belt to that braces, and only bite once `lib/` is
regenerated — see the gap noted under [Start / Stop](#start--stop).

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
