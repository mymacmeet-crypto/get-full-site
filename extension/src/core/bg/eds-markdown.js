/*
 * Web Archiver — cleaning the Markdown an Edge Delivery Services site publishes.
 *
 * A verbatim port of the crawler's src/eds-markdown.js: the file is pure string
 * processing with no Node dependencies, so the only change it needed to run in
 * the extension's offscreen document was the export syntax. Keeping it a copy
 * rather than a rewrite is the point — the crawler and the extension have to
 * produce the same corpus, and two implementations of this would drift.
 */

'use strict';

/**
 * Cleaning the Markdown an Edge Delivery Services site publishes.
 *
 * `<path>.md` on an EDS site is the *authoring* document, not a finished one.
 * Its prose is excellent - better than anything a conversion produces, because
 * it is what the author actually wrote - but it is wrapped in the block syntax
 * the authoring tools use: pandoc-style grid tables whose merged first row
 * names a component.
 *
 *   +-------------+          +------------------+
 *   | Feed (blog) |          | Section Metadata |
 *   +-------------+          +---------+--------+
 *   |             |          | style   | blog   |
 *   +-------------+          +---------+--------+
 *
 * Measured over www.aem.live's 183 documents, 30.8% of all lines were this box
 * drawing, every single file carried a Metadata block, and 161 carried Section
 * Metadata. In a retrieval corpus that is noise with a citation-shaped hole in
 * it: it costs tokens, it matches queries about nothing, and it hides the
 * prose.
 *
 * Deleting every box table would be a three-line fix and the wrong one. Some
 * of them are the content: docs/sidekick-errors.md is 91% box drawing and all
 * of it is a real error-code table. So the tables are parsed instead:
 *
 *   Metadata / Section Metadata  ->  lifted out; title and description become
 *                                    front matter, Nav/Footer/Template/Category
 *                                    are site configuration and are dropped
 *   a real data table            ->  a GFM table
 *   any other block              ->  unwrapped to its contents, the component
 *                                    name dropped
 *
 * What comes out is the author's document with the scaffolding taken off.
 */

/** A grid-table rule: `+-----+-----+`. */
const SEPARATOR = /^\s*\+[-=+]+\+\s*$/;
/** A grid-table content line: `| ... |`. */
const CELL_LINE = /^\s*\|.*\|\s*$/;

/**
 * The document-level block whose fields describe the page. Only this one feeds
 * the front matter: a Section Metadata block sets `style` for one section and
 * can carry its own `title`, which would otherwise shadow the page's.
 */
const METADATA_BLOCK = 'metadata';

/** Per-section rendering configuration. Never content, never metadata. */
const SECTION_METADATA_BLOCK = 'section metadata';

/**
 * Blocks that are site chrome wherever they appear.
 *
 * Named rather than guessed at: the first four are what a survey of
 * www.aem.live's 183 documents actually turned up - Pagination alone appears
 * in 74 of them, as a prev/next table - and the rest are the conventional
 * names for the same furniture on other Edge Delivery sites. Unwrapping these
 * would put "Previous / Up Next" into three quarters of the corpus.
 */
const CHROME_BLOCKS = new Set([
  'pagination',
  'gnav brand',
  'adobe logo',
  'doc search',
  'breadcrumb',
  'breadcrumbs',
  'nav',
  'navigation',
  'header',
  'footer',
  'search',
  'social',
  'social share',
  'share',
  'sidebar',
  'skip link',
  'language selector',
  'locale switcher',
  'cookie',
  'consent',
]);

/**
 * Metadata keys worth keeping. Everything else in the block - Nav, Footer,
 * Template, Category, Image, style - describes how the site renders the page,
 * not what the page says.
 */
const KEPT_METADATA = ['title', 'description'];

/** Is every line of this run part of one grid table? */
function isGridLine(line) {
  return SEPARATOR.test(line) || CELL_LINE.test(line);
}

/** Column edges of a rule line, as the character offsets of its `+`. */
function edges(rule) {
  const positions = [];
  for (let i = 0; i < rule.length; i++) {
    if (rule[i] === '+') positions.push(i);
  }
  return positions;
}

/**
 * Split one content line into cells at the column edges of the rule above it.
 *
 * Positional rather than `split('|')` on purpose: a nested table inside a cell
 * is itself full of pipes, and splitting on them would shred it. Slicing
 * between the edges hands the nested grid back verbatim, ready to recurse on.
 */
