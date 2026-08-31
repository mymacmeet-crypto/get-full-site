/*
 * Web Archiver — service worker side.
 *
 * Maintains one folder per browser session inside the user-chosen archive
 * folder (session_<date>_<time>/), holding:
 *   - session.txt: one line per visited URL — "url  STATUS  time  attempts"
 *     with STATUS ∈ QUEUE | INPROGRESS | DOWNLOADED | FAILED
 *   - pages/: the saved HTML files, named after the URL
 *     (gsmarena.com_phone_review.html)
 *   - markdown/: the same pages as .md, when the chosen format asks for it
 *   - debug.log: timestamped trace
 *
 * URLs stuck in QUEUE (or stale INPROGRESS) are replayed in background tabs by
 * a poller: a 10-second ticker in the offscreen document plus an alarm
 * backstop. Hand-typed bare-URL lines in session.txt are picked up as QUEUE.
 * Unfinished entries of the previous session are carried into the new one.
 */

/* global chrome, browser, URL, setTimeout */

import * as config from "./config.js";
import * as offscreen from "./offscreen.js";
import * as tabsData from "./tabs-data.js";
import { isPaused, setPaused, heal } from "./archive-pause.js";
import { getSettings, setSettings } from "./archive-settings.js";
import { isHiddenTab, closeIfIdle } from "./archive-window.js";
import { refreshAutoSaveTabs } from "./autosave-util.js";

const BUILD_ID = "2026-08-29.1";
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
// How long a tab gets to answer "are you still there?" before its URL is
// reopened in a fresh background tab instead. A live content script replies in
// single-digit milliseconds; this only has to outlast a busy event loop.
const PING_TIMEOUT_MS = 1000;
// Set whenever a folder is needed and cannot be asked for without a user
// gesture. ui-button.js turns it into a "!" badge and the popup turns it into
// a button; nothing opens the setup page on its own any more — see isReady().
const NEEDS_FOLDER_KEY = "autoArchiveNeedsFolder";
const SESSION_FILE = "session.txt";
const DEBUG_FILE = "debug.log";
const SESSION_KEY = "autoArchiveSession";
const STATUS_QUEUE = "QUEUE";
const STATUS_INPROGRESS = "INPROGRESS";
const STATUS_DOWNLOADED = "DOWNLOADED";
const STATUS_FAILED = "FAILED";
const STATUSES = new Set([STATUS_QUEUE, STATUS_INPROGRESS, STATUS_DOWNLOADED, STATUS_FAILED]);

let saveUrls, saveTabs, isSavingUrl, refreshButtons;
let cachedState, cachedStateTime = 0;
let processingQueue = false;
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
	isPaused,
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
	refreshButtons = api.refreshButtons;
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
		// Deliberately no tab. A fresh install has no folder yet, but opening a
		// page for it is the same reflex that made this extension reopen its setup
		// page on every browser start; the badge and the popup say so instead.
		chrome.storage.session.set({ [NEEDS_FOLDER_KEY]: true }).catch(() => { });
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
		// repair an install left un-archivable by the retired profile-flipping
		// Stop before reading the profiles below, so the migration sees the
		// restored values rather than the disarmed ones
		const healResult = await heal(config);
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
		return { autoSaveAll: Boolean(allTabsData.autoSaveAll), heal: healResult };
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
	if (message.method.endsWith(".getPaused")) {
		return { paused: await isPaused() };
	}
	if (message.method.endsWith(".setPaused")) {
		const result = await setPaused(message.paused);
		// The open tabs each hold an autoSaveEnabled flag from their last
		// content.init, so without this a tab loaded before Stop would still
		// capture itself on unload. Repaint the buttons too, so the badge
		// agrees with the switch immediately rather than on the next tab
		// activation.
		await Promise.all([
			refreshAutoSaveTabs().catch(() => { }),
			refreshButtons ? refreshButtons().catch(() => { }) : Promise.resolve()
		]);
		if (result.paused) {
			// Nothing more will be captured, so the hidden window has no reason to
			// stay in the taskbar for the rest of the session.
			closeIfIdle().catch(() => { });
		}
		debugLog(result.paused ? "stopped by user" : "started by user");
		return result;
	}
	if (message.method.endsWith(".getSettings")) {
		return getSettings();
	}
	if (message.method.endsWith(".setSettings")) {
		const settings = await setSettings({ mode: message.mode, format: message.format });
		// Every open tab caches the autoSaveEnabled it was handed at load, so
		// switching to Manual has to reach them or a tab opened while in Auto
		// would still capture itself on unload. Same reasoning as setPaused.
		await Promise.all([
			refreshAutoSaveTabs().catch(() => { }),
			refreshButtons ? refreshButtons().catch(() => { }) : Promise.resolve()
		]);
		debugLog("settings changed: mode =", settings.mode, "format =", settings.format);
		return settings;
	}
	if (message.method.endsWith(".getTabList")) {
		return getTabList();
	}
	if (message.method.endsWith(".downloadUrls")) {
		return downloadUrls(message.urls);
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
		sessionName = null;
		sessionPromise = null;
		await chrome.storage.session.remove(SESSION_KEY);
		// isReady() rewrites this on its next call anyway, but the badge should
		// clear the moment the folder is connected rather than on the next save.
		await isReady();
		if (refreshButtons) {
			await refreshButtons().catch(() => { });
		}
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
			await queueExplicitly(tab.url);
			// explicitSave, so a click still saves while stopped or in Manual mode.
			// Without it this went through autoSaveIsEnabled() and did nothing.
			saveTabs([tab], { autoSave: true, explicitSave: true });
		}
		return {};
	}
}

