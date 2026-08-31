'use strict';

// The hidden window background captures are loaded in.
//
// Worth testing here because the failure modes are all invisible ones: a window
// that is never closed sits in the taskbar for the rest of the session, a
// window created twice leaves an orphan, and a fallback that does not fire
// turns "the tab was visible" into "the page was never archived".
//
// Loaded the way the other extension modules are: the file is browser ESM, the
// repository root declares "type": "commonjs", and the extension ships without
// a package.json of its own, so its source text is imported through a data: URL
// — always evaluated as a module.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_PATH = path.join(
  __dirname, '..', 'extension', 'src', 'core', 'bg', 'archive-window.js');

let windows;      // id -> { focused, state }
let tabs;         // id -> { windowId, url }
let nextId;
let calls;        // what the module asked the browser to do, in order
let failCreateWindow;
let failMinimized;
let removedWindowListener;

function reset() {
  windows = new Map();
  tabs = new Map();
  nextId = 1;
  calls = [];
  failCreateWindow = false;
  failMinimized = false;
}
reset();

globalThis.chrome = {
  windows: {
    async create({ url, focused, state }) {
      calls.push(`windows.create(${state || 'normal'})`);
      if (failCreateWindow) throw new Error('no windows');
      if (state === 'minimized' && failMinimized) throw new Error('bad state');
      const id = nextId++;
      const tabId = nextId++;
      windows.set(id, { focused, state: state || 'normal' });
      tabs.set(tabId, { windowId: id, url });
      return { id, tabs: [{ id: tabId, url }] };
    },
    async get(id) {
      if (!windows.has(id)) throw new Error('no such window');
      return { id };
    },
    async remove(id) {
      calls.push('windows.remove');
      if (!windows.delete(id)) throw new Error('no such window');
      for (const [tabId, tab] of tabs) if (tab.windowId === id) tabs.delete(tabId);
    },
    onRemoved: {
      addListener(listener) {
        removedWindowListener = listener;
      },
    },
  },
};

globalThis.browser = {
  tabs: {
    async create({ url, active, windowId }) {
      calls.push(windowId === undefined ? 'tabs.create(current window)' : 'tabs.create(hidden)');
      if (windowId !== undefined && !windows.has(windowId)) throw new Error('no such window');
      const id = nextId++;
      tabs.set(id, { windowId, url, active });
      return { id, url, windowId };
    },
  },
};

let archiveWindow;

test.before(async () => {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  archiveWindow = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
});

test.beforeEach(async () => {
  // The module keeps its window between tests, so each one starts by letting it
  // close: its state is the thing under test and must not leak across.
  await archiveWindow.closeIfIdle().catch(() => {});
  reset();
});

test('a capture tab goes into a minimized, unfocused window', async () => {
  const tab = await archiveWindow.createHiddenTab('https://x.test/a');
  assert.deepStrictEqual(calls, ['windows.create(minimized)', 'tabs.create(hidden)']);
  const created = windows.get(tabs.get(tab.id).windowId);
  assert.strictEqual(created.state, 'minimized');
  assert.strictEqual(created.focused, false);
  assert.ok(archiveWindow.isHiddenTab(tab.id));
});

test('a second capture reuses the window rather than opening another', async () => {
  // Ten queued URLs must not mean ten windows.
  const first = await archiveWindow.createHiddenTab('https://x.test/a');
  const second = await archiveWindow.createHiddenTab('https://x.test/b');
  assert.strictEqual(calls.filter((call) => call.startsWith('windows.create')).length, 1);
  assert.strictEqual(tabs.get(first.id).windowId, tabs.get(second.id).windowId);
});

