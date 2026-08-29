'use strict';

// The extension's pause switch. Worth testing here rather than by hand because
// heal() runs at most once per install: it is the recovery path for an install
// the retired profile-flipping Stop left unable to archive anything, and once
// it has run you cannot re-enter that state to check it again.
//
// extension/src/core/bg/archive-pause.js is browser ESM, but the repository root
// package.json declares "type": "commonjs" and the extension deliberately ships
// without a package.json of its own, so Node would load that .js as CommonJS and
// choke on `export`. Its real source text is therefore imported through a
// data: URL, which is always evaluated as a module — the file has no imports of
// its own, so nothing needs resolving relative to it.
//
// The module is evaluated once per process and keeps its own cache, so the
// stub's backing store is swapped between tests rather than the stub object.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_PATH = path.join(
  __dirname, '..', 'extension', 'src', 'core', 'bg', 'archive-pause.js');

const DISABLED_PROFILE_NAME = '__Disabled_Settings__';
const DEFAULT_PROFILE = '__Default_Settings__';

let store = {};
const changeListeners = [];

// Mirrors the shape archive-pause.js uses: storage.local get/set/remove plus
// storage.onChanged, and nothing else.
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const names = Array.isArray(keys) ? keys : [keys];
        const result = {};
        for (const name of names) {
          if (name in store) {
            result[name] = store[name];
          }
        }
        return result;
      },
      async set(values) {
        Object.assign(store, values);
      },
      async remove(keys) {
        for (const name of Array.isArray(keys) ? keys : [keys]) {
          delete store[name];
        }
      },
    },
    onChanged: {
      addListener(listener) {
        changeListeners.push(listener);
      },
    },
  },
};

// Stands in for core/bg/config.js: heal() only reads getProfiles() and writes
// through onMessage(), so record what it would have written.
function makeConfig(profiles) {
  const writes = [];
  return {
    writes,
    DISABLED_PROFILE_NAME,
    async getProfiles() {
      return profiles;
    },
    async onMessage(message) {
      writes.push({ profileName: message.profileName, profile: message.profile });
      Object.assign(profiles[message.profileName], message.profile);
      return {};
    },
  };
}

const loaded = import(
  'data:text/javascript;charset=utf-8,' +
  encodeURIComponent(fs.readFileSync(MODULE_PATH, 'utf8')));

test.beforeEach(() => {
  store = {};
});

// ---------------------------------------------------------------------------
// heal()
// ---------------------------------------------------------------------------

test('heal restores the profile a half-finished Start left disarmed', async () => {
  const { heal } = await loaded;
  // The state found on the reporting install: paused, both triggers off, and
  // the snapshot still recording what Stop had captured.
  store = {
    autoArchivePaused: true,
    autoArchivePausedProfiles: {
      [DEFAULT_PROFILE]: { autoSaveLoad: false, autoSaveLoadOrUnload: true },
    },
  };
  const config = makeConfig({
    [DEFAULT_PROFILE]: {
      autoSaveLoad: false, autoSaveUnload: false, autoSaveLoadOrUnload: false,
    },
  });

  const result = await heal(config);

  assert.deepEqual(result.repaired, [DEFAULT_PROFILE]);
  assert.equal(config.writes.length, 1);
  assert.equal(config.writes[0].profile.autoSaveLoadOrUnload, true,
    'the trigger the snapshot recorded is put back');
  assert.equal(store.autoArchivePauseHealed, true);
  assert.ok(!('autoArchivePausedProfiles' in store), 'the consumed snapshot is dropped');
  assert.equal(store.autoArchivePaused, true,
    'heal repairs the profile but does not silently start archiving');
});

test('heal arms a disarmed profile even when the snapshot is gone', async () => {
  const { heal } = await loaded;
  // The worse variant: the restore deleted the snapshot but its per-profile
  // writes never landed, so nothing records what to put back.
  const config = makeConfig({
    [DEFAULT_PROFILE]: {
      autoSaveLoad: false, autoSaveUnload: false, autoSaveLoadOrUnload: false,
    },
  });

  const result = await heal(config);

  assert.deepEqual(result.repaired, [DEFAULT_PROFILE]);
  assert.equal(config.writes[0].profile.autoSaveLoadOrUnload, true);
});

