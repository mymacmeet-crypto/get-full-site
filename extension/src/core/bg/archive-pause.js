/*
 * Web Archiver — the pause switch behind the popup's Start/Stop button.
 *
 * One flag in chrome.storage.local is the single source of truth, read by
 * everything that can start a capture: autosave-util.js (autoSaveIsEnabled),
 * auto-archive.js (onNavigation, processQueue) and ui-button.js (the badge).
 *
 * storage.local, not storage.session: stopping the archiver has to survive a
 * service worker restart and a browser restart, or "stopped" would silently
 * become "running" the next time Chrome woke the extension up.
 *
 * An earlier version of this switch worked by clearing autoSaveLoad /
 * autoSaveLoadOrUnload on every profile, because the shipped lib/ bundle did
 * not yet read the flag. That was load-bearing and fragile: a Start that
 * failed half way, or lost its snapshot, left every profile with both flags
 * false and no way back — archiving was off for good while the popup still
 * said "Running". heal() below repairs installs left in that state and then
 * gets out of the way; nothing writes to profiles for pause purposes any more.
 */

/* global chrome */

const PAUSED_KEY = "autoArchivePaused";
// Written only by the retired profile-flipping implementation of Stop. Its
// presence now means "this install was stopped by the old mechanism and its
// profiles still need putting back"; heal() consumes and clears it.
const LEGACY_SNAPSHOT_KEY = "autoArchivePausedProfiles";
// So the one-off repair of both-flags-false profiles cannot keep fighting a
// user who deliberately turns auto-save off in the options page.
const HEALED_KEY = "autoArchivePauseHealed";
// What a running archiver looks like: this fork captures when a page is left
// rather than on load. Matches DEFAULT_CONFIG in config.js.
const RUNNING_DEFAULTS = { autoSaveLoad: false, autoSaveLoadOrUnload: true };

// isPaused() is called on every navigation and every button refresh, so the
// flag is cached in memory and invalidated by the storage change event rather
// than re-read from storage each time. undefined means "not yet loaded".
let cachedPaused;

chrome.storage.onChanged.addListener((changes, area) => {
	if (area == "local" && changes[PAUSED_KEY]) {
		cachedPaused = Boolean(changes[PAUSED_KEY].newValue);
	}
});

export {
	PAUSED_KEY,
	LEGACY_SNAPSHOT_KEY,
	RUNNING_DEFAULTS,
	isPaused,
	setPaused,
	heal
};

async function isPaused() {
	if (cachedPaused !== undefined) {
		return cachedPaused;
	}
	try {
		const stored = await chrome.storage.local.get(PAUSED_KEY);
		cachedPaused = Boolean(stored[PAUSED_KEY]);
	} catch {
		// storage unavailable: fail open, archiving is the extension's job
		cachedPaused = false;
	}
	return cachedPaused;
}

async function setPaused(paused) {
	cachedPaused = Boolean(paused);
	await chrome.storage.local.set({ [PAUSED_KEY]: cachedPaused });
	return { paused: cachedPaused };
}

/*
 * Repairs an install whose profiles were left un-archivable by the retired
 * profile-flipping Stop, and is a no-op on a healthy one. Runs once per
 * install on service worker startup.
 *
 * Two cases, in order of confidence:
 *   1. A leftover snapshot exists — Stop definitely wrote these profiles.
 *      Put back exactly what it recorded, then drop the snapshot.
 *   2. No snapshot, but a profile has every auto-save trigger off. In this
 *      fork that profile can never archive anything, which is not a state the
 *      UI can produce on purpose, so arm it with the running defaults.
 *
 * Case 2 is applied at most once, guarded by HEALED_KEY, so switching
 * auto-save off deliberately in the options page stays switched off.
 */
async function heal(config) {
	const repaired = [];
	try {
		const stored = await chrome.storage.local.get([LEGACY_SNAPSHOT_KEY, HEALED_KEY]);
		const snapshot = stored[LEGACY_SNAPSHOT_KEY];
		const alreadyHealed = Boolean(stored[HEALED_KEY]);
		if (!snapshot && alreadyHealed) {
			return { repaired };
		}
		const profiles = await config.getProfiles();
		for (const [name, profile] of Object.entries(profiles)) {
			if (!profile || name == config.DISABLED_PROFILE_NAME) {
				continue;
			}
			const disarmed = !profile.autoSaveLoad && !profile.autoSaveUnload && !profile.autoSaveLoadOrUnload;
			// Decide the target first and compare second. Doing it the other way
			// round skips the repair in the one case that needs it most: pressing
			// Stop twice could snapshot the already-stopped values, and a profile
			// then "matches its snapshot" while being unable to archive anything.
			let restore = null;
			if (snapshot && snapshot[name]) {
				restore = snapshot[name];
			} else if (disarmed && !alreadyHealed) {
				restore = RUNNING_DEFAULTS;
			}
			// a target that would itself leave the profile unable to save is no
			// use as a repair; fall back to arming it, or leave it alone entirely
			// if the one-off repair has already been spent
			if (restore && !restore.autoSaveLoad && !restore.autoSaveLoadOrUnload) {
				restore = disarmed && !alreadyHealed ? RUNNING_DEFAULTS : null;
			}
			// nothing to do when the profile already reads that way
			if (restore &&
				Boolean(profile.autoSaveLoad) == Boolean(restore.autoSaveLoad) &&
				Boolean(profile.autoSaveLoadOrUnload) == Boolean(restore.autoSaveLoadOrUnload)) {
				restore = null;
			}
			if (restore) {
				await config.onMessage({
					method: "config.updateProfile",
					profileName: name,
					profile: { ...restore }
				});
				repaired.push(name);
			}
		}
		await chrome.storage.local.set({ [HEALED_KEY]: true });
		if (snapshot) {
			await chrome.storage.local.remove(LEGACY_SNAPSHOT_KEY);
		}
	} catch (error) {
		return { repaired, error: error.message };
	}
	return { repaired };
}
