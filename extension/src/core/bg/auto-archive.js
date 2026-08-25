/*
 * Auto Archiver — service worker side.
 *
 * Maintains one folder per browser session inside the user-chosen archive
 * folder (session_<date>_<time>/), holding:
 *   - session.txt: one line per visited URL — "url  STATUS  time  attempts"
 *     with STATUS ∈ QUEUE | INPROGRESS | DOWNLOADED | FAILED
 *   - pages/: the saved HTML files, named after the URL
 *     (gsmarena.com_phone_review.html)
 *   - debug.log: timestamped trace
 *
 * URLs stuck in QUEUE (or stale INPROGRESS) are replayed in background tabs by
 * a poller: a 10-second ticker in the offscreen document plus an alarm
 * backstop. Hand-typed bare-URL lines in session.txt are picked up as QUEUE.
 * Unfinished entries of the previous session are carried into the new one.
 */

/* global chrome, browser, URL */

import * as config from "./config.js";
import * as offscreen from "./offscreen.js";
import * as tabsData from "./tabs-data.js";
import { isPaused } from "./archive-pause.js";

const BUILD_ID = "2026-08-18.9";
const ALARM_NAME = "auto-archive-queue";
// primary polling happens every 10s via a setInterval in the offscreen
// document (chrome.alarms can't fire more often than every 30s); this alarm
// is only a backstop that also revives the offscreen document if it dies
const POLL_PERIOD_MINUTES = 0.5;
const MIN_ENTRY_AGE_MS = 10 * 1000;
const STALE_INPROGRESS_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_BATCH_SIZE = 10;
const STATE_CACHE_MS = 30 * 1000;
const REPLAY_TIMEOUT_MS = 2 * 60 * 1000;
const SETUP_PAGE_URL = "/src/ui/pages/auto-archive.html";
const SESSION_FILE = "session.txt";
const DEBUG_FILE = "debug.log";
const SESSION_KEY = "autoArchiveSession";
const STATUS_QUEUE = "QUEUE";
const STATUS_INPROGRESS = "INPROGRESS";
const STATUS_DOWNLOADED = "DOWNLOADED";
const STATUS_FAILED = "FAILED";
const STATUSES = new Set([STATUS_QUEUE, STATUS_INPROGRESS, STATUS_DOWNLOADED, STATUS_FAILED]);

let saveUrls, saveTabs, isSavingUrl;
let cachedState, cachedStateTime = 0;
let processingQueue = false, promptedForPermission = false;
let sessionName, sessionPromise;
const replayingUrls = new Map();

export {
	init,
	onMessage,
	isReady,
	isReplaying,
	getSession,
	filenameForUrl,
	onNavigation,
	markInProgress,
	markSaved,
	markFailedAttempt,
	processQueue,
	traceNavigation,
	recordSaveMetric,
	debugLog
};

// rolling workload metrics for the health page, kept in storage.session
async function recordSaveMetric({ durationMs, bytes, filename, ok }) {
	try {
		const { autoArchiveMetrics } = await chrome.storage.session.get("autoArchiveMetrics");
		const metrics = autoArchiveMetrics || { saves: 0, failures: 0, totalBytes: 0, durations: [], largest: null };
		if (ok) {
			metrics.saves++;
			if (bytes) {
				metrics.totalBytes += bytes;
				if (!metrics.largest || bytes > metrics.largest.bytes) {
					metrics.largest = { bytes, filename };
				}
			}
			if (durationMs != null) {
				metrics.durations = [...metrics.durations, durationMs].slice(-20);
			}
		} else {
			metrics.failures++;
		}
		await chrome.storage.session.set({ autoArchiveMetrics: metrics });
	} catch {
		// metrics are best-effort
	}
}

// business.js is injected by index.js to avoid a circular module dependency
function init(api) {
	saveUrls = api.saveUrls;
	saveTabs = api.saveTabs;
	isSavingUrl = api.isSavingUrl;
}

// appends a timestamped line to the session's debug.log; silently dropped
// until a session exists
function debugLog(...args) {
	if (!sessionName) {
		return;
	}
	const line = localIso(Date.now()) + " " +
		args.map(arg => typeof arg == "string" ? arg : JSON.stringify(arg)).join(" ") + "\n";
	offscreen.archiveAppendText(sessionName, DEBUG_FILE, line).catch(() => { });
}

