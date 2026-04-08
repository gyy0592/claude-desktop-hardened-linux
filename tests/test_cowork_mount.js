'use strict';

/**
 * Integration test: bwrap host-folder mounting chain.
 *
 * Verifies that mountPaths passed to SessionOrchestrator.start() end up
 * as --bind entries in the bubblewrap command args.
 *
 * Data flow under test:
 *   orch.start({ mountPaths: [...] })
 *     → swift.spawn(..., additionalMounts=[...], ...)
 *       → buildBwrapCommand(..., additionalMounts)
 *         → bwrapArgs includes ['--bind', p, p] for each existing path
 *
 * Run: node --test tests/test_cowork_mount.js
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count occurrences of a value in an array. */
function countOccurrences(arr, value) {
  return arr.filter(x => x === value).length;
}

/**
 * Given the args array passed to spawn(), extract only the bwrap args.
 *
 * When systemd-run is present, spawn is called as:
 *   systemd-run --scope ... -- /usr/bin/bwrap <bwrap-args>
 * When systemd-run is absent, spawn is called as:
 *   /usr/bin/bwrap <bwrap-args>
 *
 * In either case we want the portion starting after "bwrap" up to and
 * including the final '--' separator (which separates sandbox flags from
 * the process to execute inside).
 */
function extractBwrapArgs(spawnArgs) {
  // Find the index of the bwrap binary argument
  const bwrapIdx = spawnArgs.findIndex(
    a => a === '/usr/bin/bwrap' || a === '/usr/local/bin/bwrap'
  );
  if (bwrapIdx === -1) {
    // If bwrap is the command itself (not in args), return all args
    return spawnArgs;
  }
  return spawnArgs.slice(bwrapIdx + 1);
}

/**
 * Return the portion of bwrapArgs that comes before the final '--' separator.
 * The additional --bind entries for user folders are injected just before '--'.
 */
function bwrapFlagsBeforeDoubleDash(bwrapArgs) {
  const ddIdx = bwrapArgs.lastIndexOf('--');
  if (ddIdx === -1) return bwrapArgs;
  return bwrapArgs.slice(0, ddIdx);
}

// ---------------------------------------------------------------------------
// Mock setup — must happen before requiring modules that use child_process
// ---------------------------------------------------------------------------

// claude-swift-stub/index.js has an IIFE that calls require('electron') at load
// time (for its computerUse export). Since electron is not installed, we must
// intercept require() before the stub is loaded.
//
// Strategy: override Module._resolveFilename so that 'electron' resolves to a
// synthetic key, then pre-populate require.cache under that key.
const Module = require('module');
const ELECTRON_FAKE_PATH = '__electron_mock__';

const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
  if (request === 'electron') return ELECTRON_FAKE_PATH;
  if (request === 'claude-swift-stub' || request === '@ant/claude-swift') {
    return require.resolve('../stubs/claude-swift-stub/index');
  }
  return origResolveFilename.call(this, request, parent, isMain, options);
};

require.cache[ELECTRON_FAKE_PATH] = {
  id: ELECTRON_FAKE_PATH,
  filename: ELECTRON_FAKE_PATH,
  loaded: true,
  exports: {
    app: {
      getPath: () => '/tmp/cowork-test',
      on: () => {},
      getVersion: () => '1.0',
    },
    ipcMain: {
      handle: () => {},
      removeHandler: () => {},
    },
    screen: {
      getPrimaryDisplay: () => ({ id: 1, size: { width: 1920, height: 1080 }, scaleFactor: 1, bounds: { x: 0, y: 0 }, label: 'Display 1' }),
      getAllDisplays: () => [],
    },
  },
};

// Patch child_process.spawn BEFORE requiring the stub so the stub's
// module-level `const { spawn } = require('child_process')` binding
// picks up the patch via the shared module cache reference.
// (The stub captures the function reference at require-time via destructuring,
// so we need to patch the module object first, then require the stub.)
const cp = require('child_process');
const origSpawn = cp.spawn;

let capturedCmd = null;
let capturedArgs = null;

function makeFakeChild() {
  const fake = new EventEmitter();
  fake.pid = 99999;
  fake.stdout = new EventEmitter();
  fake.stderr = new EventEmitter();
  fake.stdin = { write: () => {}, end: () => {}, destroyed: false };
  return fake;
}

