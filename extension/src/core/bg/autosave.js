/*
 * Copyright 2010-2020 Gildas Lormeau
 * contact : gildas.lormeau <at> gmail.com
 * 
 * This file is part of SingleFile.
 *
 *   The code in this file is free software: you can redistribute it and/or 
 *   modify it under the terms of the GNU Affero General Public License 
 *   (GNU AGPL) as published by the Free Software Foundation, either version 3
 *   of the License, or (at your option) any later version.
 * 
 *   The code in this file is distributed in the hope that it will be useful, 
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of 
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero 
 *   General Public License for more details.
 *
 *   As additional permission under GNU AGPL version 3 section 7, you may 
 *   distribute UNMODIFIED VERSIONS OF THIS file without the copy of the GNU 
 *   AGPL normally required by section 4, provided you include this license 
 *   notice and a URL through which recipients can access the Corresponding 
 *   Source.
 */

/* global browser, chrome, fetch */

import * as config from "./config.js";
import * as business from "./business.js";
import * as companion from "./companion.js";
import * as downloads from "./downloads.js";
import * as tabsData from "./tabs-data.js";
import * as ui from "./../../ui/bg/index.js";
import * as woleet from "./../../lib/woleet/woleet.js";
import { autoSaveIsEnabled } from "./autosave-util.js";
import * as offscreen from "./offscreen.js";
import * as autoArchive from "./auto-archive.js";
import { wantsHtml, wantsMarkdown } from "./archive-settings.js";

const pendingMessages = {};
const replacedTabIds = {};

// mirror the archive status on the toolbar icon: 🕓 queued, ↓ saving, ✓ saved
const BADGES = {
	queued: { text: "🕓", color: "#F29900" },
	downloading: { text: "↓", color: "#1A73E8" },
	downloaded: { text: "✓", color: "#188038" },
	failed: { text: "!", color: "#D93025" }
};

function notifyArchiveStatus(tabId, status, url, filename) {
	browser.tabs.sendMessage(tabId, { method: "content.archiveStatus", status }).catch(() => { });
	const badge = BADGES[status];
	if (badge) {
		try {
			browser.action.setBadgeText({ tabId, text: badge.text });
			browser.action.setBadgeBackgroundColor({ tabId, color: badge.color });
		} catch {
			// tab already gone
		}
	}
	recordTabHistory(tabId, status, url, filename);
}

// per-tab save history shown by the toolbar popup; storage.session is shared
// with the popup page and clears when the browser closes
async function recordTabHistory(tabId, status, url, filename) {
	try {
		if (!url) {
			return;
		}
		const { autoArchiveTabHistory } = await chrome.storage.session.get("autoArchiveTabHistory");
		const history = autoArchiveTabHistory || {};
		const list = history[tabId] || [];
		let entry = list.find(candidate => candidate.url == url);
		if (!entry) {
			entry = { url };
			list.push(entry);
		}
		entry.status = status;
		entry.time = Date.now();
		if (filename) {
			entry.filename = filename;
		}
		history[tabId] = list.slice(-15);
		await chrome.storage.session.set({ autoArchiveTabHistory: history });
	} catch {
		// history is best-effort only
	}
}

export {
	onMessage,
	onMessageExternal,
	onInit,
	onTabUpdated,
	onTabRemoved,
	onTabDiscarded,
	onTabReplaced
};

async function onMessage(message, sender) {
	if (message.method.endsWith(".save")) {
		if (message.autoSaveDiscard || message.autoSaveRemove) {
			if (sender.tab) {
				message.tab = sender.tab;
				pendingMessages[sender.tab.id] = message;
			} else if (pendingMessages[message.tabId] &&
				((pendingMessages[message.tabId].removed && message.autoSaveRemove) ||
					(pendingMessages[message.tabId].discarded && message.autoSaveDiscard))
			) {
				delete pendingMessages[message.tabId];
				await saveContent(message, { id: message.tabId, index: message.tabIndex, url: sender.url });
			}
			if (message.autoSaveUnload) {
				delete pendingMessages[message.tabId];
				await saveContent(message, sender.tab);
			}
		} else {
			delete pendingMessages[message.tabId];
			await saveContent(message, sender.tab);
		}
		return {};
	}
}

