'use strict';

/**
 * The header every Markdown document in the corpus carries.
 *
 *   ---
 *   title: "Essentials by AAI: Car Insurance & Home Insurance"
 *   url: "https://www.essentialsbyaai.com.au/"
 *   fetched: 2026-08-30
 *   method: "Downloaded"
 *   ---
 *
 * Four things a reader of a bare .md file cannot otherwise recover: what the
 * page was called, where it came from, when, and whether this is the document
 * the site published or one we made from its rendered DOM. That last field is
 * the one worth having: the two are not equally trustworthy, and by the time a
 * file is sitting in a corpus there is nothing else left to tell them apart.
 *
 * There are four places a .md file gets written - the crawler's two sources and
 * the extension's two save pipelines - so the block is composed here and only
 * here. Four implementations of the same header would agree on the day they
 * were written and drift by the end of the month.
 *
 * Values are always quoted and the date never is. `yamlValue`-style conditional
 * quoting is correct YAML and produces a file whose header looks different for
 * every page depending on whether the title happens to contain a colon; a
 * corpus is easier to trust when every document's header has the same shape.
 */

/** The site published this document itself, at `<path>.md`. */
const METHOD_DOWNLOADED = 'Downloaded';
/** We made it, from the page's rendered DOM. */
const METHOD_CONVERTED = 'Converted';

/**
 * Today, in the machine's own timezone.
 *
 * `toISOString().slice(0, 10)` would be UTC, which east of Greenwich stamps
 * yesterday's date on anything archived before the offset has elapsed - for a
 * user at UTC+5:30 that is every crawl started before half past five in the
 * morning.
 */
function today(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Quote a value as a double-quoted YAML scalar.
 *
 * Backslashes first: escaping the quotes first would then have their own
 * backslashes escaped a second time.
 */
function quote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s*\n\s*/g, ' ').trim()}"`;
}

/**
 * The front matter block, as text ending in a newline.
 *
 * Field order is fixed rather than following the object's keys, so two
 * documents never differ only in how their headers are arranged. A field with
 * no value is omitted entirely - `title: ""` claims the page had an empty
 * title, which is a different thing from not knowing it.
 */
function buildFrontMatter({ title, description, url, fetched, method } = {}) {
  const lines = ['---'];
  if (title) lines.push(`title: ${quote(title)}`);
  if (description) lines.push(`description: ${quote(description)}`);
  if (url) lines.push(`url: ${quote(url)}`);
  lines.push(`fetched: ${fetched || today()}`);
  if (method) lines.push(`method: ${quote(method)}`);
  lines.push('---');
  return `${lines.join('\n')}\n`;
}

/**
 * Put the block in front of a document, replacing one that is already there.
 *
 * A document the site published may arrive with front matter of its own, and
 * two `---` blocks in one file is not a document with extra metadata - it is a
 * document whose second block is body text. Ours wins because it is the one
 * that records where the file came from.
 */
function withFrontMatter(markdown, fields) {
  const body = stripFrontMatter(markdown || '');
  const header = buildFrontMatter(fields);
  return body ? `${header}\n${body}` : header.trimEnd();
}

/** Remove a leading front matter block, if the document opens with one. */
function stripFrontMatter(markdown) {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(markdown);
  return (match ? markdown.slice(match[0].length) : markdown).replace(/^\s+/, '');
}

module.exports = {
  METHOD_DOWNLOADED,
  METHOD_CONVERTED,
  buildFrontMatter,
  withFrontMatter,
  stripFrontMatter,
  today,
};
