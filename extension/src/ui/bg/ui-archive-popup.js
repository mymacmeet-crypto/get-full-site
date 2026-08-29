/*
 * Web Archiver — toolbar popup.
 *
 * Four things, top to bottom: the Start/Stop switch, the Auto/Manual mode and
 * HTML/MD/Both format, the URLs open in Chrome right now with what the archive
 * knows about each, and the buttons that archive the ones you ticked.
 *
 * The popup owns no state. Every control is one message to the service worker,
 * which holds the flags and echoes back what it stored — so a click that did
 * not take effect is reported rather than drawn as if it had. An earlier
 * version of the switch wrote extension profiles from here and a click
 * interrupted half way through (the popup closes the moment focus moves) could
 * leave archiving off with no way to turn it back on.
 *
 * The tab list is polled rather than pushed. A popup lives for a few seconds
 * and Chrome gives it no way to be told when a save finishes, so a poll is the
 * whole mechanism; POLL_INTERVAL_MS is a compromise between a status that
 * looks live and waking the service worker more than the archiving itself does.
 */

/* global chrome, document, setTimeout, setInterval */

const SETUP_PAGE_URL = "/src/ui/pages/auto-archive.html";
const HEALTH_PAGE_URL = "/src/ui/pages/archive-health.html";
const POLL_INTERVAL_MS = 1500;

const STATUS_LABELS = {
	QUEUE: { icon: "🕓", text: "Queued" },
	INPROGRESS: { icon: "⬇", text: "Downloading…" },
	DOWNLOADED: { icon: "✅", text: "Downloaded" },
	FAILED: { icon: "⚠", text: "Failed" }
};

const MODE_HINTS = {
	auto: "Every page you visit is archived as you browse.",
	manual: "Nothing is archived on its own — tick URLs below and press Download."
};

const powerButton = document.getElementById("powerButton");
const powerStatus = document.getElementById("powerStatus");
const modeHint = document.getElementById("modeHint");
const folderWarning = document.getElementById("folderWarning");
const tabList = document.getElementById("tabList");
const listCount = document.getElementById("listCount");
const selectAllButton = document.getElementById("selectAll");
const downloadButton = document.getElementById("downloadButton");
const saveNowButton = document.getElementById("saveNowButton");

// Selection is held here, by URL, and survives every re-render: the list
// refreshes every second and a half, and rebuilding it from the checkboxes
// would clear a tick the moment a save changed some other row's status.
const selected = new Set();
let knownUrls = [];
// Stop hides the mode hint, and the hint is repainted from more than one place
// — remembering the switch here keeps a format click from reviving a line about
// automatic archiving that is currently switched off.
let stopped = false;

function send(message) {
	return chrome.runtime.sendMessage(message);
}

/* ---- Start / Stop -------------------------------------------------- */

powerButton.addEventListener("click", async () => {
	const stopping = powerButton.dataset.state == "running";
	powerButton.disabled = true;
	powerButton.textContent = stopping ? "Stopping…" : "Starting…";
	try {
		const result = await send({ method: "autoArchive.setPaused", paused: stopping });
		// the service worker echoes the flag it stored, so a click that did not
		// take effect is reported rather than shown as success
		if (!result || Boolean(result.paused) != stopping) {
			throw new Error("the background did not confirm the change");
		}
	} catch (error) {
		powerStatus.textContent = "Could not switch: " + errorText(error);
	}
	await refreshPower();
});

async function refreshPower() {
	try {
		const state = await send({ method: "autoArchive.getPaused" });
		stopped = Boolean(state && state.paused);
	} catch (error) {
		powerButton.textContent = "—";
		powerStatus.textContent = "Background unreachable: " + errorText(error);
		return;
	}
	powerButton.disabled = false;
	powerButton.dataset.state = stopped ? "stopped" : "running";
	powerButton.textContent = stopped ? "Start" : "Stop";
	powerStatus.innerHTML = stopped
		? "<strong>Stopped.</strong> Nothing is being archived."
		: "<strong>Running.</strong>";
	// The mode controls describe automatic archiving, which Stop has switched
	// off entirely; leaving them live would offer a choice with no effect.
	for (const button of document.querySelectorAll("[data-setting=\"mode\"]")) {
		button.disabled = stopped;
	}
	await refreshSettings();
}

/* ---- Mode and format ------------------------------------------------ */

for (const button of document.querySelectorAll("[data-setting]")) {
	button.addEventListener("click", async () => {
		const { setting, value } = button.dataset;
		try {
			const settings = await send({ method: "autoArchive.setSettings", [setting]: value });
			paintSettings(settings);
		} catch (error) {
			modeHint.textContent = "Could not change " + setting + ": " + errorText(error);
		}
		refresh();
	});
}

async function refreshSettings() {
	try {
		paintSettings(await send({ method: "autoArchive.getSettings" }));
	} catch {
		// the switch above already reports an unreachable background
	}
}

function paintSettings(settings) {
	if (!settings) {
		return;
	}
	for (const button of document.querySelectorAll("[data-setting]")) {
		const active = settings[button.dataset.setting] == button.dataset.value;
		button.setAttribute("aria-pressed", String(active));
	}
	modeHint.textContent = stopped ? "" : MODE_HINTS[settings.mode] || "";
}