test('heal ignores a snapshot that would itself leave the profile disarmed', async () => {
  const { heal } = await loaded;
  // Pressing Stop twice used to be able to snapshot the stopped values.
  store = {
    autoArchivePausedProfiles: {
      [DEFAULT_PROFILE]: { autoSaveLoad: false, autoSaveLoadOrUnload: false },
    },
  };
  const config = makeConfig({
    [DEFAULT_PROFILE]: {
      autoSaveLoad: false, autoSaveUnload: false, autoSaveLoadOrUnload: false,
    },
  });

  await heal(config);

  assert.equal(config.writes.length, 1);
  assert.equal(config.writes[0].profile.autoSaveLoadOrUnload, true,
    'the running defaults win over a useless snapshot');
});

test('heal leaves a healthy install untouched', async () => {
  const { heal } = await loaded;
  const config = makeConfig({
    [DEFAULT_PROFILE]: {
      autoSaveLoad: false, autoSaveUnload: false, autoSaveLoadOrUnload: true,
    },
  });

  const result = await heal(config);

  assert.deepEqual(result.repaired, []);
  assert.equal(config.writes.length, 0);
});

test('heal never touches the disabled profile', async () => {
  const { heal } = await loaded;
  // Every trigger is off by design here — that is what the profile is for.
  const config = makeConfig({
    [DISABLED_PROFILE_NAME]: {
      autoSaveLoad: false, autoSaveUnload: false, autoSaveLoadOrUnload: false,
    },
  });

  const result = await heal(config);

  assert.deepEqual(result.repaired, []);
  assert.equal(config.writes.length, 0);
});

test('heal runs once, so auto-save turned off deliberately stays off', async () => {
  const { heal } = await loaded;
  const profiles = {
    [DEFAULT_PROFILE]: {
      autoSaveLoad: false, autoSaveUnload: false, autoSaveLoadOrUnload: false,
    },
  };
  const first = makeConfig(profiles);
  await heal(first);
  assert.equal(first.writes.length, 1, 'the first run repairs');

  // the user now switches auto-save off in the options page
  profiles[DEFAULT_PROFILE] = {
    autoSaveLoad: false, autoSaveUnload: false, autoSaveLoadOrUnload: false,
  };
  const second = makeConfig(profiles);
  const result = await heal(second);

  assert.deepEqual(result.repaired, []);
  assert.equal(second.writes.length, 0, 'the second run must not override them');
});

test('heal reports a config failure instead of throwing into startup', async () => {
  const { heal } = await loaded;
  const config = {
    DISABLED_PROFILE_NAME,
    async getProfiles() {
      throw new Error('storage exploded');
    },
  };

  const result = await heal(config);

  assert.equal(result.error, 'storage exploded');
  assert.deepEqual(result.repaired, []);
});

// ---------------------------------------------------------------------------
// the flag itself
// ---------------------------------------------------------------------------

test('setPaused round-trips through storage and isPaused reads it back', async () => {
  const { isPaused, setPaused, PAUSED_KEY } = await loaded;

  assert.deepEqual(await setPaused(true), { paused: true });
  assert.equal(store[PAUSED_KEY], true);
  assert.equal(await isPaused(), true);

  await setPaused(false);
  assert.equal(await isPaused(), false);
});

test('isPaused picks up a change written by another extension context', async () => {
  const { isPaused, PAUSED_KEY } = await loaded;
  await isPaused();
  assert.ok(changeListeners.length, 'the module subscribed to storage changes');

  // what the popup's write looks like arriving in the service worker
  store[PAUSED_KEY] = true;
  for (const listener of changeListeners) {
    listener({ [PAUSED_KEY]: { newValue: true } }, 'local');
  }
  assert.equal(await isPaused(), true, 'the cache is invalidated, not stale');

  for (const listener of changeListeners) {
    listener({ [PAUSED_KEY]: { newValue: false } }, 'local');
  }
  assert.equal(await isPaused(), false);
});

test('isPaused ignores changes in another storage area', async () => {
  const { isPaused, PAUSED_KEY } = await loaded;
  for (const listener of changeListeners) {
    listener({ [PAUSED_KEY]: { newValue: false } }, 'local');
  }
  assert.equal(await isPaused(), false);

  for (const listener of changeListeners) {
    listener({ [PAUSED_KEY]: { newValue: true } }, 'sync');
  }
  assert.equal(await isPaused(), false, 'a sync-area write must not flip the switch');
});