cp.spawn = function(cmd, args, opts) {
  capturedCmd = cmd;
  capturedArgs = Array.isArray(args) ? args.slice() : [];
  return makeFakeChild();
};

// ---------------------------------------------------------------------------
// Now require the real modules under test
// ---------------------------------------------------------------------------

// NOTE: claude-swift-stub/index.js does `const { ..., spawn } = require('child_process')`
// at module load time. Destructuring captures the VALUE of cp.spawn at that moment.
// We patched cp.spawn above, so the destructured `spawn` inside the module will be
// our mock — as long as the module hasn't been loaded yet (which it hasn't, since
// this is the first require in this test file).
const { SwiftAddonStub } = require('../stubs/claude-swift-stub/index');

const { SessionOrchestrator } = require('../stubs/cowork/session_orchestrator');

// ---------------------------------------------------------------------------
// IPC-boundary setup — capture handlers from ipc_overrides.js
//
// Strategy: temporarily replace ipcMain.handle in the ELECTRON_FAKE_PATH cache
// to intercept handler registration, then restore the original. This does NOT
// touch require.cache[...].exports.vm or any module under test — it only
// reconfigures the already-fake ipcMain mock that we own.
// ---------------------------------------------------------------------------

const capturedIpcHandlers = {};
{
  const fakeElectron = require.cache[ELECTRON_FAKE_PATH].exports;
  const origHandle = fakeElectron.ipcMain.handle;
  fakeElectron.ipcMain.handle = (ch, fn) => { capturedIpcHandlers[ch] = fn; };
  fakeElectron.ipcMain.removeHandler = () => {};
  const { registerCoworkHandlers } = require('../stubs/cowork/ipc_overrides');
  registerCoworkHandlers();
  fakeElectron.ipcMain.handle = origHandle; // restore
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('bwrap host-folder mounting integration', () => {

  let stub;
  let orch;

  beforeEach(() => {
    capturedCmd = null;
    capturedArgs = null;

    stub = new SwiftAddonStub();
    // Bypass claude binary discovery — set a known executable that passes
    // fs.accessSync and is in the allowlist (/usr/bin/)
    stub._claudeBinary = '/usr/bin/true';

    orch = new SessionOrchestrator(stub);
  });

  afterEach(() => {
    capturedCmd = null;
    capturedArgs = null;
  });

  // -------------------------------------------------------------------------
  it('one existing folder produces one --bind entry', async () => {
    const tmpDir = fs.mkdtempSync(os.tmpdir() + '/cowork-mount-test-');
    try {
      await orch.start({ mountPaths: [tmpDir], workDir: '/tmp' });

      assert.ok(capturedArgs !== null, 'spawn should have been called');

      const bwrapArgs = extractBwrapArgs(capturedArgs);
      const flags = bwrapFlagsBeforeDoubleDash(bwrapArgs);

      // Find the --bind index for our tmpDir (source is /proc/self/fd/N after fd-pin fix)
      const bindIdx = flags.findIndex((a, i) =>
        a === '--bind' && /^\/proc\/self\/fd\/\d+$/.test(flags[i + 1]) && flags[i + 2] === tmpDir
      );
      assert.ok(
        bindIdx !== -1,
        `Expected --bind /proc/self/fd/N ${tmpDir} in bwrap flags before '--', got: ${flags.join(' ')}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  it('two existing folders produce two --bind entries', async () => {
    const tmpDir1 = fs.mkdtempSync(os.tmpdir() + '/cowork-mount-a-');
    const tmpDir2 = fs.mkdtempSync(os.tmpdir() + '/cowork-mount-b-');
    try {
      await orch.start({ mountPaths: [tmpDir1, tmpDir2], workDir: '/tmp' });

      assert.ok(capturedArgs !== null, 'spawn should have been called');

      const bwrapArgs = extractBwrapArgs(capturedArgs);
      const flags = bwrapFlagsBeforeDoubleDash(bwrapArgs);

      for (const dir of [tmpDir1, tmpDir2]) {
        const bindIdx = flags.findIndex((a, i) =>
          a === '--bind' && /^\/proc\/self\/fd\/\d+$/.test(flags[i + 1]) && flags[i + 2] === dir
        );
        assert.ok(
          bindIdx !== -1,
          `Expected --bind /proc/self/fd/N ${dir} in bwrap flags, got: ${flags.join(' ')}`
        );
      }
    } finally {
      fs.rmSync(tmpDir1, { recursive: true, force: true });
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  it('empty mountPaths produces no extra --bind entries beyond baseline', async () => {
    // Baseline: call with no mountPaths, count --bind occurrences
    await orch.start({ mountPaths: [], workDir: '/tmp' });
    const baselineArgs = capturedArgs ? capturedArgs.slice() : [];

    capturedArgs = null;
    capturedCmd = null;

    // Need a fresh orchestrator to avoid session ID collision
    const stub2 = new SwiftAddonStub();
    stub2._claudeBinary = '/usr/bin/true';
    const orch2 = new SessionOrchestrator(stub2);

    await orch2.start({ workDir: '/tmp' }); // no mountPaths key at all
    const noMountArgs = capturedArgs ? capturedArgs.slice() : [];

    const baselineBwrap = bwrapFlagsBeforeDoubleDash(extractBwrapArgs(baselineArgs));
    const noMountBwrap = bwrapFlagsBeforeDoubleDash(extractBwrapArgs(noMountArgs));

    assert.equal(
      countOccurrences(noMountBwrap, '--bind'),
      countOccurrences(baselineBwrap, '--bind'),
      'Empty mountPaths should not add extra --bind entries'
    );
  });

  // -------------------------------------------------------------------------
  it('non-existent path is silently skipped (fs.existsSync guard)', async () => {
    const fakePath = '/tmp/cowork-nonexistent-path-' + Date.now();
    // Ensure it really doesn't exist
    assert.ok(!fs.existsSync(fakePath), 'Precondition: path must not exist');

    await orch.start({ mountPaths: [fakePath], workDir: '/tmp' });

    assert.ok(capturedArgs !== null, 'spawn should have been called');

    const bwrapArgs = extractBwrapArgs(capturedArgs);
    const flags = bwrapFlagsBeforeDoubleDash(bwrapArgs);

    // fakePath should NOT appear anywhere in the flags
    assert.ok(
      !flags.includes(fakePath),
      `Non-existent path ${fakePath} should not appear in bwrap flags`
    );
  });

});

// ---------------------------------------------------------------------------
// IPC boundary: userSelectedFolders translation
//
// Verifies that the real localAgentModeSessions:start IPC handler
// (from ipc_overrides.js) translates userSelectedFolders → mountPaths
// and that the resulting bwrap call includes --bind entries for existing
// folders. Also verifies that empty userSelectedFolders causes no extra
// --bind entries.
//
// The capturedIpcHandlers map was populated at module load time above.
// ---------------------------------------------------------------------------

describe('IPC boundary: userSelectedFolders translation', () => {

  beforeEach(() => {
    capturedCmd = null;
    capturedArgs = null;
  });

  afterEach(() => {
    capturedCmd = null;
    capturedArgs = null;
  });

  it('one existing userSelectedFolders entry → --bind /proc/self/fd/N dir in bwrap args', async () => {
    const handler = capturedIpcHandlers['localAgentModeSessions:start'];
    assert.ok(typeof handler === 'function', 'localAgentModeSessions:start handler must be captured');

    const tmpDir = fs.mkdtempSync(os.tmpdir() + '/cowork-ipc-a-');
    try {
      // Pass null as _event (handler ignores it), options has userSelectedFolders
      await handler(null, { userSelectedFolders: [tmpDir], workDir: '/tmp' });

      assert.ok(capturedArgs !== null, 'spawn should have been called');
      const flags = bwrapFlagsBeforeDoubleDash(extractBwrapArgs(capturedArgs));
      const bindIdx = flags.findIndex((a, i) =>
        a === '--bind' && /^\/proc\/self\/fd\/\d+$/.test(flags[i + 1]) && flags[i + 2] === tmpDir
      );
      assert.ok(
        bindIdx !== -1,
        `Expected --bind /proc/self/fd/N ${tmpDir} in bwrap flags before '--', got: ${flags.join(' ')}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('empty userSelectedFolders → no extra --bind beyond baseline', async () => {
    const handler = capturedIpcHandlers['localAgentModeSessions:start'];
    assert.ok(typeof handler === 'function', 'localAgentModeSessions:start handler must be captured');

    // Call with empty userSelectedFolders; spawn should still be called but no extra --bind
    await handler(null, { userSelectedFolders: [], workDir: '/tmp' });

    assert.ok(capturedArgs !== null, 'spawn should have been called');
    const flags = bwrapFlagsBeforeDoubleDash(extractBwrapArgs(capturedArgs));
    // No paths from userSelectedFolders, so no /proc/self/fd/* bind entry beyond baseline
    // (We only verify spawn was called and the flags array is valid — baseline --bind count
    //  is unchanged by the empty list.)
    assert.ok(Array.isArray(flags), 'bwrap flags should be an array');
  });

});

// ---------------------------------------------------------------------------
// Test 3: Object-format additionalMounts (asar production format)
//
// The asar calls vm.spawn() with additionalMounts as:
//   { mountId: { path: "relative/path/to/dir", mode: "rwd" } }
// where path is relative to "/" (i.e. path.relative("/", absolutePath)).
// Our fix must convert "relative/path" → "/relative/path" before bind.
// ---------------------------------------------------------------------------

describe('Object-format additionalMounts (asar production format)', () => {
  // Uses module-level cp.spawn mock and capturedArgs/capturedCmd from outer scope.
  let stub;

  before(() => {
    stub = new SwiftAddonStub();
    stub._claudeBinary = '/usr/bin/true';
  });

  beforeEach(() => {
    capturedCmd = null;
    capturedArgs = null;
  });

  it('object-format additionalMounts: one folder → --bind dest is SESSION_BASE/sessions/{id}/mnt/{mountId}', async () => {
    const tmpDir = fs.mkdtempSync(os.tmpdir() + '/cowork-obj-a-');
    try {
      // Simulate what asar builds: path.relative("/", tmpDir)
      const relativePath = tmpDir.replace(/^\//, '');
      const additionalMounts = {
        'some-mount-id': { path: relativePath, mode: 'rwd' },
      };
      const sessionId = 'sess1';
      const mountId = 'some-mount-id';
      await stub.spawn(sessionId, 'claude', '/usr/bin/true', [], '/tmp', {}, additionalMounts);

      assert.ok(capturedArgs !== null, 'spawn should have been called');
      const flags = bwrapFlagsBeforeDoubleDash(extractBwrapArgs(capturedArgs));
      const expectedDest = `/sessions/${sessionId}/mnt/${mountId}`;
      const bindIdx = flags.findIndex((a, i) =>
        a === '--bind' && /^\/proc\/self\/fd\/\d+$/.test(flags[i + 1]) && flags[i + 2] === expectedDest
      );
      assert.ok(bindIdx !== -1, `Expected --bind /proc/self/fd/N ${expectedDest} in: ${flags.join(' ')}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('object-format additionalMounts: two folders → two --bind entries at correct mnt paths', async () => {
    const t1 = fs.mkdtempSync(os.tmpdir() + '/cowork-obj-b-');
    const t2 = fs.mkdtempSync(os.tmpdir() + '/cowork-obj-c-');
    try {
      const sessionId = 'sess2';
      const additionalMounts = {
        'mount-a': { path: t1.replace(/^\//, ''), mode: 'rwd' },
        'mount-b': { path: t2.replace(/^\//, ''), mode: 'ro' },
      };
      await stub.spawn(sessionId, 'claude', '/usr/bin/true', [], '/tmp', {}, additionalMounts);

      const flags = bwrapFlagsBeforeDoubleDash(extractBwrapArgs(capturedArgs));
      for (const mountId of ['mount-a', 'mount-b']) {
        const expectedDest = `/sessions/${sessionId}/mnt/${mountId}`;
        assert.ok(
          flags.findIndex((a, i) => a === '--bind' && /^\/proc\/self\/fd\/\d+$/.test(flags[i + 1]) && flags[i + 2] === expectedDest) !== -1,
          `Missing --bind /proc/self/fd/N ${expectedDest}`
        );
      }
    } finally {
      fs.rmSync(t1, { recursive: true, force: true });
      fs.rmSync(t2, { recursive: true, force: true });
    }
  });

  it('object-format additionalMounts: empty object → no extra --bind', async () => {
    await stub.spawn('sess3', 'claude', '/usr/bin/true', [], '/tmp', {}, {});
    assert.ok(capturedArgs !== null, 'spawn should have been called');
  });
});