async function getState(refresh) {
	if (refresh || !cachedState || Date.now() - cachedStateTime > STATE_CACHE_MS) {
		cachedState = await offscreen.archiveGetState();
		cachedStateTime = Date.now();
	}
	return cachedState;
}

/*
 * Whether pages can be written right now.
 *
 * This used to open the setup page when the folder permission was missing,
 * throttled to once an hour through storage.session. storage.session clears
 * when the browser closes, so the throttle reset on every start and the answer
 * to "is the folder ready" was almost always no at that moment — which is why
 * the extension reopened its own setup page every single time Chrome started.
 *
 * Re-granting still needs a user gesture, so the need is recorded instead:
 * ui-button.js paints a "!" badge from this flag and the popup offers the
 * button. Nothing here opens a tab.
 */
async function isReady() {
	try {
		const state = await getState();
		const ready = Boolean(state.configured && state.permission == "granted");
		await chrome.storage.session.set({ [NEEDS_FOLDER_KEY]: !ready });
		return ready;
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

/*
 * The current session folder if one exists, without creating one.
 *
 * getSession() creates on demand, which is right when a page is about to be
 * written and wrong for the popup: polling a status list every second and a
 * half would otherwise mint an empty session folder on every browser start,
 * for someone who is in Manual mode and has not asked for anything yet.
 */
async function peekSession() {
	if (sessionName) {
		return sessionName;
	}
	try {
		return (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY] || null;
	} catch {
		return null;
	}
}

/** URL -> STATUS for everything the current session knows about. */
async function readStatuses() {
	const statuses = new Map();
	try {
		const session = await peekSession();
		if (session) {
			for (const entry of await readSession(session)) {
				if (entry.url) {
					statuses.set(entry.url, entry.status);
				}
			}
		}
	} catch {
		// session.txt unreadable right now; the popup shows no status rather than
		// failing to render the list at all
	}
	return statuses;
}

/*
 * The open tabs, one row per distinct URL, with whatever the archive knows
 * about each.
 *
 * Deduplicated by URL rather than by tab because the archive is keyed by URL:
 * the same page open in three tabs is one document, and showing it three times
 * would offer three ways to write the same file.
 */
async function getTabList() {
	const tabs = await browser.tabs.query({});
	const rows = new Map();
	for (const tab of tabs) {
		// A capture in progress is not a tab the user opened — it lives in the
		// hidden window and disappears again on its own. Listing it would offer
		// the user a row that archives a page already being archived, and make
		// rows appear and vanish under the pointer.
		if (!isArchivableUrl(tab.url) || isHiddenTab(tab.id)) {
			continue;
		}
		const existing = rows.get(tab.url);
		if (existing) {
			existing.tabCount++;
		} else {
			rows.set(tab.url, {
				url: tab.url,
				title: tab.title || tab.url,
				favIconUrl: tab.favIconUrl || null,
				active: Boolean(tab.active),
				tabCount: 1
			});
		}
	}
	const statuses = await readStatuses();
	return {
		tabs: [...rows.values()].map(row => ({ ...row, status: statuses.get(row.url) || null })),
		needsFolder: !(await isReady())
	};
}

/*
 * Archive the URLs the user ticked in the popup.
 *
 * An open tab is saved through the tab itself rather than by reopening the URL
 * in a background one: the live tab already holds the page as the user sees it,
 * scrolled and logged in, and reopening it would fetch the page again and get
 * whatever the server serves now. Only a URL with no tab behind it goes through
 * the replay path.
 *
 * explicitSave rides along on the options so neither business.js nor the
 * content script's autoSaveEnabled gate turns the click into a no-op while the
 * archiver is stopped or in Manual mode.
 */
async function downloadUrls(urls) {
	if (!saveTabs || !saveUrls) {
		return { error: "not_initialized" };
	}
	const wanted = [...new Set((urls || []).filter(isArchivableUrl))];
	if (!wanted.length) {
		return { started: 0 };
	}
	// Queue them first, so the popup shows the state on its next poll and the
	// poller retries anything that fails on its own.
	for (const url of wanted) {
		await queueExplicitly(url);
	}
	const openTabs = await browser.tabs.query({});
	const tabByUrl = new Map();
	for (const tab of openTabs) {
		// Never save "through" a hidden capture tab: it belongs to a capture
		// already running, and handing it a second one would have the page save
		// itself twice.
		if (!tabByUrl.has(tab.url) && !isHiddenTab(tab.id)) {
			tabByUrl.set(tab.url, tab);
		}
	}
	const tabs = [], missing = [];
	await Promise.all(wanted.map(async url => {
		const tab = tabByUrl.get(url);
		// A tab is only useful if something in it can still answer. After the
		// extension is reloaded every tab that was already open holds an orphaned
		// content script: the save message reaches Chrome, fails with a connection
		// error, and business.js treats that as an ignorable error — so the whole
		// batch went to QUEUE and then sat there doing nothing at all.
		if (tab && await isTabAlive(tab.id)) {
			tabs.push(tab);
		} else {
			missing.push(url);
		}
	}));
	debugLog("download requested for", wanted.length, "URL(s):", tabs.length, "live tab(s),", missing.length, "to reopen");
	if (tabs.length) {
		saveTabs(tabs, { autoSave: true, explicitSave: true });
	}
	if (missing.length) {
		missing.forEach(url => replayingUrls.set(url, Date.now()));
		saveUrls(missing);
	}
	return { started: wanted.length };
}

/*
 * Does this tab still hold a content script that can capture it?
 *
 * Answering "no" costs a reopened background tab; answering "yes" wrongly costs
 * a save that silently never happens, which is much worse — so a tab that does
 * not reply promptly is treated as dead.
 */
async function isTabAlive(tabId) {
	try {
		const reply = await Promise.race([
			browser.tabs.sendMessage(tabId, { method: "content.ping" }),
			new Promise(resolve => setTimeout(() => resolve(null), PING_TIMEOUT_MS))
		]);
		return Boolean(reply && reply.alive);
	} catch {
		return false;
	}
}

/*
 * Put a URL into session.txt because the user asked for it.
 *
 * onNavigation() refuses while stopped or in Manual mode, which is right for a
 * page that merely got visited and wrong for one that was ticked and sent.
 */
async function queueExplicitly(url) {
	try {
		if (await isReady()) {
			await setStatus(url, STATUS_QUEUE, { resetAttempts: true });
		}
	} catch (error) {
		console.warn("web-archiver: could not queue", url, error); // eslint-disable-line no-console
	}
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

/*
 * Every read-modify-write of session.txt goes through this one chain.
 *
 * archive-fs.js serialises individual *file operations*, which is not the same
 * thing: a status update is a read and then a write, and two of them could
 * interleave as read-read-write-write. The second writer had loaded the file
 * before the first one saved, so it wrote that stale copy back and the first
 * update vanished.
 *
 * With one page saving at a time this almost never showed. With four — a batch
 * download, which is exactly what the popup's "Select all" produces — it showed
 * every time: INPROGRESS and DOWNLOADED updates were overwritten by whichever
 * tab happened to write last, so session.txt still said QUEUE for pages that
 * had already been captured, and the popup reported a batch that had queued
 * everything and downloaded nothing.
 */
let sessionChain = Promise.resolve();

function withSession(operation) {
	// run next whether the previous link resolved or rejected: one failed
	// status write must not wedge every later one
	const result = sessionChain.then(operation, operation);
	sessionChain = result.then(() => { }, () => { });
	return result;
}

/*
 * Load session.txt, let `mutate` change the entries, write them back.
 *
 * `mutate` may return false to say "nothing changed, skip the write", and may
 * return a value through `result` for callers that need one.
 */
function mutateSession(mutate) {
	return withSession(async () => {
		const session = await getSession();
		if (!session) {
			return undefined;
		}
		const entries = await readSession(session);
		const outcome = await mutate(entries, session);
		if (outcome !== false) {
			await writeSession(session, entries.filter(entry => !entry.duplicate));
		}
		return outcome;
	});
}

// upsert the status of a URL in session.txt
function setStatus(url, status, { resetAttempts = false, bumpAttempts = false } = {}) {
	return mutateSession(entries => {
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
	});
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
		// archive everything browsed in the meantime. Manual mode is the same
		// argument — switching to Auto must not replay the last hour of browsing.
		if (await isPaused() || (await getSettings()).mode == "manual") {
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
		// Never demote a page that is already saved (or actively saving) back to
		// QUEUE — pages re-announce themselves after soft navigations and that
		// used to leave phantom QUEUE lines that could never complete.
		//
		// The check and the write are one chained operation, not a read followed
		// by a separate setStatus: in between the two, a save finishing in
		// another tab could turn this entry DOWNLOADED and this call would then
		// push it back to QUEUE.
		await mutateSession(entries => {
			const existing = entries.find(entry => entry.url == url);
			if (existing && (existing.status == STATUS_DOWNLOADED || existing.status == STATUS_INPROGRESS)) {
				debugLog("navigation ignored (already " + existing.status + "):", url);
				return false;
			}
			const entry = existing || { url, attempts: 0 };
			if (!existing) {
				entries.push(entry);
			}
			entry.status = STATUS_QUEUE;
			entry.timestamp = Date.now();
			entry.attempts = 0;
			debugLog("queued:", url);
		});
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
		// Picking the batch and marking it INPROGRESS is one chained operation.
		// Doing it as a bare read and write let the poller overwrite a status a
		// tab had just set — it would then re-replay a page that was already
		// being captured.
		const batch = await mutateSession(async entries => {
			// drain URLs parked while the folder was unavailable
			const { autoArchivePending } = await chrome.storage.local.get("autoArchivePending");
			if (autoArchivePending && autoArchivePending.length) {
				for (const pending of autoArchivePending) {
					if (!entries.find(entry => entry.url == pending.url)) {
						entries.push(pending);
					}
				}
				await chrome.storage.local.remove("autoArchivePending");
				debugLog("drained", autoArchivePending.length, "parked navigation(s) into session.txt");
			}
			const now = Date.now();
			const picked = [];
			const seenUrls = new Set();
			for (const entry of entries) {
				if (entry.comment || !entry.url || !isArchivableUrl(entry.url)) {
					continue;
				}
				if (seenUrls.has(entry.url)) {
					entry.duplicate = true;
					continue;
				}
				seenUrls.add(entry.url);
				if (entry.status == STATUS_DOWNLOADED || entry.status == STATUS_FAILED) {
					continue;
				}
				if (entry.attempts >= MAX_ATTEMPTS) {
					entry.status = STATUS_FAILED;
					continue;
				}
				const age = entry.timestamp ? now - entry.timestamp : Infinity;
				const eligible =
					(entry.status == STATUS_QUEUE && age >= MIN_ENTRY_AGE_MS) ||
					(entry.status == STATUS_INPROGRESS && age >= STALE_INPROGRESS_MS);
				if (eligible && picked.length < MAX_BATCH_SIZE &&
					!isReplaying(entry.url) && !(isSavingUrl && isSavingUrl(entry.url))) {
					entry.status = STATUS_INPROGRESS;
					entry.timestamp = now;
					entry.attempts = (entry.attempts || 0) + 1;
					picked.push(entry.url);
				}
			}
			return picked;
		}) || [];
		if (batch.length) {
			debugLog("queue poll: replaying", batch);
			batch.forEach(url => replayingUrls.set(url, Date.now()));
			await saveUrls(batch);
		}
		return { processed: batch.length };
	} catch (error) {
		console.warn("auto-archive: queue processing failed", error); // eslint-disable-line no-console
		return { error: error.message };
	} finally {
		processingQueue = false;
	}
}
