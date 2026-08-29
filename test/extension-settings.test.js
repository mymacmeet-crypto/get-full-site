'use strict';

// The extension's Auto/Manual mode and HTML/MD/Both format.
//
// Worth testing here because three separate code paths branch on these — the
// content script gate, the queue enqueue, and which files get written — and a
// value that survives a service worker restart wrongly is a setting the user
// changed and the archiver ignored.
//
// Loaded the same way test/extension-pause.test.js loads its module: the file is
// browser ESM, the repository root declares "type": "commonjs", and the
// extension deliberately ships without a package.json of its own, so its source
// text is imported through a data: URL — always evaluated as a module. It has no
// imports of its own, so nothing needs resolving relative to it.
//
// The module is evaluated once per process and caches in memory, so the stub's
// backing store is swapped between tests rather than the stub object.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_PATH = path.join(
  __dirname, '..', 'extension', 'src', 'core', 'bg', 'archive-settings.js');

let store = {};
const changeListeners = [];

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const names = Array.isArray(keys) ? keys : [keys];
        const result = {};
        for (const name of names) {
          if (name in store) result[name] = store[name];
        }
        return result;
      },
      async set(values) {
        const changes = {};
        for (const [name, value] of Object.entries(values)) {
          changes[name] = { oldValue: store[name], newValue: value };
        }
        Object.assign(store, values);
        for (const listener of changeListeners) listener(changes, 'local');
      },
    },
    onChanged: {
      addListener(listener) {
        changeListeners.push(listener);
      },
    },
  },
};

let settings;

test.before(async () => {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  settings = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
});

test.beforeEach(() => {
  store = {};
});

test('defaults to archiving everything as HTML', async () => {
  // A fresh install must archive: a default of Manual would look exactly like
  // the extension being broken.
  const current = await settings.getSettings();
  assert.equal(current.mode, 'auto');
  assert.equal(current.format, 'html');
  assert.equal(await settings.isManual(), false);
  assert.equal(await settings.wantsHtml(), true);
  assert.equal(await settings.wantsMarkdown(), false);
});

test('a partial update leaves the other setting alone', async () => {
  // The popup sends only the control the user touched, so a format click must
  // not quietly reset the mode.
  await settings.setSettings({ mode: 'manual' });
  await settings.setSettings({ format: 'both' });
  const current = await settings.getSettings();
  assert.equal(current.mode, 'manual');
  assert.equal(current.format, 'both');
});

test('both formats ask for both files', async () => {
  await settings.setSettings({ format: 'both' });
  assert.equal(await settings.wantsHtml(), true);
  assert.equal(await settings.wantsMarkdown(), true);
});

test('md asks for markdown only', async () => {
  // The md-only path skips the capture entirely, so wantsHtml being wrong here
  // is the difference between one file and two.
  await settings.setSettings({ format: 'md' });
  assert.equal(await settings.wantsHtml(), false);
  assert.equal(await settings.wantsMarkdown(), true);
});

test('a value that is not one of the choices falls back to the default', async () => {
  // storage is shared with anything else that can write to it, and a typo in a
  // stored value must not leave the archiver in a mode with no behaviour.
  await settings.setSettings({ mode: 'sideways', format: 'pdf' });
  const current = await settings.getSettings();
  assert.equal(current.mode, 'auto');
  assert.equal(current.format, 'html');
});

test('the setting is what was written to storage, not just what was cached', async () => {
  // The cache is what every navigation reads; storage is what survives a
  // service worker restart. They have to agree, or stopping automatic
  // archiving would silently come back on the next time Chrome woke it up.
  await settings.setSettings({ mode: 'manual', format: 'md' });
  assert.equal(store.archiveMode, 'manual');
  assert.equal(store.archiveFormat, 'md');
});

test('a change made elsewhere invalidates the cache', async () => {
  // Two contexts can write this: the popup through the service worker, and any
  // other extension page. The change event is the only thing keeping a stale
  // in-memory copy from outliving the write.
  await settings.getSettings();
  await chrome.storage.local.set({ archiveMode: 'manual' });
  assert.equal(await settings.isManual(), true);
});