function splitCells(line, columnEdges) {
  const cells = [];
  for (let i = 0; i < columnEdges.length - 1; i++) {
    cells.push(line.slice(columnEdges[i] + 1, columnEdges[i + 1]));
  }
  return cells;
}

/**
 * Parse a run of grid-table lines into rows of cells.
 *
 * A row is the content lines between two rules, and its column layout comes
 * from the rule *above* it - which is what lets the merged single-cell row
 * that names a block sit above rows with a different column count.
 */
function parseGrid(lines) {
  const rows = [];
  let columnEdges = null;
  let pending = [];

  const flush = () => {
    if (pending.length === 0) return;
    const width = columnEdges ? columnEdges.length - 1 : 1;
    const cells = Array.from({ length: width }, () => []);
    for (const line of pending) {
      const parts = columnEdges ? splitCells(line, columnEdges) : [line.replace(/^\s*\||\|\s*$/g, '')];
      for (let i = 0; i < width; i++) cells[i].push(parts[i] === undefined ? '' : parts[i]);
    }
    // Trailing padding is an artefact of the box, never content; a blank line
    // inside a cell is a paragraph break and has to survive.
    rows.push(
      cells.map((cellLines) =>
        trimBlankEdges(dedent(cellLines.map((line) => line.replace(/\s+$/, '')))).join('\n')
      )
    );
    pending = [];
  };

  for (const line of lines) {
    if (SEPARATOR.test(line)) {
      flush();
      columnEdges = edges(line);
    } else if (CELL_LINE.test(line)) {
      pending.push(line);
    }
  }
  flush();
  return rows.filter((row) => row.some((cell) => cell.trim() !== ''));
}

/**
 * Remove the padding the box put on the left of every line of a cell.
 *
 * Uniform across the cell, so a nested grid inside it keeps its own columns
 * lined up - which matters, because that grid is re-parsed by the offsets of
 * its own `+` characters.
 */
function dedent(lines) {
  let indent = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue;
    indent = Math.min(indent, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(indent) || indent === 0) return lines;
  return lines.map((line) => (line.trim() === '' ? line : line.slice(indent)));
}

/** Drop leading and trailing blank lines, keeping the ones in the middle. */
function trimBlankEdges(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end);
}

/**
 * The block name a merged first row carries, without its options.
 * "Feed (blog, favorite)" is the Feed block; the options are for the site's
 * own rendering code and say nothing about the content.
 */
function blockName(cell) {
  return cell.replace(/\(.*\)\s*$/, '').trim();
}

/** Escape a cell so it cannot break out of a GFM table row. */
function tableCell(text) {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
}

/** Render rows as a GFM table, the first row being the header. */
function toGfmTable(rows) {
  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row) => {
    const cells = row.map(tableCell);
    while (cells.length < width) cells.push('');
    return `| ${cells.join(' | ')} |`;
  };
  const [header, ...body] = rows;
  return [pad(header), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(pad)].join(
    '\n'
  );
}

/**
 * Turn one parsed grid into Markdown, and collect any metadata it carried.
 *
 * `metadata` is mutated rather than returned because a document has one set of
 * it however many blocks contribute, and Section Metadata blocks appear once
 * per section.
 */
