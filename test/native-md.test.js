'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { NativeMarkdown } = require('../src/native-md');

const CONFIG = {
  timeoutMs: 1000,
  userAgent: 'test',
  maxRetries: 0,
  retryDelayMs: 1,
  nativeMarkdown: true,
};

const SILENT = { info() {}, warn() {}, debug() {}, error() {} };

/** Stand in for the network, recording every URL asked for. */
function stubFetch(handler) {
  const asked = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const { status = 200, body = '', contentType = 'text/markdown' } = handler(String(url)) || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      url: String(url),
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
      text: async () => body,
      body: null,
      bodyUsed: false,
    };
  };
  return { asked, restore: () => (globalThis.fetch = original) };
}

test('documentUrl follows the same rule the site routing uses', () => {
  assert.strictEqual(
    NativeMarkdown.documentUrl('https://example.com/blog'),
    'https://example.com/blog.md'
  );
  // A trailing slash names a directory, whose document is its index.
  assert.strictEqual(
    NativeMarkdown.documentUrl('https://example.com/docs/'),
    'https://example.com/docs/index.md'
  );
  assert.strictEqual(
    NativeMarkdown.documentUrl('https://example.com/'),
    'https://example.com/index.md'
  );
  assert.strictEqual(
    NativeMarkdown.documentUrl('https://example.com/about.html'),
    'https://example.com/about.md'
  );
});

test('a URL with a query string has no Markdown twin', () => {
  // /search?q=a and /search?q=b would both ask for /search.md and one document
  // would be written for both pages. Converting each page is the only answer
  // that stays correct.
  assert.strictEqual(NativeMarkdown.documentUrl('https://example.com/search?q=a'), null);
});

test('the site Markdown is taken when the site publishes it', async () => {
  const net = stubFetch(() => ({ body: '# Real document\n\nProse.' }));
  try {
    const source = new NativeMarkdown(CONFIG, SILENT);
    const markdown = await source.fetch('https://example.com/blog');
    assert.match(markdown, /# Real document/);
    assert.deepStrictEqual(net.asked, ['https://example.com/blog.md']);
    assert.strictEqual(source.available, true);
  } finally {
    net.restore();
  }
});

test('an HTML 404 page served at 200 is not mistaken for Markdown', async () => {
  const net = stubFetch(() => ({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!DOCTYPE html><html><body>Page not found</body></html>',
  }));
  try {
    const source = new NativeMarkdown(CONFIG, SILENT);
    assert.strictEqual(await source.fetch('https://example.com/blog'), null);
    assert.strictEqual(source.available, false);
  } finally {
    net.restore();
  }
});

test('one miss settles the question for the whole crawl', async () => {
  const net = stubFetch(() => ({ status: 404, body: 'not found' }));
  try {
    const source = new NativeMarkdown(CONFIG, SILENT);
    for (const page of ['/a', '/b', '/c', '/d']) {
      assert.strictEqual(await source.fetch(`https://example.com${page}`), null);
    }
    // The cost of asking has to be bounded: one probe, not one per page.
    assert.deepStrictEqual(net.asked, ['https://example.com/a.md']);
  } finally {
    net.restore();
  }
});

test('parallel pages share the one probe rather than each firing their own', async () => {
  const net = stubFetch((url) => ({ body: `# ${url}` }));
  try {
    const source = new NativeMarkdown(CONFIG, SILENT);
    const results = await Promise.all([
      source.fetch('https://example.com/a'),
      source.fetch('https://example.com/b'),
      source.fetch('https://example.com/c'),
    ]);
    for (const markdown of results) assert.ok(markdown, 'every page got its own document');
    assert.strictEqual(new Set(net.asked).size, 3, 'each page fetched exactly once');
    assert.ok(net.asked.includes('https://example.com/a.md'));
  } finally {
    net.restore();
  }
});

test('--no-native-md asks the site nothing at all', async () => {
  const net = stubFetch(() => ({ body: '# would have worked' }));
  try {
    const source = new NativeMarkdown({ ...CONFIG, nativeMarkdown: false }, SILENT);
    assert.strictEqual(await source.fetch('https://example.com/blog'), null);
    assert.deepStrictEqual(net.asked, []);
  } finally {
    net.restore();
  }
});

test('a network failure is a miss, not a crash', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  try {
    const source = new NativeMarkdown(CONFIG, SILENT);
    assert.strictEqual(await source.fetch('https://example.com/blog'), null);
  } finally {
    globalThis.fetch = original;
  }
});