// diagnostic trail: proves whether tabs.init messages reach the background
let lastNavigations = [];
function traceNavigation(url) {
	lastNavigations.push({ url, time: localIso(Date.now()) });
	lastNavigations = lastNavigations.slice(-5);
	chrome.storage.local.set({ autoArchiveLastNavigations: lastNavigations }).catch(() => { });
	debugLog("navigation seen:", url);
}

// true while the queue poller is saving this URL in a background tab, so that
// the tab's own page load does not trigger a second, duplicate auto-save
function isReplaying(url) {
	const startTime = replayingUrls.get(url);
	if (startTime && Date.now() - startTime < REPLAY_TIMEOUT_MS) {
		return true;
	}
	replayingUrls.delete(url);
	return false;
}

chrome.runtime.onInstalled.addListener(details => {
	if (details.reason == "install") {
		browser.tabs.create({ active: true, url: SETUP_PAGE_URL });
	}
	// reload/update is the one safe moment to apply a changed poll period —
	// clear first so create() cannot act as a countdown reset elsewhere
	chrome.alarms.clear(ALARM_NAME).then(() =>
		chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_PERIOD_MINUTES }));
});

chrome.alarms.onAlarm.addListener(alarm => {
	if (alarm.name == ALARM_NAME) {
		processQueue();
	}
});

// NOTE: never recreate an existing alarm here — create() resets the countdown,
// and since this top-level code runs on EVERY service worker wake-up, an alarm
// that keeps getting recreated never fires at all
chrome.alarms.get(ALARM_NAME).then(alarm => {
	if (!alarm) {
		chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_PERIOD_MINUTES });
	}
});

// arm auto-save related profile settings on every service worker startup and
// record failures for the setup page diagnostics
const armed = (async () => {
	try {
		const allTabsData = await tabsData.get();
		if (allTabsData.autoSaveAll === undefined) {
			allTabsData.autoSaveAll = true;
			await tabsData.set(allTabsData);
		}
		// migrate profiles created with older defaults: 2s post-load settle for
		// full captures, and capture-on-exit so pages left early are snapshotted
		// the moment the user navigates away instead of waiting for a replay
		const profiles = await config.getProfiles();
		for (const [name, profile] of Object.entries(profiles)) {
			const update = {};
			if (profile.autoSaveDelay == 0 || profile.autoSaveDelay == 1) {
				update.autoSaveDelay = 2;
			}
			if (profile.autoSaveLoad && !profile.autoSaveLoadOrUnload) {
				update.autoSaveLoad = false;
				update.autoSaveLoadOrUnload = true;
			}
			if (Object.keys(update).length) {
				await config.onMessage({ method: "config.updateProfile", profileName: name, profile: update });
			}
		}
		return { autoSaveAll: Boolean(allTabsData.autoSaveAll) };
	} catch (error) {
		return { error: error.message };
	}
})();

// spawn the offscreen document at startup: it hosts the 10-second queue
// ticker, so it must exist even before the first save happens
getState(true).catch(() => { /* not configured yet */ });

async function onMessage(message) {
	if (message.method.endsWith(".getState")) {
		return getState(true);
	}
	if (message.method.endsWith(".getDiagnostics")) {
		const [armResult, state, alarm, allTabsData] = await Promise.all([
			armed,
			getState(true).catch(error => ({ error: error.message })),
			chrome.alarms.get(ALARM_NAME),
			tabsData.get().catch(() => ({}))
		]);
		const { autoArchiveLastNavigations } = await chrome.storage.local.get("autoArchiveLastNavigations");
		return {
			build: BUILD_ID,
			armResult,
			paused: await isPaused(),
			autoSaveAll: Boolean(allTabsData.autoSaveAll),
			session: sessionName || (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY] || null,
			offscreenState: state,
			alarmScheduled: Boolean(alarm),
			nextAlarm: alarm ? localIso(alarm.scheduledTime) : null,
			replaying: [...replayingUrls.keys()],
			lastNavigationsSeen: autoArchiveLastNavigations || "NONE — pages are not announcing themselves to the background"
		};
	}
	if (message.method.endsWith(".getSession")) {
		return { session: await getSession() };
	}
	if (message.method.endsWith(".folderChanged")) {
		cachedState = null;
		promptedForPermission = false;
		sessionName = null;
		sessionPromise = null;
		await chrome.storage.session.remove(SESSION_KEY);
		return {};
	}
	if (message.method.endsWith(".processQueue")) {
		return processQueue();
	}
	if (message.method.endsWith(".getHealth")) {
		const [state, alarm, memory, sessionData] = await Promise.all([
			getState(true).catch(error => ({ error: error.message })),
			chrome.alarms.get(ALARM_NAME),
			offscreen.archiveGetMemory().catch(() => null),
			chrome.storage.session.get(["autoArchiveMetrics", "autoArchiveLastPoll", SESSION_KEY])
		]);
		const session = sessionData[SESSION_KEY] || null;
		const statusCounts = { QUEUE: 0, INPROGRESS: 0, DOWNLOADED: 0, FAILED: 0 };
		if (session && state.configured && state.permission == "granted") {
			try {
				for (const entry of await readSession(session)) {
					if (entry.url && statusCounts[entry.status] !== undefined) {
						statusCounts[entry.status]++;
					}
				}
			} catch {
				// session.txt unreadable right now
			}
		}
		return {
			build: BUILD_ID,
			session,
			paused: await isPaused(),
			folderState: state,
			alarmScheduled: Boolean(alarm),
			lastPollAgeMs: sessionData.autoArchiveLastPoll ? Date.now() - sessionData.autoArchiveLastPoll : null,
			metrics: sessionData.autoArchiveMetrics || { saves: 0, failures: 0, totalBytes: 0, durations: [], largest: null },
			statusCounts,
			offscreenMemory: memory
		};
	}
	if (message.method.endsWith(".saveNow")) {
		const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
		if (tab && saveTabs) {
			await onNavigationSafe(tab.url);
			saveTabs([tab], { autoSave: true });
		}
		return {};
	}
}

