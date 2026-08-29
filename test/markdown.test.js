'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { htmlToMarkdown, looksLikeMarkdown } = require('../src/markdown');

const PAGE_URL = 'https://example.com/blog/post';

/** A page shaped like the ones a real capture produces: content inside chrome. */
function page(main, { extra = '' } = {}) {
  return `<!DOCTYPE html><html><head><title>Ignored</title><style>a{color:red}</style></head>
    <body>
      <header class="header"><nav><a href="/">Home</a><a href="/docs">Docs</a></nav></header>
      <main>${main}</main>
      ${extra}
      <footer><p>(c) Example, all rights reserved</p></footer>
    </body></html>`;
}

test('the site chrome does not reach the Markdown', () => {
  const markdown = htmlToMarkdown(page('<h1>Real Title</h1><p>Real body text.</p>'), {
    pageUrl: PAGE_URL,
  });
  assert.match(markdown, /# Real Title/);
  assert.match(markdown, /Real body text\./);
  // The nav and footer are on every page of the site; in a corpus they would
  // make every document match a query about the nav.
  assert.ok(!markdown.includes('Docs'), 'nav leaked into the Markdown');
  assert.ok(!markdown.includes('all rights reserved'), 'footer leaked into the Markdown');
});

test('relative links and images become absolute', () => {
  const markdown = htmlToMarkdown(
    page('<p>See <a href="/docs/x">the docs</a> <img src="../pic.png" alt="pic"></p>'),
    { pageUrl: PAGE_URL }
  );
  assert.match(markdown, /\[the docs\]\(https:\/\/example\.com\/docs\/x\)/);
  assert.match(markdown, /!\[pic\]\(https:\/\/example\.com\/pic\.png\)/);
});

test('inlined base64 images are dropped rather than embedded', () => {
  const markdown = htmlToMarkdown(
    page('<p>before <img src="data:image/png;base64,iVBORw0KGgo=" alt="spacer"> after</p>'),
    { pageUrl: PAGE_URL }
  );
  assert.ok(!markdown.includes('base64'), 'a data: URI reached the Markdown');
  // And the gap it left is closed, not left as a double space.
  assert.match(markdown, /before after/);
});

test('GFM tables survive the conversion', () => {
  const markdown = htmlToMarkdown(
    page('<table><tr><th>Name</th><th>Size</th></tr><tr><td>a</td><td>1</td></tr></table>'),
    { pageUrl: PAGE_URL }
  );
  assert.match(markdown, /\| Name \| Size \|/);
  assert.match(markdown, /\| a \| 1 \|/);
});

test('whitespace inside a code block is left alone', () => {
  const markdown = htmlToMarkdown(page('<pre><code>if (x)  {  y }</code></pre>'), {
    pageUrl: PAGE_URL,
  });
  assert.match(markdown, /if \(x\)  \{  y \}/);
});

test('scripts and styles never become text', () => {
  const markdown = htmlToMarkdown(
    page('<p>Body.</p><script>var secret = 1;</script><style>.x{color:red}</style>'),
    { pageUrl: PAGE_URL }
  );
  assert.ok(!markdown.includes('secret'));
  assert.ok(!markdown.includes('color:red'));
});

test('a page with no <main> falls back to the body rather than to nothing', () => {
  const html = `<html><body><div><h1>Bare Page</h1><p>${'Prose. '.repeat(40)}</p></div></body></html>`;
  const markdown = htmlToMarkdown(html, { pageUrl: PAGE_URL });
  assert.match(markdown, /# Bare Page/);
  assert.match(markdown, /Prose\./);
});

test('an empty <main> beside the real content is not believed', () => {
  // Some templates ship an empty <main> and render the article next to it.
  // Trusting it would produce an empty document that still looks successful.
  const html = `<html><body><main></main><article><h1>Actual</h1><p>${'Words. '.repeat(
    50
  )}</p></article></body></html>`;
  const markdown = htmlToMarkdown(html, { pageUrl: PAGE_URL });
  assert.match(markdown, /# Actual/);
  assert.match(markdown, /Words\./);
});

test('the page title is prepended only when the content carries no heading', () => {
  const withHeading = htmlToMarkdown(page('<h1>Own Heading</h1><p>Body.</p>'), {
    pageUrl: PAGE_URL,
    title: 'Tab Title',
  });
  assert.match(withHeading, /^# Own Heading/);
  assert.ok(!withHeading.includes('Tab Title'));

  const withoutHeading = htmlToMarkdown(page('<p>Body with no heading.</p>'), {
    pageUrl: PAGE_URL,
    title: 'Tab Title',
  });
  assert.match(withoutHeading, /^# Tab Title/);
});

test('a page that converts to nothing returns empty rather than throwing', () => {
  assert.strictEqual(htmlToMarkdown('', { pageUrl: PAGE_URL }), '');
  assert.strictEqual(htmlToMarkdown('<html><body></body></html>', { pageUrl: PAGE_URL }), '');
});

test('fullPage keeps the chrome for the caller that asks for it', () => {
  const markdown = htmlToMarkdown(page('<p>Body.</p>'), { pageUrl: PAGE_URL, fullPage: true });
  assert.match(markdown, /Docs/);
});

test('looksLikeMarkdown rejects an HTML 404 page served at 200', () => {
  // The failure this exists to stop: a site with no <page>.md answers with its
  // own HTML error page, which would otherwise be saved as the document.
  assert.strictEqual(looksLikeMarkdown('<!DOCTYPE html><html>...', 'text/html'), false);
  assert.strictEqual(looksLikeMarkdown('  <html><body>Not found</body></html>', 'text/plain'), false);
  assert.strictEqual(looksLikeMarkdown('# A real document\n\nProse.', 'text/markdown'), true);
  assert.strictEqual(looksLikeMarkdown('', 'text/markdown'), false);
  assert.strictEqual(looksLikeMarkdown('   ', 'text/markdown'), false);
});

test('an anchor wrapping a whole card does not break the Markdown', () => {
  // The defect this exists to stop: Turndown puts the link delimiters where
  // the anchor opens and closes, so a card-shaped <a> emits a stray "](url)["
  // on its own line and swallows whatever follows.
  const html = `<body><main><div class="cards">
    <a href="/blog/post-1"><h3>A Post Title</h3><p>Its summary sentence.</p><img src="/p.png" alt=""></a>
    <a href="/blog/post-2"><h3>Another Title</h3><p>Another summary.</p></a>
  </div></main></body>`;
  const markdown = htmlToMarkdown(html, { pageUrl: PAGE_URL });

  assert.ok(!/^\s*\]\(/m.test(markdown), `stray link delimiter in:\n${markdown}`);
  assert.ok(!/\)\[\s*$/m.test(markdown), `stray link delimiter in:\n${markdown}`);
  // The destination moves onto the heading, where it names the thing it points at.
  assert.match(markdown, /### \[A Post Title\]\(https:\/\/example\.com\/blog\/post-1\)/);
  assert.match(markdown, /### \[Another Title\]\(https:\/\/example\.com\/blog\/post-2\)/);
  assert.match(markdown, /Its summary sentence\./);
});

test('a block anchor with no heading keeps its URL rather than losing it', () => {
  const html =
    '<body><main><div><a href="/promo"><div>Card text with no heading.</div></a></div></main></body>';
  const markdown = htmlToMarkdown(html, { pageUrl: PAGE_URL });
  assert.match(markdown, /Card text with no heading\./);
  assert.match(markdown, /https:\/\/example\.com\/promo/);
});

test('an inline link is left exactly as it was', () => {
  const html = '<body><main><p>Read <a href="/docs">the docs</a> first, and more prose after.</p></main></body>';
  const markdown = htmlToMarkdown(html, { pageUrl: PAGE_URL });
  assert.match(markdown, /Read \[the docs\]\(https:\/\/example\.com\/docs\) first/);
});

test('a title that only repeats the link text is dropped', () => {
  const html = `<body><main><p>
    <a href="/a" title="Valtech &amp; Adobe">Valtech &amp; Adobe</a> and
    <a href="/b" title="A genuinely different title">Some link text</a>.
  </p></main></body>`;
  const markdown = htmlToMarkdown(html, { pageUrl: PAGE_URL });
  assert.match(markdown, /\[Valtech & Adobe\]\(https:\/\/example\.com\/a\)/);
  // A title carrying information it does not repeat is kept.
  assert.match(markdown, /\[Some link text\]\(https:\/\/example\.com\/b "A genuinely different title"\)/);
});

test('a link left empty by a stripped icon does not become "[](url)"', () => {
  const html =
    '<body><main><p>Trailing <a href="/x"><img src="data:image/gif;base64,R0lGOD"></a> icon link.</p></main></body>';
  const markdown = htmlToMarkdown(html, { pageUrl: PAGE_URL });
  assert.ok(!markdown.includes(']('), `empty link survived:\n${markdown}`);
  assert.match(markdown, /Trailing icon link\./);
});
