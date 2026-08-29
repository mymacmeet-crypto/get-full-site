/*
 * Web Archiver — turning a captured page into Markdown.
 *
 * A port of the crawler's src/markdown.js. Same rules, same output shape; the
 * only thing that changed is what does the parsing. The crawler loads the HTML
 * into cheerio because it has no browser; this runs in the extension's
 * offscreen document, which has a real DOM, so every cheerio call became the
 * DOM method it was imitating. The selectors, the thresholds and the Turndown
 * configuration are deliberately identical — the two have to produce the same
 * corpus, and a rule that exists in one and not the other is a bug that only
 * shows up as a strange retrieval result months later.
 *
 * The HTML it converts is the page as the content script preprocessed it,
 * *before* SingleFile inlines assets. That ordering matters: links and images
 * still carry real URLs at that point rather than megabytes of base64.
 *
 * TurndownService and turndownPluginGfm arrive as globals from the two vendored
 * UMD bundles that offscreen-document.html loads. Importing them instead would
 * mean teaching the fork's rollup config to resolve node_modules for this entry
 * point, and a <script> tag costs nothing here.
 */

/* global DOMParser, URL */

/**
 * Elements that never carry page content, removed before anything else looks
 * at the document. `template` matters more than it appears: its contents are
 * inert markup the page may never have rendered, and Turndown cannot tell.
 */
const NON_CONTENT = [
	"script",
	"style",
	"noscript",
	"template",
	"link",
	"meta",
	"svg",
	"canvas",
	"iframe",
	"object",
	"embed",
	"form",
	"input",
	"button",
	"select",
	"textarea"
].join(",");

/**
 * Site chrome: the same words on every page of the site.
 *
 * Left in, these dominate a retrieval corpus — every document matches a query
 * about the nav rather than about its own subject.
 *
 * `header` is deliberately absent from the bare-tag entries. Inside an article
 * it is usually the title block, which is content; the *page* header sits
 * outside the content root picked below and is dropped by that instead.
 */
const CHROME = [
	"nav",
	"aside",
	"footer",
	"[role=\"navigation\"]",
	"[role=\"banner\"]",
	"[role=\"complementary\"]",
	"[role=\"contentinfo\"]",
	"[role=\"search\"]",
	"[aria-hidden=\"true\"]",
	"header.header",
	".nav",
	".navbar",
	".navigation",
	".menu",
	".breadcrumb",
	".breadcrumbs",
	".sidebar",
	".site-header",
	".site-footer",
	".skip-link",
	".cookie",
	".cookie-banner",
	".cookie-consent",
	"#cookie-banner",
	"#onetrust-consent-sdk",
	".social-share",
	".share-buttons"
].join(",");

/**
 * Where a page's own content lives, most explicit signal first.
 *
 * `main` and `[role="main"]` are the author telling us directly. `article` is
 * next because a page with one article is that article. The class and id
 * guesses below them are conventions, not standards, so they are a fallback
 * rather than the rule — and `body` is the honest last resort.
 */
const CONTENT_ROOTS = [
	"main",
	"[role=\"main\"]",
	"article",
	"#main-content",
	"#main",
	"#content",
	".main-content",
	".post-content",
	".entry-content",
	".article-body"
];

/**
 * A content root has to actually hold the content.
 *
 * Some templates ship an empty <main> and render the article beside it. Taking
 * it on faith yields an empty document that still looks like a success, so a
 * candidate is only accepted when it carries a real amount of the page's text.
 */
const MIN_ROOT_TEXT_LENGTH = 200;
const MIN_ROOT_TEXT_SHARE = 0.25;

/**
 * Elements that cannot sit inside a Markdown link.
 *
 * A card on a listing page is usually one `<a>` wrapped around a heading, a
 * summary and an image. Turndown emits the link delimiters where the anchor
 * opens and closes, so those land on their own lines with blocks between them:
 *
 *   ](https://example.com/blog/post)[
 *
 * That is not ugly Markdown, it is broken Markdown — a stray bracket that
 * swallows whatever follows. Every card listing produces one per card.
 */
const BLOCK_LEVEL = [
	"address",
	"article",
	"aside",
	"blockquote",
	"div",
	"dl",
	"figure",
	"footer",
	"form",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hr",
	"main",
	"nav",
	"ol",
	"p",
	"pre",
	"section",
	"table",
	"ul"
].join(",");

const HEADINGS = "h1,h2,h3,h4,h5,h6";

export {
	htmlToMarkdown,
	looksLikeMarkdown,
	isMarkdownAvailable,
	CONTENT_ROOTS
};

function textLength(node) {
	return node ? (node.textContent || "").replace(/\s+/g, " ").trim().length : 0;
}