async function onNavigationSafe(url) {
	try {
		await onNavigation(url);
	} catch {
		// best effort
	}
}

async function getState(refresh) {
	if (refresh || !cachedState || Date.now() - cachedStateTime > STATE_CACHE_MS) {
		cachedState = await offscreen.archiveGetState();
		cachedStateTime = Date.now();
	}
	return cachedState;
}

async function isReady() {
	try {
		const state = await getState();
		if (state.configured && state.permission != "granted" && !promptedForPermission) {
			// re-granting access needs a user gesture, so surface the setup page —
			// at most once per hour, tracked in storage.session because this
			// module reloads every time the service worker restarts
			promptedForPermission = true;
			const { autoArchiveLastPrompt } = await chrome.storage.session.get("autoArchiveLastPrompt");
			if (!autoArchiveLastPrompt || Date.now() - autoArchiveLastPrompt > 60 * 60 * 1000) {
				await chrome.storage.session.set({ autoArchiveLastPrompt: Date.now() });
				browser.tabs.create({ active: true, url: SETUP_PAGE_URL });
			}
		}
		return Boolean(state.configured && state.permission == "granted");
	} catch {
		return false;
	}
}

// Returns the current session folder name, creating the session on first use.
// storage.session clears when the browser closes, so each browser session gets
// its own folder; unfinished entries of the previous session are carried over.
async function getSession() {
	if (sessionName) {
		return sessionName;
	}
	if (!sessionPromise) {
		sessionPromise = (async () => {
			try {
				const stored = await chrome.storage.session.get(SESSION_KEY);
				if (stored[SESSION_KEY]) {
					sessionName = stored[SESSION_KEY];
					return sessionName;
				}
				if (!(await isReady())) {
					return null;
				}
				const name = "session_" + localIso(Date.now()).replace("T", "_").replace(/:/g, "-");
				const { previousText } = await offscreen.archiveCreateSession(name);
				const carried = parseText(previousText)
					.filter(entry => entry.url && entry.status != STATUS_DOWNLOADED && entry.status != STATUS_FAILED)
					.map(entry => ({ ...entry, status: STATUS_QUEUE }));
				if (carried.length) {
					await offscreen.archiveWriteText(name, SESSION_FILE, carried.map(formatLine).join("\n") + "\n");
				}
				await chrome.storage.session.set({ [SESSION_KEY]: name });
				sessionName = name;
				debugLog("session started:", name, "— carried over", carried.length, "unfinished URL(s)");
				return name;
			} finally {
				if (!sessionName) {
					sessionPromise = null;
				}
			}
		})();
	}
	return sessionPromise;
}

function isArchivableUrl(url) {
	try {
		const protocol = new URL(url).protocol;
		return protocol == "http:" || protocol == "https:";
	} catch {
		return false;
	}
}

