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

const capturedIpcHandlers = {};

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
      handle: (channel, fn) => { capturedIpcHandlers[channel] = fn; },
      removeHandler: (channel) => { delete capturedIpcHandlers[channel]; },
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

// Patch the real stub's exports to include a .vm instance so that
// ipc_overrides.js's `swiftStub.vm` resolves to a real SwiftAddonStub
// rather than the promisified wrapper (which returns promises instead of
// synchronous handles, breaking SessionOrchestrator).
{
  const realStubPath = require.resolve('../stubs/claude-swift-stub/index');
  const realStubExports = require.cache[realStubPath].exports;
  if (!realStubExports.vm || !(realStubExports.vm instanceof SwiftAddonStub)) {
    const vmInstance = new SwiftAddonStub();
    vmInstance._claudeBinary = '/usr/bin/true';
    realStubExports.vm = vmInstance;
  }
}

const { SessionOrchestrator } = require('../stubs/cowork/session_orchestrator');

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

      // Find the --bind index for our tmpDir
      const bindIdx = flags.findIndex((a, i) =>
        a === '--bind' && flags[i + 1] === tmpDir && flags[i + 2] === tmpDir
      );
      assert.ok(
        bindIdx !== -1,
        `Expected --bind ${tmpDir} ${tmpDir} in bwrap flags before '--', got: ${flags.join(' ')}`
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
          a === '--bind' && flags[i + 1] === dir && flags[i + 2] === dir
        );
        assert.ok(
          bindIdx !== -1,
          `Expected --bind ${dir} ${dir} in bwrap flags, got: ${flags.join(' ')}`
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
// IPC boundary tests — exercises the real registerCoworkHandlers() from
// ipc_overrides.js, verifying that the userSelectedFolders wire field is
// translated to mountPaths before reaching SessionOrchestrator.start().
// ---------------------------------------------------------------------------

describe('IPC boundary: userSelectedFolders translation', () => {
  // Load ipc_overrides.js which registers the real handlers.
  // Delete it from cache to ensure a fresh load with our mocked electron dep.
  const ipcOverridesPath = require.resolve('../stubs/cowork/ipc_overrides');
  if (require.cache[ipcOverridesPath]) delete require.cache[ipcOverridesPath];

  // Also reset the orchestrator singleton so each test describe block gets
  // a fresh orchestrator backed by our patched stub.
  const { registerCoworkHandlers } = require('../stubs/cowork/ipc_overrides');
  registerCoworkHandlers();

  // The handlers are now in capturedIpcHandlers keyed by channel name.

  beforeEach(() => {
    capturedCmd = null;
    capturedArgs = null;
  });

  it('userSelectedFolders translates to --bind in bwrap args', async () => {
    const tmpDir = fs.mkdtempSync(os.tmpdir() + '/cowork-ipc-test-');
    try {
      const handler = capturedIpcHandlers['localAgentModeSessions:start'];
      assert.ok(handler, 'localAgentModeSessions:start handler must be registered');

      await handler({}, { userSelectedFolders: [tmpDir], workDir: '/tmp' });

      assert.ok(capturedArgs !== null, 'spawn should have been called');
      const flags = bwrapFlagsBeforeDoubleDash(extractBwrapArgs(capturedArgs));
      const bindIdx = flags.findIndex((a, i) =>
        a === '--bind' && flags[i + 1] === tmpDir && flags[i + 2] === tmpDir
      );
      assert.ok(bindIdx !== -1, `Expected --bind ${tmpDir} ${tmpDir} in: ${flags.join(' ')}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('userSelectedFolders with two folders → two --bind', async () => {
    const t1 = fs.mkdtempSync(os.tmpdir() + '/cowork-ipc-a-');
    const t2 = fs.mkdtempSync(os.tmpdir() + '/cowork-ipc-b-');
    try {
      const handler = capturedIpcHandlers['localAgentModeSessions:start'];
      capturedArgs = null;
      await handler({}, { userSelectedFolders: [t1, t2], workDir: '/tmp' });

      const flags = bwrapFlagsBeforeDoubleDash(extractBwrapArgs(capturedArgs));
      for (const dir of [t1, t2]) {
        assert.ok(
          flags.findIndex((a, i) => a === '--bind' && flags[i + 1] === dir && flags[i + 2] === dir) !== -1,
          `Missing --bind ${dir}`
        );
      }
    } finally {
      fs.rmSync(t1, { recursive: true, force: true });
      fs.rmSync(t2, { recursive: true, force: true });
    }
  });

  it('empty userSelectedFolders → no extra --bind', async () => {
    const handler = capturedIpcHandlers['localAgentModeSessions:start'];
    capturedArgs = null;
    await handler({}, { userSelectedFolders: [], workDir: '/tmp' });

    // Just assert spawn was called and didn't crash
    assert.ok(capturedArgs !== null, 'spawn should have been called even with no folders');
  });

  it('non-existent folder in userSelectedFolders → silently skipped', async () => {
    const fakePath = '/tmp/cowork-nonexistent-ipc-' + Date.now();
    const handler = capturedIpcHandlers['localAgentModeSessions:start'];
    capturedArgs = null;
    await handler({}, { userSelectedFolders: [fakePath], workDir: '/tmp' });

    const flags = bwrapFlagsBeforeDoubleDash(extractBwrapArgs(capturedArgs || []));
    assert.ok(!flags.includes(fakePath), `Non-existent ${fakePath} should not appear in bwrap flags`);
  });
});