/*
 * Every walk below snapshots its matches with Array.from before touching the
 * tree, because every one of them mutates it — removing chrome, dropping
 * sourceless images, unwrapping anchors. querySelectorAll is already static in
 * a browser, so this changes nothing there; it makes the intent explicit, and
 * it keeps the module working against any array-like the host hands back.
 */
function matches(root, selector) {
	return Array.from(root.querySelectorAll(selector));
}

function removeAll(root, selector) {
	for (const node of matches(root, selector)) {
		node.remove();
	}
}

/** Pick the element whose subtree is the page's own content. */
function findContentRoot(document) {
	const bodyLength = textLength(document.body);
	for (const selector of CONTENT_ROOTS) {
		const candidate = document.querySelector(selector);
		if (!candidate) {
			continue;
		}
		const length = textLength(candidate);
		// On a short page the share test is the meaningful one; on a long page the
		// absolute floor is. Requiring both would reject real content on a page
		// that happens to be mostly a big footer.
		const enough =
			length >= MIN_ROOT_TEXT_LENGTH ||
			(bodyLength > 0 && length / bodyLength >= MIN_ROOT_TEXT_SHARE);
		if (enough) {
			return candidate;
		}
	}
	return document.body || document.documentElement;
}

/**
 * Point every link and image at something that still resolves once the file is
 * a local .md.
 *
 * Relative URLs are made absolute against the page they came from — a Markdown
 * file two directories deep would otherwise resolve `/docs/x` against the
 * filesystem. Images inlined as data: URIs are dropped: they are the capture
 * engine's business, and a base64 payload in a text corpus is noise measured
 * in megabytes.
 */
function absolutizeUrls(root, pageUrl) {
	if (!pageUrl) {
		return;
	}
	const resolve = value => {
		try {
			return new URL(value, pageUrl).toString();
		} catch {
			return null;
		}
	};

	for (const link of matches(root, "a[href]")) {
		const href = link.getAttribute("href");
		if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) {
			continue;
		}
		const absolute = resolve(href);
		if (absolute) {
			link.setAttribute("href", absolute);
		}
	}

	for (const image of matches(root, "img")) {
		// srcset never survives the conversion, and leaving it lets a later reader
		// think the Markdown lost a resolution it never actually had.
		image.removeAttribute("srcset");
		image.removeAttribute("loading");
		const source = image.getAttribute("src");
		if (!source || /^data:/i.test(source)) {
			image.remove();
			continue;
		}
		const absolute = resolve(source);
		if (absolute) {
			image.setAttribute("src", absolute);
		}
	}
}

/**
 * Rewrite anchors that wrap block content into something Markdown can express.
 *
 * The link moves onto the card's heading, which is where a reader would expect
 * it and what keeps the destination attached to the thing it names. A card
 * with no heading gets the link appended after its content instead, so the URL
 * is never simply dropped.
 */
function unwrapBlockAnchors(document, root) {
	// querySelectorAll is a static list in document order, so an outer anchor is
	// handled before any nested one — and unwrapping the outer one only moves
	// the inner node up a level, leaving it live for its own turn.
	for (const anchor of matches(root, "a[href]")) {
		if (!anchor.querySelector(BLOCK_LEVEL)) {
			continue; // an ordinary inline link
		}
		const href = anchor.getAttribute("href");
		const heading = anchor.querySelector(HEADINGS);

		if (heading) {
			const link = document.createElement("a");
			link.setAttribute("href", href);
			link.append(...Array.from(heading.childNodes));
			heading.replaceChildren(link);
		} else if (anchor.textContent.trim()) {
			const trailing = document.createElement("p");
			const link = document.createElement("a");
			link.setAttribute("href", href);
			link.textContent = href;
			trailing.appendChild(link);
			anchor.appendChild(trailing);
		}

		// Snapshot the children: replaceWith consumes the list as it goes, and a
		// live NodeList would drop every second node.
		anchor.replaceWith(...Array.from(anchor.childNodes));
	}
}

/**
 * Drop `title` attributes that only repeat the link text.
 *
 * Turndown renders them as `[Valtech](https://... "Valtech")`. The title is
 * real information when it differs from the text and pure duplication when it
 * does not — and on a site that sets it from the link text, that is every
 * single link in the corpus.
 */
function dropEchoedTitles(root) {
	for (const node of matches(root, "a[title], img[title]")) {
		const title = (node.getAttribute("title") || "").trim();
		if (!title) {
			continue;
		}
		const label = (node.tagName == "IMG" ? node.getAttribute("alt") || "" : node.textContent).trim();
		if (title === label) {
			node.removeAttribute("title");
		}
	}
}