function renderGrid(rows, metadata, stats) {
  if (rows.length === 0) return '';

  const isBlock = rows[0].length === 1 && rows.length >= 1;
  if (!isBlock) {
    // No merged name row: a plain data table, which is exactly a GFM table.
    stats.tables++;
    return toGfmTable(rows);
  }

  const name = blockName(rows[0][0]);
  const body = rows.slice(1);
  stats.blocks++;

  const lowerName = name.toLowerCase();

  if (lowerName === SECTION_METADATA_BLOCK) {
    return '';
  }

  if (lowerName === METADATA_BLOCK) {
    for (const row of body) {
      if (row.length < 2) continue;
      const key = row[0].trim().toLowerCase();
      const value = row.slice(1).join(' ').replace(/\s*\n\s*/g, ' ').trim();
      if (value && !(key in metadata)) metadata[key] = value;
    }
    return '';
  }

  if (CHROME_BLOCKS.has(lowerName)) {
    stats.chromeBlocks++;
    return '';
  }

  if (body.length === 0 || body.every((row) => row.every((cell) => cell.trim() === ''))) {
    // A block the site fills in at render time - a feed, a card list. Empty
    // here is not an error, it is the whole reason the rendered page holds
    // content this document does not. See `isThin`.
    stats.emptyBlocks++;
    return '';
  }

  // A named block whose rows are all multi-column is tabular content that
  // happens to have been authored as a block: "Table", but also anything else
  // laid out in columns.
  if (body.every((row) => row.length >= 2)) {
    stats.tables++;
    return toGfmTable(body);
  }

  // Everything else - Feed, Columns, Hero, Cards - is a wrapper around content.
  // The component name is not content, so it goes; the cells stay, cleaned in
  // turn because a block can hold another block.
  return body
    .map((row) => row.map((cell) => cleanBody(cell, metadata, stats)).filter(Boolean).join('\n\n'))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Clean a document body: every grid table replaced by what it meant, every
 * other line left exactly as the author wrote it.
 */
function cleanBody(text, metadata, stats) {
  const lines = text.split('\n');
  const out = [];
  let run = [];

  const flushRun = () => {
    if (run.length === 0) return;
    const rendered = renderGrid(parseGrid(run), metadata, stats);
    if (rendered.trim()) out.push(rendered);
    run = [];
  };

  for (const line of lines) {
    if (isGridLine(line)) {
      run.push(line);
    } else {
      flushRun();
      out.push(line);
    }
  }
  flushRun();

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Quote a value for YAML only when it needs it. */
function yamlValue(text) {
  const value = String(text).replace(/\s*\n\s*/g, ' ').trim();
  if (!value) return '""';
  if (/^[A-Za-z0-9][\w .,'/()&-]*$/.test(value) && !/: /.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Front matter, or '' when there is nothing worth putting in it. */
function frontMatter(fields) {
  const entries = Object.entries(fields).filter(([, value]) => value);
  if (entries.length === 0) return '';
  return ['---', ...entries.map(([key, value]) => `${key}: ${yamlValue(value)}`), '---', ''].join('\n');
}

/**
 * How much of this document is prose the reader came for.
 *
 * Headings, link targets and table rules are stripped before counting: a page
 * whose entire body is one heading and a list of seven links is not a document
 * about anything, however many characters it holds.
 */
function proseLength(markdown) {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/^#{1,6} .*$/gm, '')
    .replace(/^\s*\|.*$/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[#*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim().length;
}

/**
 * Minimum prose for a cleaned document to stand on its own.
 *
 * Below this the page is a listing whose items the site renders from an index -
 * www.aem.live/blog is the example: its authored document holds an empty Feed
 * block and not one of the twelve posts the rendered page shows.
 */
const MIN_PROSE_LENGTH = 350;

/**
 * Clean one Edge Delivery document.
 *
 * Returns `{ markdown, metadata, thin, stats }`. `thin` is the caller's cue to
 * convert the rendered page for this URL instead - the authored source is the
 * better document right up until the moment it is mostly empty blocks.
 */
function cleanEdsMarkdown(text, { pageUrl = null, fetchedAt = null, frontMatter: wantFrontMatter = true } = {}) {
  const metadata = {};
  const stats = { blocks: 0, emptyBlocks: 0, chromeBlocks: 0, tables: 0 };
  const body = cleanBody(String(text || ''), metadata, stats);

  const prose = proseLength(body);
  const kept = {};
  for (const key of KEPT_METADATA) {
    if (metadata[key]) kept[key] = metadata[key];
  }
  // The provenance fields ride along with the descriptive ones rather than
  // standing alone: a document that carried no Metadata block is a plain
  // Markdown file the site published, and it leaves here byte-identical.
  if (Object.keys(kept).length > 0) {
    if (pageUrl) kept.url = pageUrl;
    if (fetchedAt) kept.fetched = fetchedAt;
  }

  // A caller that already records title, description and URL as fields of its
  // own - the dataset collector does - wants none of it repeated in the text,
  // where it would only be embedded twice.
  const header = wantFrontMatter ? frontMatter(kept) : '';
  const markdown = `${header}${header ? '\n' : ''}${body}`.trim();

  return {
    markdown,
    metadata,
    stats: { ...stats, proseLength: prose },
    // An empty block is the signature of content the site renders rather than
    // stores, so a thin document *with* one is the case worth converting; a
    // thin document with none is simply a short page.
    thin: prose < MIN_PROSE_LENGTH && stats.emptyBlocks > 0,
  };
}

export {
  cleanEdsMarkdown,
  cleanBody,
  parseGrid,
  proseLength,
  MIN_PROSE_LENGTH,
};
