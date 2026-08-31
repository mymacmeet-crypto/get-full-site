/*
 * Web Archiver — the site's own Markdown, when it publishes any.
 *
 * A port of the crawler's src/native-md.js, with its per-crawl state made
 * per-host instead. Edge Delivery Services sites — aem.live and everything
 * built on it — serve `<path>.md` beside every page: the authored source,
 * without the nav, the footer or the lossy trip through HTML. When a site
 * offers that, taking it beats converting the page ourselves.
 *
 * Almost every other site on the web offers nothing at that URL, so the cost
 * of asking has to be bounded. It is asked once per host: the first page of a
 * host probes, and a miss switches every later page on that host to conversion
 * rather than paying a wasted round trip each time. A site that serves
 * Markdown for one page serves it for all of them.
 *
 * The crawler could keep that verdict for the length of one run. Here the
 * offscreen document is the longest-lived thing available and Chrome may
 * retire it at any point, so the verdicts are also mirrored into
 * chrome.storage.session — which survives that and clears when the browser
 * closes, which is exactly how long a "does this host publish Markdown"
 * answer is worth trusting.
 */

/* global chrome, AbortController, fetch, setTimeout, clearTimeout, URL */

import { looksLikeMarkdown } from "./archive-markdown.js";
import { cleanEdsMarkdown } from "./eds-markdown.js";

const STORAGE_KEY = "archiveNativeMarkdownHosts";
const PROBE_TIMEOUT_MS = 8 * 1000;

// host -> true (publishes Markdown) | false (does not). Absent means unknown.
let verdicts = null;
// host -> in-flight probe, so eight tabs of one host cost one request
const probes = new Map();

export {
	documentUrl,
	fetchNativeMarkdown
};

/**
 * The URL that would serve `pageUrl` as Markdown, or null when the question
 * does not apply.
 *
 * A query string is the disqualifying case: `/search?q=x` and `/search?q=y`
 * are different pages that would both ask for `/search.md`, so the same
 * document would be written for both. Converting each page's own DOM is the
 * only answer that stays correct there.
 */
function documentUrl(pageUrl) {
	let url;
	try {
		url = new URL(pageUrl);
	} catch {
		return null;
	}
	if (url.protocol != "http:" && url.protocol != "https:") {
		return null;
	}
	if (url.search) {
		return null;
	}

	// A trailing slash names a directory, whose document is its index — the
	// same rule the site's own routing uses.
	let pathname = url.pathname;
	if (pathname === "" || pathname.endsWith("/")) {
		pathname = `${pathname}index`;
	} else {
		pathname = pathname.replace(/\.(html?|xhtml)$/i, "");
	}
	url.pathname = `${pathname}.md`;
	url.hash = "";
	return url.toString();
}

async function loadVerdicts() {
	if (verdicts) {
		return verdicts;
	}
	try {
		const stored = await chrome.storage.session.get(STORAGE_KEY);
		verdicts = stored[STORAGE_KEY] || {};
	} catch {
		verdicts = {};
	}
	return verdicts;
}

async function recordVerdict(host, available) {
	const known = await loadVerdicts();
	known[host] = available;
	try {
		await chrome.storage.session.set({ [STORAGE_KEY]: known });
	} catch {
		// the in-memory copy still holds for this offscreen document's lifetime
	}
}

async function fetchOne(url) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		// credentials: the .md of a page behind a login has to come back as that
		// page, not as the sign-in screen
		const response = await fetch(url, { credentials: "include", signal: controller.signal });
		if (!response.ok) {
			return null;
		}
		const text = await response.text();
		// A 200 is not proof: a site with no such document usually answers with
		// its own HTML 404 page, which would otherwise be saved as the document.
		if (!looksLikeMarkdown(text, response.headers.get("content-type") || "")) {
			return null;
		}
		return text;
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * The cleaned authored Markdown for `pageUrl` as `{ markdown, fields }`, or
 * null when this site does not publish it — or publishes one too thin to stand
 * on its own, which is the signature of a listing page whose items the site
 * renders from an index. Both are the caller's cue to convert the captured DOM
 * instead.
 *
 * `fields` is what the document's own Metadata block said about itself: the
 * site knows its title and description better than the <title> tag does, so
 * those go into the front matter ahead of anything scraped.
 *
 * Never throws: a page with no Markdown is the ordinary case, not an error.
 */
async function fetchNativeMarkdown(pageUrl) {
	const target = documentUrl(pageUrl);
	if (!target) {
		return null;
	}
	const host = new URL(pageUrl).host;
	const known = await loadVerdicts();

	if (known[host] === false) {
		return null;
	}

	if (known[host] === undefined) {
		// The first page of this host probes and everyone else waits on that same
		// request rather than firing their own.
		if (!probes.has(host)) {
			probes.set(host, (async () => {
				const text = await fetchOne(target);
				await recordVerdict(host, text !== null);
				return { url: target, text };
			})().finally(() => probes.delete(host)));
		}
		const probed = await probes.get(host);
		// The page that did the probing already has its answer; the others fall
		// through to their own request now that the question is settled.
		if (probed.url === target) {
			return clean(probed.text, pageUrl);
		}
		if ((await loadVerdicts())[host] === false) {
			return null;
		}
	}

	return clean(await fetchOne(target), pageUrl);
}

function clean(text, pageUrl) {
	if (text === null || text === undefined) {
		return null;
	}
	const result = cleanEdsMarkdown(text);
	// An authored document that is mostly empty blocks describes a page the
	// site assembles at render time; the captured DOM is the better source for
	// that one even though this host publishes Markdown for the rest.
	if (result.thin || !result.markdown.trim()) {
		return null;
	}
	return { markdown: result.markdown, fields: result.fields, pageUrl };
}