// telstra.com.au_aboutus_investors_financial-results_2024.html — built from
// the URL (including the #fragment). Hyphens and dots survive as-is; only
// separators (/ ? & =), percent-encodings (%20 …) and other unsafe characters
// become underscores.
function filenameForUrl(url) {
	try {
		const parsed = new URL(url);
		let name = parsed.hostname.replace(/^www\./, "") + parsed.pathname;
		if (parsed.search && parsed.search.length > 1) {
			name += "_" + parsed.search.substring(1);
		}
		if (parsed.hash && parsed.hash.length > 1) {
			name += "_" + parsed.hash.substring(1);
		}
		try {
			name = decodeURIComponent(name);
		} catch {
			// leave percent-encodings in place; they are replaced below anyway
		}
		name = name
			.replace(/\.html?$/i, "")
			.replace(/%[0-9a-fA-F]{2}/g, "_")
			.replace(/[^a-zA-Z0-9.-]+/g, "_")
			.replace(/_{2,}/g, "_")
			.replace(/^[_.-]+|[_.]+$/g, "");
		if (name.length > 120) {
			name = name.substring(0, 120);
		}
		return (name || "page") + ".html";
	} catch {
		return "page.html";
	}
}

function localIso(timestamp) {
	const date = new Date(timestamp);
	const pad = value => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
		`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseLine(line) {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#")) {
		return { raw: line, comment: true };
	}
	const tokens = trimmed.split(/[\t ]+/);
	let timestamp = null, url = null, attempts = 0, status = null;
	for (const token of tokens) {
		const upper = token.toUpperCase();
		if (!url && /^https?:\/\//i.test(token)) {
			url = token;
		} else if (!url && /^www\./i.test(token)) {
			url = "https://" + token;
		} else if (!status && STATUSES.has(upper)) {
			status = upper;
		} else if (!timestamp && !/^\d+$/.test(token) && !Number.isNaN(Date.parse(token))) {
			timestamp = Date.parse(token);
		} else if (/^\d{1,2}$/.test(token)) {
			attempts = parseInt(token, 10);
		}
	}
	return { raw: line, timestamp, url, attempts, status: status || STATUS_QUEUE };
}

function parseText(text) {
	return (text || "").split(/\r?\n/).filter(line => line.trim()).map(parseLine);
}

function formatLine(entry) {
	return `${entry.url}\t${entry.status}\t${localIso(entry.timestamp || Date.now())}\t${entry.attempts || 0}`;
}

async function readSession(session) {
	return parseText(await offscreen.archiveReadText(session, SESSION_FILE));
}

function writeSession(session, entries) {
	const text = entries.map(entry => entry.comment ? entry.raw : formatLine(entry)).join("\n");
	return offscreen.archiveWriteText(session, SESSION_FILE, text ? text + "\n" : "");
}

// upsert the status of a URL in session.txt
async function setStatus(url, status, { resetAttempts = false, bumpAttempts = false } = {}) {
	const session = await getSession();
	if (!session) {
		return;
	}
	const entries = await readSession(session);
	let entry = entries.find(candidate => candidate.url == url);
	if (!entry) {
		entry = { url, attempts: 0 };
		entries.push(entry);
	}
	entry.status = status;
	entry.timestamp = Date.now();
	if (resetAttempts) {
		entry.attempts = 0;
	}
	if (bumpAttempts) {
		entry.attempts = (entry.attempts || 0) + 1;
	}
	await writeSession(session, entries);
}

// Called on every navigation before the save starts; the entry moves to
// INPROGRESS/DOWNLOADED as the save advances.
async function onNavigation(url) {
	try {
		if (!isArchivableUrl(url)) {
			return;
		}
		// Before the parking branch below, deliberately: a page visited while
		// archiving is off must not be queued either, or pressing Start would
		// archive everything browsed in the meantime.
		if (await isPaused()) {
			return;
		}
		if (!(await isReady())) {
			// folder unavailable: park the URL in extension storage so it can be
			// drained into session.txt once access is re-granted
			const { autoArchivePending } = await chrome.storage.local.get("autoArchivePending");
			const pending = autoArchivePending || [];
			if (!pending.find(entry => entry.url == url)) {
				pending.push({ timestamp: Date.now(), url, attempts: 0, status: STATUS_QUEUE });
				await chrome.storage.local.set({ autoArchivePending: pending.slice(-200) });
			}
			return;
		}
		// never demote a page that is already saved (or actively saving) back to
		// QUEUE — pages re-announce themselves after soft navigations and that
		// used to leave phantom QUEUE lines that could never complete
		const session = await getSession();
		if (!session) {
			return;
		}
		const entries = await readSession(session);
		const existing = entries.find(entry => entry.url == url);
		if (existing && (existing.status == STATUS_DOWNLOADED || existing.status == STATUS_INPROGRESS)) {
			debugLog("navigation ignored (already " + existing.status + "):", url);
			return;
		}
		await setStatus(url, STATUS_QUEUE, { resetAttempts: true });
		debugLog("queued:", url);
	} catch (error) {
		console.warn("auto-archive: could not enqueue", url, error); // eslint-disable-line no-console
	}
}

async function markInProgress(url) {
	try {
		if (url && await isReady()) {
			await setStatus(url, STATUS_INPROGRESS);
		}
	} catch (error) {
		console.warn("auto-archive: could not update session.txt", url, error); // eslint-disable-line no-console
	}
}

async function markSaved(url) {
	try {
		replayingUrls.delete(url);
		if (url && await isReady()) {
			await setStatus(url, STATUS_DOWNLOADED);
			debugLog("downloaded:", url);
		}
	} catch (error) {
		console.warn("auto-archive: could not update session.txt", url, error); // eslint-disable-line no-console
	}
}

// a save attempt failed: back to QUEUE with one more attempt on the counter,
// so the poller retries it (up to MAX_ATTEMPTS)
async function markFailedAttempt(url) {
	try {
		if (url && await isReady()) {
			await setStatus(url, STATUS_QUEUE, { bumpAttempts: true });
		}
	} catch (error) {
		console.warn("auto-archive: could not update session.txt", url, error); // eslint-disable-line no-console
	}
}

async function processQueue() {
	// Stop means stop: without this the 10-second poller would keep replaying
	// whatever is still sitting in session.txt, so pages would carry on being
	// archived after the user switched archiving off.
	if (processingQueue || !saveUrls || (await isPaused()) || !(await isReady())) {
		return {};
	}
	processingQueue = true;
	chrome.storage.session.set({ autoArchiveLastPoll: Date.now() }).catch(() => { });
	try {
		const session = await getSession();
		if (!session) {
			return {};
		}
		if (!processQueue.logged) {
			processQueue.logged = true;
			debugLog("poller active, session:", session, "build:", BUILD_ID);
		}
		const entries = await readSession(session);
		let changed = false;
		// drain URLs parked while the folder was unavailable
		const { autoArchivePending } = await chrome.storage.local.get("autoArchivePending");
		if (autoArchivePending && autoArchivePending.length) {
			for (const pending of autoArchivePending) {
				if (!entries.find(entry => entry.url == pending.url)) {
					entries.push(pending);
					changed = true;
				}
			}
			await chrome.storage.local.remove("autoArchivePending");
			debugLog("drained", autoArchivePending.length, "parked navigation(s) into session.txt");
		}
		const now = Date.now();
		const batch = [];
		const seenUrls = new Set();
		for (const entry of entries) {
			if (entry.comment || !entry.url || !isArchivableUrl(entry.url)) {
				continue;
			}
			if (seenUrls.has(entry.url)) {
				entry.duplicate = true;
				changed = true;
				continue;
			}
			seenUrls.add(entry.url);
			if (entry.status == STATUS_DOWNLOADED || entry.status == STATUS_FAILED) {
				continue;
			}
			if (entry.attempts >= MAX_ATTEMPTS) {
				entry.status = STATUS_FAILED;
				changed = true;
				continue;
			}
			const age = entry.timestamp ? now - entry.timestamp : Infinity;
			const eligible =
				(entry.status == STATUS_QUEUE && age >= MIN_ENTRY_AGE_MS) ||
				(entry.status == STATUS_INPROGRESS && age >= STALE_INPROGRESS_MS);
			if (eligible && batch.length < MAX_BATCH_SIZE &&
				!isReplaying(entry.url) && !(isSavingUrl && isSavingUrl(entry.url))) {
				entry.status = STATUS_INPROGRESS;
				entry.timestamp = now;
				entry.attempts = (entry.attempts || 0) + 1;
				batch.push(entry);
				changed = true;
			}
		}
		if (changed) {
			await writeSession(session, entries.filter(entry => !entry.duplicate));
		}
		if (batch.length) {
			debugLog("queue poll: replaying", batch.map(entry => entry.url));
			batch.forEach(entry => replayingUrls.set(entry.url, Date.now()));
			await saveUrls(batch.map(entry => entry.url));
		}
		return { processed: batch.length };
	} catch (error) {
		console.warn("auto-archive: queue processing failed", error); // eslint-disable-line no-console
		return { error: error.message };
	} finally {
		processingQueue = false;
	}
}