test('captures starting together open one window between them', async () => {
  // runTasks() starts the whole batch at once, so the creation has to be shared
  // rather than raced.
  const opened = await Promise.all([
    archiveWindow.createHiddenTab('https://x.test/a'),
    archiveWindow.createHiddenTab('https://x.test/b'),
    archiveWindow.createHiddenTab('https://x.test/c'),
  ]);
  assert.strictEqual(calls.filter((call) => call.startsWith('windows.create')).length, 1);
  const windowIds = new Set(opened.map((tab) => tabs.get(tab.id).windowId));
  assert.strictEqual(windowIds.size, 1);
});

test('the window is not closed while a capture is still in it', async () => {
  const first = await archiveWindow.createHiddenTab('https://x.test/a');
  await archiveWindow.createHiddenTab('https://x.test/b');
  archiveWindow.releaseTab(first.id);
  await archiveWindow.closeIfIdle();
  assert.ok(!calls.includes('windows.remove'), 'closed with a capture still running');
  assert.strictEqual(windows.size, 1);
});

test('the window is closed once the last capture leaves', async () => {
  const first = await archiveWindow.createHiddenTab('https://x.test/a');
  const second = await archiveWindow.createHiddenTab('https://x.test/b');
  archiveWindow.releaseTab(first.id);
  archiveWindow.releaseTab(second.id);
  await archiveWindow.closeIfIdle();
  assert.ok(calls.includes('windows.remove'));
  assert.strictEqual(windows.size, 0);
});

test('releasing a tab twice does not close a window that is in use', async () => {
  // onTabRemoved fires for tabs this module never owned, and can fire twice for
  // one it did; neither may take the window out from under a running capture.
  const first = await archiveWindow.createHiddenTab('https://x.test/a');
  archiveWindow.releaseTab(first.id);
  const second = await archiveWindow.createHiddenTab('https://x.test/b');
  archiveWindow.releaseTab(first.id);
  archiveWindow.releaseTab(99999);
  await archiveWindow.closeIfIdle();
  assert.ok(!calls.includes('windows.remove'));
  assert.ok(archiveWindow.isHiddenTab(second.id));
});

test('a window the user closed is replaced, not reused', async () => {
  const first = await archiveWindow.createHiddenTab('https://x.test/a');
  const closedId = tabs.get(first.id).windowId;
  windows.delete(closedId);
  removedWindowListener(closedId);

  const second = await archiveWindow.createHiddenTab('https://x.test/b');
  assert.strictEqual(calls.filter((call) => call.startsWith('windows.create')).length, 2);
  assert.notStrictEqual(tabs.get(second.id).windowId, closedId);
  // The tabs of the window that went are no longer anyone's business.
  assert.ok(!archiveWindow.isHiddenTab(first.id));
});

test('a window that vanished without an event is noticed on the next capture', async () => {
  // onRemoved can be missed entirely: the service worker sleeps, and listeners
  // registered at module scope die with it.
  const first = await archiveWindow.createHiddenTab('https://x.test/a');
  windows.delete(tabs.get(first.id).windowId);
  const second = await archiveWindow.createHiddenTab('https://x.test/b');
  assert.strictEqual(calls.filter((call) => call.startsWith('windows.create')).length, 2);
  assert.ok(windows.has(tabs.get(second.id).windowId));
});

test('an unfocused ordinary window is the fallback when minimized is refused', async () => {
  failMinimized = true;
  const tab = await archiveWindow.createHiddenTab('https://x.test/a');
  const created = windows.get(tabs.get(tab.id).windowId);
  assert.strictEqual(created.state, 'normal');
  assert.strictEqual(created.focused, false);
  assert.ok(archiveWindow.isHiddenTab(tab.id));
});

test('a capture still happens when no window can be opened at all', async () => {
  // Being visible is a much smaller problem than never being archived.
  failCreateWindow = true;
  const tab = await archiveWindow.createHiddenTab('https://x.test/a');
  assert.ok(calls.includes('tabs.create(current window)'));
  assert.strictEqual(tabs.get(tab.id).windowId, undefined);
  assert.ok(!archiveWindow.isHiddenTab(tab.id), 'a visible tab was counted as hidden');
});
