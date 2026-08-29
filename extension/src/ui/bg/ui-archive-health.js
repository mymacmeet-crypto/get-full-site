/*
 * Web Archiver — health & performance page. Combines machine-wide readings
 * (chrome.system.cpu / chrome.system.memory) with the extension's own
 * workload metrics served by the background (autoArchive.getHealth).
 */

/* global chrome, document */

const verdictElement = document.getElementById("verdict");
const cardsElement = document.getElementById("cards");
const warningsElement = document.getElementById("warnings");

refresh();
setInterval(refresh, 5000);

function formatBytes(bytes) {
	if (bytes == null) {
		return "n/a";
	}
	if (bytes > 1024 * 1024 * 1024) {
		return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
	}
	if (bytes > 1024 * 1024) {
		return (bytes / (1024 * 1024)).toFixed(1) + " MB";
	}
	return Math.round(bytes / 1024) + " KB";
}

async function sampleCpu() {
	const read = async () => {
		const info = await chrome.system.cpu.getInfo();
		return info.processors.map(processor => processor.usage);
	};
	const first = await read();
	await new Promise(resolve => setTimeout(resolve, 800));
	const second = await read();
	let busy = 0, total = 0;
	for (let i = 0; i < first.length; i++) {
		const totalDelta = second[i].total - first[i].total;
		const idleDelta = second[i].idle - first[i].idle;
		if (totalDelta > 0) {
			busy += (totalDelta - idleDelta) / totalDelta;
			total++;
		}
	}
	return total ? Math.round((busy / total) * 100) : null;
}

function card(title, value, sub) {
	const element = document.createElement("div");
	element.className = "card";
	const heading = document.createElement("h2");
	heading.textContent = title;
	const valueElement = document.createElement("div");
	valueElement.className = "value";
	valueElement.textContent = value;
	const subElement = document.createElement("div");
	subElement.className = "sub";
	subElement.textContent = sub || "";
	element.append(heading, valueElement, subElement);
	return element;
}

async function refresh() {
	try {
		const [health, memoryInfo, cpuPercent] = await Promise.all([
			chrome.runtime.sendMessage({ method: "autoArchive.getHealth" }),
			chrome.system.memory.getInfo(),
			sampleCpu()
		]);
		const metrics = health.metrics || {};
		const durations = metrics.durations || [];
		const averageDuration = durations.length
			? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null;
		const pending = (health.statusCounts.QUEUE || 0) + (health.statusCounts.INPROGRESS || 0);
		const ramAvailablePercent = Math.round((memoryInfo.availableCapacity / memoryInfo.capacity) * 100);
		const heap = health.offscreenMemory && health.offscreenMemory.jsHeapUsed;
		const drift = health.offscreenMemory && health.offscreenMemory.tickerDriftMs;

		cardsElement.textContent = "";
		cardsElement.append(
			card("Pages saved (session)", String(metrics.saves || 0), (metrics.failures || 0) + " failed attempts"),
			card("Pending in queue", String(pending), (health.statusCounts.FAILED || 0) + " gave up (FAILED)"),
			card("Data written", formatBytes(metrics.totalBytes || 0),
				metrics.largest ? "largest: " + metrics.largest.filename + " (" + formatBytes(metrics.largest.bytes) + ")" : ""),
			card("Avg save time", averageDuration != null ? (averageDuration / 1000).toFixed(1) + " s" : "n/a",
				"last " + durations.length + " saves"),
			card("System CPU", cpuPercent != null ? cpuPercent + " %" : "n/a", "all processes, not just Chrome"),
			card("System RAM free", ramAvailablePercent + " %", formatBytes(memoryInfo.availableCapacity) + " of " + formatBytes(memoryInfo.capacity)),
			card("Extension heap", formatBytes(heap), "archiver's own memory"),
			card("Worker lag", drift != null ? drift + " ms" : "n/a", "extension event-loop delay"),
			card("Poller", health.lastPollAgeMs != null ? Math.round(health.lastPollAgeMs / 1000) + " s ago" : "never",
				health.alarmScheduled ? "backstop alarm scheduled" : "NO ALARM"),
			card("Build / session", health.build, health.session || "no session yet")
		);

		const warnings = [];
		if (!health.folderState.configured) {
			warnings.push({ bad: true, text: "No archive folder selected — nothing is being saved." });
		} else if (health.folderState.permission != "granted") {
			warnings.push({ bad: true, text: "Folder access lost — re-grant it on the setup page." });
		}
		if (health.lastPollAgeMs == null || health.lastPollAgeMs > 45000) {
			warnings.push({ bad: true, text: "Queue poller looks stalled (no poll in the last 45 s)." });
		}
		if (pending > 10) {
			warnings.push({ text: "Backlog of " + pending + " pending pages — saves may be falling behind your browsing." });
		}
		if (metrics.saves + metrics.failures > 5 && metrics.failures / (metrics.saves + metrics.failures) > 0.2) {
			warnings.push({ text: "More than 20% of save attempts are failing — check debug.log." });
		}
		if (averageDuration != null && averageDuration > 10000) {
			warnings.push({ text: "Saves average over 10 s — heavy pages or a slow disk." });
		}
		if (heap != null && heap > 400 * 1024 * 1024) {
			warnings.push({ text: "Extension heap above 400 MB — a restart of Chrome would clear it." });
		}
		if (drift != null && drift > 250) {
			warnings.push({ text: "Extension event loop is lagging (" + drift + " ms) — likely a very large save in progress." });
		}
		if (ramAvailablePercent < 10) {
			warnings.push({ text: "System RAM is nearly full (machine-wide — not necessarily the archiver's fault)." });
		}

		const bad = warnings.some(warning => warning.bad);
		verdictElement.className = bad ? "bad" : warnings.length ? "warn" : "ok";
		verdictElement.textContent = bad ? "✖ Unhealthy — the archiver is not working right now"
			: warnings.length ? "⚠ Working, with warnings" : "✔ Healthy — archiving normally, no strain detected";
		warningsElement.textContent = "";
		if (!warnings.length) {
			const item = document.createElement("li");
			item.className = "muted";
			item.textContent = "Nothing to report. Saves are flowing and resource usage is normal.";
			warningsElement.appendChild(item);
		} else {
			for (const warning of warnings) {
				const item = document.createElement("li");
				item.textContent = warning.text;
				warningsElement.appendChild(item);
			}
		}
	} catch (error) {
		verdictElement.className = "bad";
		verdictElement.textContent = "✖ Could not reach the extension background: " + error.message;
	}
}