/* ---- The open tabs -------------------------------------------------- */

async function refresh() {
	let result;
	try {
		result = await send({ method: "autoArchive.getTabList" });
	} catch {
		// the service worker is starting back up; the next poll gets the list
		return;
	}
	if (!result) {
		return;
	}
	folderWarning.classList.toggle("visible", Boolean(result.needsFolder));

	const tabs = result.tabs || [];
	knownUrls = tabs.map(tab => tab.url);
	// A tab that has been closed should not stay counted in "Download 3 selected"
	for (const url of [...selected]) {
		if (!knownUrls.includes(url)) {
			selected.delete(url);
		}
	}

	listCount.textContent = tabs.length
		? `Open tabs (${tabs.length})`
		: "Open tabs";
	selectAllButton.hidden = tabs.length === 0;
	selectAllButton.textContent = tabs.length && selected.size == tabs.length ? "Clear all" : "Select all";

	tabList.textContent = "";
	if (!tabs.length) {
		const item = document.createElement("li");
		item.className = "empty";
		item.textContent = "No archivable tabs open. Only http:// and https:// pages can be saved.";
		tabList.appendChild(item);
	} else {
		for (const tab of tabs) {
			tabList.appendChild(renderRow(tab));
		}
	}
	paintDownloadButton();
}

function renderRow(tab) {
	const item = document.createElement("li");

	const checkbox = document.createElement("input");
	checkbox.type = "checkbox";
	checkbox.checked = selected.has(tab.url);
	checkbox.addEventListener("click", event => event.stopPropagation());
	checkbox.addEventListener("change", () => {
		toggle(tab.url, checkbox.checked);
	});

	const body = document.createElement("div");
	body.className = "body";
	const title = document.createElement("span");
	title.className = "title";
	title.textContent = tab.tabCount > 1 ? `${tab.title} (${tab.tabCount} tabs)` : tab.title;
	const url = document.createElement("span");
	url.className = "url";
	url.textContent = tab.url;
	body.append(title, url);

	const status = document.createElement("span");
	status.className = "status";
	const label = STATUS_LABELS[tab.status];
	if (label) {
		status.dataset.status = tab.status;
		status.textContent = `${label.icon} ${label.text}`;
	}

	// The whole row is the target: a 13px checkbox is a small thing to hit when
	// you are ticking eight of them.
	item.addEventListener("click", () => {
		checkbox.checked = !checkbox.checked;
		toggle(tab.url, checkbox.checked);
	});
	item.append(checkbox, body, status);
	return item;
}

function toggle(url, on) {
	if (on) {
		selected.add(url);
	} else {
		selected.delete(url);
	}
	selectAllButton.textContent = knownUrls.length && selected.size == knownUrls.length ? "Clear all" : "Select all";
	paintDownloadButton();
}

function paintDownloadButton() {
	downloadButton.disabled = selected.size === 0;
	downloadButton.textContent = selected.size
		? `Download ${selected.size} selected`
		: "Download selected";
}

selectAllButton.addEventListener("click", () => {
	if (selected.size == knownUrls.length) {
		selected.clear();
	} else {
		knownUrls.forEach(url => selected.add(url));
	}
	refresh();
});

/* ---- Actions -------------------------------------------------------- */

downloadButton.addEventListener("click", async () => {
	const urls = [...selected];
	downloadButton.disabled = true;
	downloadButton.textContent = "Starting…";
	try {
		await send({ method: "autoArchive.downloadUrls", urls });
		// Clear the ticks: the rows now carry their own status, and leaving them
		// selected invites a second click that archives everything again.
		selected.clear();
	} catch (error) {
		modeHint.textContent = "Could not start: " + errorText(error);
	}
	refresh();
});

saveNowButton.addEventListener("click", async () => {
	saveNowButton.disabled = true;
	saveNowButton.textContent = "Saving…";
	try {
		await send({ method: "autoArchive.saveNow" });
	} catch (error) {
		modeHint.textContent = "Could not save: " + errorText(error);
	}
	setTimeout(() => {
		saveNowButton.disabled = false;
		saveNowButton.textContent = "Save this page";
		refresh();
	}, 1500);
});

// Choosing a folder needs a user gesture in a page that survives the picker
// dialog, and a popup does not: Chrome closes it the moment focus leaves. So
// the click opens the setup page — still something the user asked for, which
// is the whole difference from the tab this extension used to open by itself.
document.getElementById("chooseFolderButton").addEventListener("click", () => {
	chrome.tabs.create({ active: true, url: SETUP_PAGE_URL });
});

document.getElementById("setupLink").addEventListener("click", () => {
	chrome.tabs.create({ active: true, url: SETUP_PAGE_URL });
});

document.getElementById("healthLink").addEventListener("click", () => {
	chrome.tabs.create({ active: true, url: HEALTH_PAGE_URL });
});

function errorText(error) {
	return error && error.message ? error.message : String(error);
}

refreshPower();
refresh();
setInterval(refresh, POLL_INTERVAL_MS);
