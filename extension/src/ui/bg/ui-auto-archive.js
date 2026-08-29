/*
 * Web Archiver — setup page logic. Runs as an unbundled ES module (like the
 * other src/ui/bg/ui-*.js pages) and talks to the same IndexedDB-persisted
 * folder handle as the offscreen document.
 */

/* global chrome, document, window */

import * as archiveFs from "./../../core/bg/archive-fs.js";

const folderStatus = document.getElementById("folderStatus");
const chooseFolderButton = document.getElementById("chooseFolderButton");
const grantButton = document.getElementById("grantButton");
const refreshQueueButton = document.getElementById("refreshQueueButton");
const runQueueButton = document.getElementById("runQueueButton");
const queueContent = document.getElementById("queueContent");
const diagButton = document.getElementById("diagButton");
const diagContent = document.getElementById("diagContent");

chooseFolderButton.addEventListener("click", chooseFolder);
grantButton.addEventListener("click", grantAccess);
refreshQueueButton.addEventListener("click", refreshQueue);
runQueueButton.addEventListener("click", runQueue);
diagButton.addEventListener("click", runDiagnostics);
runDiagnostics();
setInterval(refreshQueue, 5000);

async function runDiagnostics() {
	diagContent.textContent = "Running…";
	try {
		const [diag, pageState] = await Promise.all([
			chrome.runtime.sendMessage({ method: "autoArchive.getDiagnostics" }),
			archiveFs.getState()
		]);
		diagContent.textContent = JSON.stringify({
			serviceWorker: diag || "NO RESPONSE — service worker not answering",
			folderStateSeenByThisPage: pageState
		}, null, 2);
	} catch (error) {
		diagContent.textContent = "Diagnostics failed: " + error.message;
	}
}

refresh();

async function refresh() {
	const state = await archiveFs.getState();
	if (!state.configured) {
		folderStatus.innerHTML = "<span class='status-warn'>No folder selected yet.</span> Pick the folder where session folders and saved pages should live.";
		grantButton.hidden = true;
	} else if (state.permission != "granted") {
		folderStatus.innerHTML = `Folder <strong></strong> is selected but <span class='status-warn'>access must be re-granted</span> (Chrome revokes it after a restart unless allowed permanently).`;
		folderStatus.querySelector("strong").textContent = state.folderName;
		grantButton.hidden = false;
	} else {
		folderStatus.innerHTML = "<span class='status-ok'>Connected:</span> saving pages into <strong></strong>.";
		folderStatus.querySelector("strong").textContent = state.folderName;
		grantButton.hidden = true;
	}
	await refreshQueue();
}

async function chooseFolder() {
	try {
		const handle = await window.showDirectoryPicker({ id: "auto-archive", mode: "readwrite", startIn: "downloads" });
		await archiveFs.setFolderHandle(handle);
		await chrome.runtime.sendMessage({ method: "autoArchive.folderChanged" });
	} catch (error) {
		if (error.name != "AbortError") {
			folderStatus.textContent = "Could not select folder: " + error.message;
			return;
		}
	}
	await refresh();
}

async function grantAccess() {
	await archiveFs.requestFolderPermission();
	await chrome.runtime.sendMessage({ method: "autoArchive.folderChanged" });
	await refresh();
}

async function refreshQueue() {
	const state = await archiveFs.getState();
	if (state.configured && state.permission == "granted") {
		const { session } = await chrome.runtime.sendMessage({ method: "autoArchive.getSession" }) || {};
		if (session) {
			const text = await archiveFs.readTextFile(session, archiveFs.SESSION_FILE);
			queueContent.textContent = `— ${session}/session.txt —\n` + (text.trim() ? text : "(no pages visited yet this session)");
		} else {
			queueContent.textContent = "(session starts with the first page you visit)";
		}
	} else {
		queueContent.textContent = "(no folder selected)";
	}
}

async function runQueue() {
	runQueueButton.disabled = true;
	try {
		const result = await chrome.runtime.sendMessage({ method: "autoArchive.processQueue" });
		queueContent.textContent = "Queue run started" +
			(result && result.processed !== undefined ? ` — ${result.processed} URL(s) being saved.` : ".");
		setTimeout(refreshQueue, 3000);
	} finally {
		runQueueButton.disabled = false;
	}
}
