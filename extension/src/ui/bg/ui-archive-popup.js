/*
 * Auto Archiver — toolbar popup: lists the pages archived from the current
 * tab (kept in chrome.storage.session by the background) and offers a manual
 * "Save now" for the visible page.
 */

/* global chrome, document */

const STATUS_ICONS = {
	queued: "🕓",
	downloading: "⬇️",
	downloaded: "✅",
	failed: "⚠️"
};

const historyList = document.getElementById("historyList");
const saveNowButton = document.getElementById("saveNowButton");
const setupLink = document.getElementById("setupLink");

saveNowButton.addEventListener("click", async () => {
	saveNowButton.disabled = true;
	saveNowButton.textContent = "Saving…";
	await chrome.runtime.sendMessage({ method: "autoArchive.saveNow" });
	setTimeout(refresh, 1500);
	setTimeout(() => {
		saveNowButton.disabled = false;
		saveNowButton.textContent = "Save now";
	}, 1500);
});

setupLink.addEventListener("click", () => {
	chrome.tabs.create({ active: true, url: "/src/ui/pages/auto-archive.html" });
});

document.getElementById("healthLink").addEventListener("click", () => {
	chrome.tabs.create({ active: true, url: "/src/ui/pages/archive-health.html" });
});

refresh();
setInterval(refresh, 2000);

async function refresh() {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	const { autoArchiveTabHistory } = await chrome.storage.session.get("autoArchiveTabHistory");
	const entries = ((autoArchiveTabHistory || {})[tab && tab.id] || []).slice().reverse();
	historyList.textContent = "";
	if (!entries.length) {
		const item = document.createElement("li");
		item.className = "empty";
		item.textContent = "Nothing archived from this tab yet.";
		historyList.appendChild(item);
		return;
	}
	for (const entry of entries) {
		const item = document.createElement("li");
		const icon = document.createElement("span");
		icon.textContent = STATUS_ICONS[entry.status] || "•";
		const file = document.createElement("span");
		file.className = "file";
		file.textContent = entry.filename || "(pending)";
		const url = document.createElement("span");
		url.className = "url";
		url.textContent = entry.url;
		file.appendChild(url);
		const time = document.createElement("span");
		time.className = "time";
		time.textContent = new Date(entry.time).toLocaleTimeString();
		item.append(icon, file, time);
		historyList.appendChild(item);
	}
}
