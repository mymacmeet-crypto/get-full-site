/*
 * Web Archiver — the window background captures happen in.
 *
 * A URL that is not already open has to be loaded somewhere before it can be
 * captured, and it has to be loaded *in Chrome*: that is the whole reason this
 * exists alongside the CLI, which fetches anonymously and therefore cannot see
 * anything behind a login.
 *
 * Until now that tab was created in the user's own window with `active: false`.
 * It never stole focus, but it was plainly visible — a tab appearing in the
 * strip, loading a page, and vanishing again, once per URL. Archiving ten pages
 * meant watching ten tabs come and go over the work you were doing.
 *
 * So the tabs go into a window of their own instead: created minimized and
 * unfocused the first time one is needed, reused for everything after it, and
 * closed once it has been idle for a while. Chrome treats a tab in a minimized
 * window exactly as it treated an inactive one — `document.hidden`, throttled
 * timers, and a full page load — so nothing about the capture itself changes.
 * It is only no longer in the way.
 *
 * Every failure here falls back to the old behaviour rather than giving up on
 * the save: a visible tab is a much smaller problem than a page that was never
 * archived.
 */

/* global browser, chrome, setTimeout, clearTimeout */

// How long an emptied window is kept before being closed. A queue poll replays
// up to ten URLs and the popup's Download can ask for more; those arrive as
// separate tasks moments apart, and tearing the window down between two of them
// would only mean building it again immediately.
const IDLE_CLOSE_MS = 15 * 1000;

let windowId = null;
// One in-flight creation, so ten tasks starting together open one window rather
// than racing to open ten.
let creating = null;
let idleTimer = null;
// The capture tabs we put there — not the blank one the window was opened with,
// which exists only to hold the window open between batches.
const ownedTabs = new Set();

export {
	createHiddenTab,
	releaseTab,
	isHiddenTab,
	closeIfIdle
};

// The user closed our window, or Chrome did. Either way the id is stale and the
// next capture opens a fresh one.
if (chrome.windows && chrome.windows.onRemoved) {
	chrome.windows.onRemoved.addListener(closedWindowId => {
		if (closedWindowId == windowId) {
			windowId = null;
			ownedTabs.clear();
		}
	});
}

function isHiddenTab(tabId) {
	return ownedTabs.has(tabId);
}

/*
 * Open `url` where the user will not see it.
 *
 * Returns the created tab. Falls back to a plain inactive tab in the current
 * window — which is what this used to do always — when no hidden window can be
 * had, so a capture never fails for want of somewhere to put it.
 */
async function createHiddenTab(url) {
	cancelIdleClose();
	let targetWindowId = null;
	try {
		targetWindowId = await getWindow();
	} catch {
		// fall through to the visible tab below
	}
	if (targetWindowId === null) {
		return browser.tabs.create({ url, active: false });
	}
	try {
		const tab = await browser.tabs.create({ url, active: false, windowId: targetWindowId });
		ownedTabs.add(tab.id);
		return tab;
	} catch {
		// The window went away between getWindow() and here. Don't retry into
		// another one: the save matters more than where it happens, and a loop
		// that keeps failing to hide would delay every capture.
		windowId = null;
		ownedTabs.clear();
		return browser.tabs.create({ url, active: false });
	}
}

/*
 * This tab is finished with.
 *
 * The capture options carry `autoClose`, so the tab is already being removed by
 * the time this is called; all that is left is to stop counting it and start
 * the idle countdown if it was the last one.
 */
function releaseTab(tabId) {
	if (ownedTabs.delete(tabId) && !ownedTabs.size) {
		scheduleIdleClose();
	}
}

async function getWindow() {
	if (windowId !== null) {
		try {
			await chrome.windows.get(windowId);
			return windowId;
		} catch {
			// stale id: the window is gone and onRemoved never reached us
			windowId = null;
			ownedTabs.clear();
		}
	}
	if (!creating) {
		creating = openWindow().finally(() => {
			creating = null;
		});
	}
	return creating;
}

/*
 * A window the user does not see.
 *
 * It opens on `about:blank` rather than on the first URL, and that tab is never
 * removed: a window with no tabs does not exist, so the blank one is what lets
 * the window outlive one batch and be reused by the next. The whole window is
 * closed together once it has been idle.
 *
 * Chrome has historically disagreed with itself about `minimized` alongside
 * `focused: false`, so an unfocused ordinary window is the fallback. That one is
 * still visible, but it opens behind everything and takes no focus.
 */
async function openWindow() {
	let created;
	try {
		created = await chrome.windows.create({
			url: "about:blank",
			focused: false,
			state: "minimized"
		});
	} catch {
		created = await chrome.windows.create({ url: "about:blank", focused: false });
	}
	windowId = created.id;
	return windowId;
}

function scheduleIdleClose() {
	cancelIdleClose();
	idleTimer = setTimeout(closeIfIdle, IDLE_CLOSE_MS);
}

function cancelIdleClose() {
	if (idleTimer !== null) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}
}

/*
 * Close the window if nothing is using it.
 *
 * Also called directly when archiving is switched off, so pressing Stop does
 * not leave a window sitting in the taskbar for the rest of the session.
 */
async function closeIfIdle() {
	cancelIdleClose();
	if (ownedTabs.size || windowId === null) {
		return;
	}
	const closing = windowId;
	windowId = null;
	try {
		await chrome.windows.remove(closing);
	} catch {
		// already closed
	}
}
