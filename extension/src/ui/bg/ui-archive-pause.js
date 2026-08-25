/*
 * Auto Archiver — UI side of the Start/Stop switch.
 *
 * Stopping does two things, and the second one is the load-bearing half today:
 *
 *   1. Sets the shared pause flag (see core/bg/archive-pause.js). The service
 *      worker honours it — but only once lib/ has been rebuilt, since Chrome
 *      runs the bundles in lib/, not src/core/. See "Rebuilding lib/" in
 *      AUTO-ARCHIVER.md.
 *   2. Clears autoSaveLoad / autoSaveLoadOrUnload on every profile. This is
 *      what stops the *currently shipped* bundle: autosave.onInit re-reads the
 *      profile on every navigation and only enqueues and captures a page when
 *      one of those two is set, so unsetting them stops the next page cold with
 *      no rebuild needed.
 *
 * Start restores each profile exactly as it was when Stop was pressed, which is
 * why the previous values are snapshotted rather than assumed.
 */

/* global chrome */

import { PAUSED_KEY, SAVED_PROFILES_KEY, isPaused } from "./../../core/bg/archive-pause.js";

// This fork captures when a page is left rather than on load. Only used when
// Start finds no snapshot — e.g. the flag was set by a rebuilt service worker.
const RUNNING_DEFAULTS = { autoSaveLoad: false, autoSaveLoadOrUnload: true };
const STOPPED_SETTINGS = { autoSaveLoad: false, autoSaveLoadOrUnload: false };
// Sites deliberately mapped to this profile are already excluded from
// auto-saving; leave its settings alone in both directions.
const DISABLED_PROFILE_NAME = "__Disabled_Settings__";

export {
	isPaused,
	setPaused,
	refreshBadge
};

async function setPaused(paused) {
	if (paused) {
		await snapshotAndStopProfiles();
	} else {
		await restoreProfiles();
	}
	await chrome.storage.local.set({ [PAUSED_KEY]: paused });
	await refreshBadge(paused);
}

async function snapshotAndStopProfiles() {
	const profiles = await getProfiles();
	// Don't re-snapshot when Stop is pressed twice: the second pass would record
	// the stopped values and Start would then restore a stopped archiver.
	const { [SAVED_PROFILES_KEY]: existing } = await chrome.storage.local.get(SAVED_PROFILES_KEY);
	if (!existing) {
		const snapshot = {};
		for (const [profileName, profile] of Object.entries(profiles)) {
			snapshot[profileName] = {
				autoSaveLoad: Boolean(profile && profile.autoSaveLoad),
				autoSaveLoadOrUnload: Boolean(profile && profile.autoSaveLoadOrUnload)
			};
		}
		await chrome.storage.local.set({ [SAVED_PROFILES_KEY]: snapshot });
	}
	await updateProfiles(Object.keys(profiles), () => STOPPED_SETTINGS);
}

async function restoreProfiles() {
	const [profiles, stored] = await Promise.all([
		getProfiles(),
		chrome.storage.local.get(SAVED_PROFILES_KEY)
	]);
	const snapshot = stored[SAVED_PROFILES_KEY] || {};
	await updateProfiles(
		Object.keys(profiles),
		profileName => snapshot[profileName] || RUNNING_DEFAULTS
	);
	await chrome.storage.local.remove(SAVED_PROFILES_KEY);
}

async function updateProfiles(profileNames, settingsFor) {
	await Promise.all(profileNames
		.filter(profileName => profileName != DISABLED_PROFILE_NAME)
		.map(async profileName => {
			try {
				await chrome.runtime.sendMessage({
					method: "config.updateProfile",
					profileName,
					profile: { ...settingsFor(profileName) }
				});
			} catch {
				// a profile deleted between the read and the write: nothing to do
			}
		}));
}

async function getProfiles() {
	try {
		return (await chrome.runtime.sendMessage({ method: "config.getProfiles" })) || {};
	} catch {
		return {};
	}
}

// A badge the whole time archiving is off, so a tab that quietly stopped being
// saved is not mistaken for one that was saved. Per-tab save badges paint over
// it while a capture is in flight; this repaints on every popup open.
async function refreshBadge(paused) {
	const stopped = paused === undefined ? await isPaused() : paused;
	try {
		await chrome.action.setBadgeText({ text: stopped ? "off" : "" });
		if (stopped) {
			await chrome.action.setBadgeBackgroundColor({ color: "#5f6368" });
		}
		await chrome.action.setTitle({
			title: stopped ? "Auto Archiver — stopped" : "Auto Archiver"
		});
	} catch {
		// badge is cosmetic
	}
}