function onTabUpdated(tabId) {
	delete pendingMessages[tabId];
}

async function onTabRemoved(tabId) {
	const message = pendingMessages[tabId];
	if (message) {
		if (message.autoSaveRemove) {
			delete pendingMessages[tabId];
			await saveContent(message, message.tab);
		}
	} else {
		pendingMessages[tabId] = { removed: true };
	}
}

async function onTabDiscarded(tabId) {
	const message = pendingMessages[tabId];
	if (message) {
		delete pendingMessages[tabId];
		await saveContent(message, message.tab);
	} else {
		pendingMessages[tabId] = { discarded: true };
	}
}

async function onTabReplaced(addedTabId, removedTabId) {
	if (pendingMessages[removedTabId] && !pendingMessages[addedTabId]) {
		pendingMessages[addedTabId] = pendingMessages[removedTabId];
		delete pendingMessages[removedTabId];
		replacedTabIds[removedTabId] = addedTabId;
	}
}

async function onMessageExternal(message, currentTab) {
	if (message.method == "enableAutoSave") {
		const allTabsData = await tabsData.get(currentTab.id);
		allTabsData[currentTab.id].autoSave = message.enabled;
		await tabsData.set(allTabsData);
		ui.refreshTab(currentTab);
	}
	if (message.method == "isAutoSaveEnabled") {
		return autoSaveIsEnabled(currentTab);
	}
}

async function onInit(tab, message) {
	// prefer the content script's location.href: unlike tab.url it always
	// carries the #fragment part of the URL
	const pageUrl = (message && message.url) || tab.url;
	autoArchive.traceNavigation(pageUrl);
	if (autoArchive.isReplaying(pageUrl) || autoArchive.isReplaying(tab.url)) {
		// this tab was opened by the queue poller and is saved by its own task
		return;
	}
	const [options, autoSaveEnabled] = await Promise.all([config.getOptions(pageUrl, true), autoSaveIsEnabled(tab)]);
	if (options && ((options.autoSaveLoad || options.autoSaveLoadOrUnload) && autoSaveEnabled)) {
		// enqueue first: if the user navigates away before the save finishes,
		// the URL stays in session.txt as QUEUE and the poller retries it
		await autoArchive.onNavigation(pageUrl);
		notifyArchiveStatus(tab.id, "queued", pageUrl);
		business.saveTabs([tab], { autoSave: true });
	}
}

/**
 * Write one captured page into the session folder, in whichever formats the
 * popup asked for.
 *
 * The Markdown is converted from `options.content` — the DOM as the content
 * script preprocessed it — rather than from the captured file. At that point
 * links and images still carry real URLs; the captured file has replaced them
 * with inlined base64, which is exactly what a text corpus must not contain.
 *
 * A "both" save writes the HTML first and hands its *resolved* name to the
 * Markdown write. Uniquifying the two independently would put page_2.html
 * beside page.md and quietly break the correspondence between them.
 *
 * Returns the name and size to report to the popup, plus any pageData it had
 * to capture itself so the caller can still revoke that blob.
 */
async function writeToArchive(options, pageData, { wantHtml, wantMarkdown }) {
	const session = await autoArchive.getSession();
	const baseName = autoArchive.filenameForUrl(options.url);
	let filename = null, bytes = 0, captured = null;

	if (wantHtml && pageData) {
		const written = await offscreen.archiveWritePage(session, pageData.url, baseName);
		filename = written && written.filename;
		bytes = (written && written.bytes) || 0;
		autoArchive.debugLog("save: file written:", filename);
	}

	if (wantMarkdown) {
		const markdown = await toMarkdown(options, pageData);
		if (markdown) {
			const markdownName = (filename || baseName).replace(/\.html?$/i, "") + ".md";
			const written = await offscreen.archiveWriteMarkdown(session, markdown, markdownName, { unique: !filename });
			autoArchive.debugLog("save: markdown written:", written && written.filename);
			if (!filename) {
				filename = written && written.filename;
				bytes = (written && written.bytes) || 0;
			}
		} else if (!wantHtml) {
			// Nothing converted, and no HTML was asked for. Writing the capture is
			// better than writing nothing: a page that converts to an empty document
			// is worth having in some form rather than silently dropping.
			autoArchive.debugLog("save: no markdown for", options.url, "— falling back to HTML");
			captured = pageData || await offscreen.processPage(options);
			const written = await offscreen.archiveWritePage(session, captured.url, baseName);
			filename = written && written.filename;
			bytes = (written && written.bytes) || 0;
		}
	}

	return { filename, bytes, pageData: captured };
}

