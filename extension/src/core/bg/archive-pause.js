/*
 * Auto Archiver — the pause switch behind the popup's Start/Stop button.
 *
 * One flag in chrome.storage.local, read by everything that can start a
 * capture. It lives in its own module because both sides of the extension need
 * it and they must agree on the key: the service worker (auto-archive.js,
 * autosave-util.js) and the UI pages (src/ui/bg/ui-archive-pause.js), which
 * Chrome loads from source rather than from the lib/ bundles.
 *
 * storage.local, not storage.session: stopping the archiver has to survive a
 * service worker restart and a browser restart, or "stopped" would silently
 * become "running" the next time Chrome woke the extension up.
 */

/* global chrome */

const PAUSED_KEY = "autoArchivePaused";
// Set while Stop is in effect: each profile's autoSaveLoad/autoSaveLoadOrUnload
// as they were when it was pressed, so Start puts back what the user had rather
// than this fork's defaults.
const SAVED_PROFILES_KEY = "autoArchivePausedProfiles";

export {
	PAUSED_KEY,
	SAVED_PROFILES_KEY,
	isPaused
};

async function isPaused() {
	try {
		const stored = await chrome.storage.local.get(PAUSED_KEY);
		return Boolean(stored[PAUSED_KEY]);
	} catch {
		// storage unavailable: fail open, archiving is the extension's job
		return false;
	}
}