/** A Turndown instance configured once and reused for the whole session. */
function createTurndown() {
	const service = new globalThis.TurndownService({
		headingStyle: "atx",
		hr: "---",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
		fence: "```",
		emDelimiter: "_",
		strongDelimiter: "**",
		linkStyle: "inlined"
	});
	service.use(globalThis.turndownPluginGfm.gfm);

	// An image with no source left after absolutizeUrls is a spacer or an icon,
	// not a picture of anything: "![]()" is pure noise in a corpus.
	service.addRule("dropSourcelessImages", {
		filter: node => node.nodeName === "IMG" && !node.getAttribute("src"),
		replacement: () => ""
	});

	// A link left with nothing inside it — typically an icon link whose only
	// child was an inlined data: image that absolutizeUrls removed. "[](url)" in
	// the middle of a sentence is noise that also breaks the sentence.
	service.addRule("dropEmptyLinks", {
		filter: node =>
			node.nodeName === "A" &&
			node.getAttribute("href") &&
			!node.textContent.trim() &&
			node.getElementsByTagName("img").length === 0,
		replacement: () => ""
	});

	// Turndown keeps <figcaption> as a bare paragraph glued to the image above
	// it. An explicit blank line is what makes the caption read as a caption.
	service.addRule("figcaption", {
		filter: "figcaption",
		replacement: content => (content.trim() ? `\n\n${content.trim()}\n\n` : "")
	});

	return service;
}

let turndown = null;

/**
 * Clean up the gaps that stripping elements leaves behind: runs of blank
 * lines, and the double spaces left where a removed inline image sat between
 * two words ("and  and").
 *
 * The space collapsing skips fenced code blocks and indented lines, where
 * whitespace is content rather than accident.
 */
function tidy(markdown) {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	let inFence = false;
	const cleaned = lines.map(line => {
		if (/^\s{0,3}(```|~~~)/.test(line)) {
			inFence = !inFence;
			return line.replace(/[ \t]+$/, "");
		}
		if (inFence || /^(\s{4,}|\t)/.test(line)) {
			return line.replace(/[ \t]+$/, "");
		}
		return line.replace(/(\S) {2,}(?=\S)/g, "$1 ").replace(/[ \t]+$/, "");
	});
	return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Whether the vendored Turndown bundles actually loaded. */
function isMarkdownAvailable() {
	return Boolean(globalThis.TurndownService && globalThis.turndownPluginGfm);
}

/**
 * Convert a page's rendered HTML to Markdown.
 *
 * `fullPage` keeps the whole document including chrome, for the caller who
 * would rather have the nav than risk the extraction picking the wrong root.
 *
 * Returns '' for a document with no usable content rather than throwing: one
 * page that converts to nothing is a page worth reporting, not a reason to
 * abandon the capture that produced it.
 */
function htmlToMarkdown(html, { pageUrl = null, fullPage = false, title = null } = {}) {
	if (!html || !html.trim() || !isMarkdownAvailable()) {
		return "";
	}

	const document = new DOMParser().parseFromString(html, "text/html");
	removeAll(document, NON_CONTENT);

	const root = fullPage ? (document.body || document.documentElement) : findContentRoot(document);
	if (!fullPage) {
		// Scoped to the content root, so chrome *inside* the article — a "share
		// this" widget, an inline nav — goes, while the surrounding page was
		// already excluded by the choice of root itself.
		removeAll(root, CHROME);
	}

	absolutizeUrls(root, pageUrl);
	unwrapBlockAnchors(document, root);
	dropEchoedTitles(root);

	turndown = turndown || createTurndown();
	const markdown = tidy(turndown.turndown(root.innerHTML || ""));
	if (!markdown) {
		return "";
	}

	// A content root that held no heading loses the page's title entirely, since
	// <title> lives in the <head> that was never part of that root.
	if (title && !/^#\s/.test(markdown)) {
		return `# ${title.trim()}\n\n${markdown}`;
	}
	return markdown;
}

/**
 * Does this response body look like Markdown rather than an HTML page?
 *
 * A site with no `<path>.md` usually answers the request with its own 404
 * page, at HTTP 200, in HTML. Writing that to disk as blog.md would fill the
 * corpus with "Page not found" documents that look perfectly successful.
 */
function looksLikeMarkdown(text, contentType = "") {
	if (!text || !text.trim()) {
		return false;
	}
	if (/^text\/html/i.test(contentType)) {
		return false;
	}
	if (/^\s*(<!doctype\b|<html\b|<head\b|<body\b)/i.test(text)) {
		return false;
	}
	return true;
}