async function toMarkdown(options, pageData) {
	try {
		const result = await offscreen.archiveToMarkdown(options.content, options.url, pageData && pageData.title);
		if (result && result.source == "native") {
			autoArchive.debugLog("save: using the site's own .md for", options.url);
		}
		return (result && result.markdown) || "";
	} catch (error) {
		// A failed conversion must not fail the save: the HTML half of a "both"
		// run is already on disk, and an md-only run falls back to writing it.
		autoArchive.debugLog("save: markdown conversion failed for", options.url, "—", error.message);
		return "";
	}
}

async function saveContent(message, tab) {
	const tabId = tab.id;
	const options = await config.getOptions(tab.url, true);
	if (options) {
		ui.onStart(tabId, 1, true);
		options.content = message.content;
		options.url = message.url;
		options.frames = message.frames;
		options.canvases = message.canvases;
		options.fonts = message.fonts;
		options.stylesheets = message.stylesheets;
		options.images = message.images;
		options.posters = message.posters;
		options.videos = message.videos;
		options.usedFonts = message.usedFonts;
		options.shadowRoots = message.shadowRoots;
		options.referrer = message.referrer;
		options.updatedResources = message.updatedResources;
		options.worklets = message.worklets;
		options.adoptedStyleSheets = message.adoptedStyleSheets;
		options.visitDate = new Date(message.visitDate);
		options.backgroundTab = true;
		options.autoSave = true;
		options.incognito = tab.incognito;
		options.tabId = tabId;
		options.tabIndex = tab.index;
		let pageData, writtenFilename, writtenBytes;
		const saveStartTime = Date.now();
		autoArchive.debugLog("save: processing content of", options.url);
		autoArchive.markInProgress(options.url);
		notifyArchiveStatus(tabId, "downloading", options.url);
		try {
			if (options.autoSaveExternalSave) {
				await companion.externalSave(options);
			} else {
				const archiveReady = await autoArchive.isReady();
				const [wantHtml, wantMarkdown] = await Promise.all([wantsHtml(), wantsMarkdown()]);
				const cloudDestination = Boolean(options.saveToGDrive || options.saveWithWebDAV || options.saveWithMCP ||
					options.saveToGitHub || options.saveToDropbox || options.saveWithCompanion ||
					options.saveToRestFormApi || options.saveToS3);
				// Markdown on its own needs no capture. It is converted from the DOM
				// the content script already sent, so running the capture — inlining
				// every image, font and stylesheet into one file — would produce a
				// blob nothing then writes. On a media-heavy page that is most of the
				// time the save takes.
				// Cloud destinations and the Downloads fallback both want the file
				// itself, so either of those still forces the capture.
				const needsCapture = cloudDestination || !archiveReady || wantHtml || !wantMarkdown;
				if (needsCapture) {
					pageData = await offscreen.processPage(options);
				}
				let skipped;
				if (!archiveReady && !cloudDestination) {
					const testSkip = await downloads.testSkipSave(pageData.filename, options);
					skipped = testSkip.skipped;
					options.filenameConflictAction = testSkip.filenameConflictAction;
				}
				if (!skipped) {
					if (options.saveToGDrive) {
						const content = await (await fetch(pageData.url)).blob();
						await downloads.saveToGDrive(message.taskId, downloads.encodeSharpCharacter(pageData.filename), content, {
							forceWebAuthFlow: options.forceWebAuthFlow
						}, {
							filenameConflictAction: options.filenameConflictAction
						});
					} else if (options.saveToDropbox) {
						const content = await (await fetch(pageData.url)).blob();
						await downloads.saveToDropbox(message.taskId, downloads.encodeSharpCharacter(pageData.filename), content, {
							filenameConflictAction: options.filenameConflictAction
						});
					} else if (options.saveWithWebDAV) {
						const content = await (await fetch(pageData.url)).blob();
						await downloads.saveWithWebDAV(message.taskId, downloads.encodeSharpCharacter(pageData.filename), content, options.webDAVURL, options.webDAVUser, options.webDAVPassword, {
							filenameConflictAction: options.filenameConflictAction
						});
					} else if (options.saveWithMCP) {
						const content = await (await fetch(pageData.url)).blob();
						await downloads.saveWithMCP(message.taskId, downloads.encodeSharpCharacter(pageData.filename), content, options.mcpServerUrl, options.mcpAuthToken, {
							filenameConflictAction: options.filenameConflictAction
						});
					} else if (options.saveToGitHub) {
						const content = await (await fetch(pageData.url)).blob();
						await (await downloads.saveToGitHub(message.taskId, downloads.encodeSharpCharacter(pageData.filename), content, options.githubToken, options.githubUser, options.githubRepository, options.githubBranch, {
							filenameConflictAction: options.filenameConflictAction
						})).pushPromise;
					} else if (options.saveWithCompanion && !options.compressContent) {
						const content = await (await fetch(pageData.url)).text();
						await companion.save({
							filename: pageData.filename,
							content: content,
							title: pageData.title,
							url: options.url,
							filenameConflictAction: options.filenameConflictAction
						});
					} else if (options.saveToRestFormApi) {
						const content = await (await fetch(pageData.url)).blob();
						await downloads.saveToRestFormApi(
							message.taskId,
							pageData.filename,
							content,
							options.url,
							options.saveToRestFormApiToken,
							options.saveToRestFormApiUrl,
							options.saveToRestFormApiFileFieldName,
							options.saveToRestFormApiUrlFieldName
						);
					} else if (options.saveToS3) {
						const content = await (await fetch(pageData.url)).blob();
						await downloads.saveToS3(
							message.taskId,
							pageData.filename,
							content,
							options.S3Domain,
							options.S3Region,
							options.S3Bucket,
							options.S3AccessKey,
							options.S3SecretKey,
							{ filenameConflictAction: options.filenameConflictAction }
						);
					} else if (archiveReady) {
						const written = await writeToArchive(options, pageData, { wantHtml, wantMarkdown });
						writtenFilename = written.filename;
						writtenBytes = written.bytes;
						// the fallback below may have had to capture after all, and the
						// blob it produced still needs revoking in the finally block
						pageData = written.pageData || pageData;
					} else {
						autoArchive.debugLog("save: archive folder not ready, falling back to Downloads for", options.url);
						await downloads.downloadPage(pageData, options);
					}
					if (options.openSavedPage && pageData) {
						const createTabProperties = { active: true, url: "/src/ui/pages/viewer.html?compressed=true&blobURI=" + pageData.url, windowId: tab.windowId };
						const index = tab.index;
						try {
							await browser.tabs.get(tabId);
							createTabProperties.index = index + 1;
							// eslint-disable-next-line no-unused-vars
						} catch (error) {
							createTabProperties.index = index;
						}
						browser.tabs.create(createTabProperties);
					}
					if (pageData && pageData.hash) {
						await woleet.anchor(pageData.hash, options.woleetKey);
					}
				}
			}
			await autoArchive.markSaved(options.url);
			notifyArchiveStatus(tabId, "downloaded", options.url, writtenFilename);
			autoArchive.recordSaveMetric({ durationMs: Date.now() - saveStartTime, bytes: writtenBytes, filename: writtenFilename, ok: true });
		} catch (error) {
			autoArchive.debugLog("save FAILED for", options.url, "—", error.message);
			autoArchive.markFailedAttempt(options.url);
			notifyArchiveStatus(tabId, "failed", options.url);
			autoArchive.recordSaveMetric({ ok: false });
			throw error;
		} finally {
			if (message.taskId) {
				business.onSaveEnd(message.taskId);
			} else if (options.autoClose) {
				browser.tabs.remove(replacedTabIds[tabId] || tabId);
				delete replacedTabIds[tabId];
			}
			if (pageData && pageData.url && !options.openSavedPage) {
				offscreen.revokeObjectURL(pageData.url);
			}
			ui.onEnd(tabId, true);
		}
	}
}