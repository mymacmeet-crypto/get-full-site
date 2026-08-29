/*
 * Web Archiver — the two choices the popup offers besides Start/Stop.
 *
 *   mode:   "auto"   every page you visit is captured as you browse
 *           "manual" nothing is captured on its own; you tick URLs in the
 *                    popup and press Download
 *   format: "html" | "md" | "both" — what gets written for each captured page
 *
 * Both live in chrome.storage.local rather than storage.session for the same
 * reason the pause flag does: a service worker restart must not quietly put
 * the archiver back into a mode the user did not choose.
 *
 * Mode is deliberately *not* the same flag as Stop. Stop is the master switch
 * and turns everything off, the queue poller included. Manual leaves the
 * machinery running — retries of a download you asked for still happen — and
 * only stops pages capturing themselves as you browse.
 */

/* global chrome */

const MODE_KEY = "archiveMode";
const FORMAT_KEY = "archiveFormat";

const MODE_AUTO = "auto";
const MODE_MANUAL = "manual";
const MODES = new Set([MODE_AUTO, MODE_MANUAL]);

const FORMAT_HTML = "html";
const FORMAT_MARKDOWN = "md";
const FORMAT_BOTH = "both";
const FORMATS = new Set([FORMAT_HTML, FORMAT_MARKDOWN, FORMAT_BOTH]);

const DEFAULTS = { mode: MODE_AUTO, format: FORMAT_HTML };

// Read on every navigation and every button repaint, so it is cached in
// memory and invalidated by the change event rather than re-read each time.
// undefined means "not loaded yet".
let cached;

chrome.storage.onChanged.addListener((changes, area) => {
	if (area == "local" && (changes[MODE_KEY] || changes[FORMAT_KEY]) && cached) {
		if (changes[MODE_KEY]) {
			cached.mode = normalizeMode(changes[MODE_KEY].newValue);
		}
		if (changes[FORMAT_KEY]) {
			cached.format = normalizeFormat(changes[FORMAT_KEY].newValue);
		}
	}
});

export {
	MODE_AUTO,
	MODE_MANUAL,
	FORMAT_HTML,
	FORMAT_MARKDOWN,
	FORMAT_BOTH,
	getSettings,
	setSettings,
	isManual,
	wantsHtml,
	wantsMarkdown
};

function normalizeMode(value) {
	return MODES.has(value) ? value : DEFAULTS.mode;
}

function normalizeFormat(value) {
	return FORMATS.has(value) ? value : DEFAULTS.format;
}

async function getSettings() {
	if (cached) {
		return cached;
	}
	try {
		const stored = await chrome.storage.local.get([MODE_KEY, FORMAT_KEY]);
		cached = {
			mode: normalizeMode(stored[MODE_KEY]),
			format: normalizeFormat(stored[FORMAT_KEY])
		};
	} catch {
		// storage unavailable: fall back to the defaults rather than refusing to
		// archive, which is the extension's whole job
		cached = { ...DEFAULTS };
	}
	return cached;
}

// Accepts a partial update; anything absent keeps its current value, so the
// popup can send just the control the user touched.
async function setSettings({ mode, format } = {}) {
	const current = await getSettings();
	const next = {
		mode: mode === undefined ? current.mode : normalizeMode(mode),
		format: format === undefined ? current.format : normalizeFormat(format)
	};
	cached = next;
	await chrome.storage.local.set({ [MODE_KEY]: next.mode, [FORMAT_KEY]: next.format });
	return next;
}

async function isManual() {
	return (await getSettings()).mode == MODE_MANUAL;
}

async function wantsHtml() {
	const { format } = await getSettings();
	return format == FORMAT_HTML || format == FORMAT_BOTH;
}

async function wantsMarkdown() {
	const { format } = await getSettings();
	return format == FORMAT_MARKDOWN || format == FORMAT_BOTH;
}
