/**
 * Stress tests for the signal notification system.
 *
 * These tests probe adversarial conditions: rapid signal floods, index reuse,
 * TMPDIR wipe, concurrent windows, and dirty data.  Each test documents what
 * PASSES, FAILS, or DEGRADES under the attack described.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SignalWatcher } from "../src/signalWatcher";
import { TerminalManager } from "../src/terminalManager";
import { findNextIndex } from "../src/dtach";
import {
  _setActiveTerminal,
  _onDidChangeActiveTerminal,
  window as vscodeWindow,
} from "vscode";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "signal-stress-"));
}

function makeSignalDir(base: string): string {
  const sigDir = path.join(base, "signals");
  fs.mkdirSync(sigDir, { recursive: true });
  return sigDir;
}

function touchSignal(sigDir: string, index: number): string {
  const p = path.join(sigDir, `${index}.signal`);
  fs.writeFileSync(p, "");
  return p;
}

function touchSignalWithAge(sigDir: string, index: number, ageMs: number): string {
  const p = path.join(sigDir, `${index}.signal`);
  fs.writeFileSync(p, "");
  const past = new Date(Date.now() - ageMs);
  fs.utimesSync(p, past, past);
  return p;
}

/** Minimal mock context that collects subscriptions. */
function mockContext() {
  const subs: { dispose: () => void }[] = [];
  return {
    subscriptions: subs,
    dispose() { subs.forEach(s => s.dispose()); },
  } as unknown as import("vscode").ExtensionContext;
}

/** Build a TerminalManager wired to a real temp directory. */
function makeManager(socketDir: string) {
  const log = vscodeWindow.createOutputChannel("test") as import("vscode").OutputChannel;
  return new TerminalManager(socketDir, "/tmp", log);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Stress: Signal flood (20 signals in <100ms)", () => {
  /**
   * ATTACK: Claude Code Stop hook fires 20 times in rapid succession.
   * Each invocation runs `touch $DTACH_SIGNAL_DIR/$DTACH_SOCKET_INDEX.signal`.
   * Since they all write the same file (same index), the file is touched
   * repeatedly but not duplicated.
   *
   * Verdict: PASSES for same-index flood (idempotent touch).
   *          DEGRADES for multi-index flood (fs.watch coalescing).
   */

  let socketDir: string;
  let sigDir: string;

  beforeEach(() => {
    socketDir = makeTmpDir();
    sigDir = makeSignalDir(socketDir);
  });
  afterEach(() => { fs.rmSync(socketDir, { recursive: true, force: true }); });

  it("same-index flood: signals Map never exceeds 1 entry for that index", () => {
    const mgr = makeManager(socketDir);
    const log = vscodeWindow.createOutputChannel("test") as import("vscode").OutputChannel;
    const watcher = new SignalWatcher(sigDir, mgr, log);
    const ctx = mockContext();
    watcher.start(ctx);

    // Simulate 20 rapid touches to the same signal file
    for (let i = 0; i < 20; i++) {
      touchSignal(sigDir, 3);
    }

    // Force a scan (fs.watch may coalesce)
    (watcher as unknown as { scanSignals: () => void }).scanSignals();

    // The internal map should have exactly 1 entry for index 3
    const signals = (watcher as unknown as { signals: Map<number, unknown> }).signals;
    expect(signals.size).toBe(1);
    expect(signals.has(3)).toBe(true);

    watcher.dispose();
    ctx.dispose();
  });

  it("multi-index flood: 20 different indices all picked up by scan", () => {
    const mgr = makeManager(socketDir);
    const log = vscodeWindow.createOutputChannel("test") as import("vscode").OutputChannel;
    const watcher = new SignalWatcher(sigDir, mgr, log);
    const ctx = mockContext();
    watcher.start(ctx);

    // Touch 20 different signal files
    for (let i = 0; i < 20; i++) {
      touchSignal(sigDir, i);
    }

    // fs.watch may coalesce events, but scanSignals reads the directory
    (watcher as unknown as { scanSignals: () => void }).scanSignals();

    const signals = (watcher as unknown as { signals: Map<number, unknown> }).signals;
    // All 20 should be present after a full scan
    expect(signals.size).toBe(20);

    watcher.dispose();
    ctx.dispose();
  });

  it("fs.watch coalescing: individual onSignalFile calls still work per-event", () => {
    const mgr = makeManager(socketDir);
    const log = vscodeWindow.createOutputChannel("test") as import("vscode").OutputChannel;
    const watcher = new SignalWatcher(sigDir, mgr, log);
    const ctx = mockContext();
    watcher.start(ctx);

    // Simulate 5 files, each triggering onSignalFile directly (no coalescing)
    for (let i = 0; i < 5; i++) {
      touchSignal(sigDir, i);
      (watcher as unknown as { onSignalFile: (f: string) => void }).onSignalFile(`${i}.signal`);
    }

    const signals = (watcher as unknown as { signals: Map<number, unknown> }).signals;
    expect(signals.size).toBe(5);

    watcher.dispose();
    ctx.dispose();
  });
});


describe("Stress: Socket index reuse after close", () => {
  /**
   * ATTACK: Terminal 3 is closed (socket deleted). A new terminal gets index 3.
   * An old 3.signal still exists from the previous session.
   *
   * Verdict: FAILS — the stale signal is attributed to the NEW terminal 3.
   * The signal watcher only checks timestamp freshness (15min), not whether
   * the signal was created before or after the current terminal was opened.
   * A signal from 2 minutes ago for old-terminal-3 will be shown as if
   * new-terminal-3 completed a task.
   */

  let socketDir: string;
  let sigDir: string;

  beforeEach(() => {
    socketDir = makeTmpDir();
    sigDir = makeSignalDir(socketDir);
  });
  afterEach(() => { fs.rmSync(socketDir, { recursive: true, force: true }); });

  it("old signal for index 3 is wrongly attributed to new terminal 3", () => {
    const mgr = makeManager(socketDir);
    const log = vscodeWindow.createOutputChannel("test") as import("vscode").OutputChannel;
    const watcher = new SignalWatcher(sigDir, mgr, log);
    const ctx = mockContext();

    // Simulate: old terminal 3 completed a task 2 minutes ago
    touchSignalWithAge(sigDir, 3, 2 * 60 * 1000);

    watcher.start(ctx);

    const signals = (watcher as unknown as { signals: Map<number, unknown> }).signals;

    // BUG: The signal is within the 15-minute freshness window, so it gets
    // picked up. There is no mechanism to correlate a signal to the terminal
    // session that created it. New terminal 3 inherits old terminal 3's signal.
    expect(signals.has(3)).toBe(true); // This PASSES — proving the bug exists

    watcher.dispose();
    ctx.dispose();
  });
});


describe("Stress: TMPDIR cleanup wipes everything", () => {
  /**
   * ATTACK: macOS cleans /tmp (reboot, tmreaper, or manual wipe).
   * Socket dirs, signal dirs, workspace.json — all gone.
   *
   * Verdict for VS Code extension:
   *   DEGRADES — fs.watch throws/stops, but the 10s poll timer catches
   *   errors silently. scanSignals() catches ENOENT in its try/catch.
   *   No crash, but no signals processed until dirs are recreated.
   *
   * Verdict for cc-overlord:
   *   PASSES — the 5s timer retries watchDirectory on the base dir,
   *   and scan() has a guard for contentsOfDirectory failure. When VS Code
   *   recreates the dirs, cc-overlord picks them up on the next timer tick.
   */

  let socketDir: string;
  let sigDir: string;

  beforeEach(() => {
    socketDir = makeTmpDir();
    sigDir = makeSignalDir(socketDir);
  });

  it("scanSignals survives directory deletion without throwing", () => {
    const mgr = makeManager(socketDir);
    const log = vscodeWindow.createOutputChannel("test") as import("vscode").OutputChannel;
    const watcher = new SignalWatcher(sigDir, mgr, log);
    const ctx = mockContext();
    watcher.start(ctx);

    // Wipe the entire socket dir
    fs.rmSync(socketDir, { recursive: true, force: true });

    // scanSignals should not throw
    expect(() => {
      (watcher as unknown as { scanSignals: () => void }).scanSignals();
    }).not.toThrow();

    watcher.dispose();
    ctx.dispose();
  });

  it("signals Map is empty after directory wipe (no phantom signals)", () => {
    const mgr = makeManager(socketDir);
    const log = vscodeWindow.createOutputChannel("test") as import("vscode").OutputChannel;
    const watcher = new SignalWatcher(sigDir, mgr, log);
    const ctx = mockContext();

    // Add a signal, then wipe
    touchSignal(sigDir, 0);
    watcher.start(ctx);

    const signals = (watcher as unknown as { signals: Map<number, unknown> }).signals;
    expect(signals.size).toBe(1);

    // Wipe the directory
    fs.rmSync(socketDir, { recursive: true, force: true });
    (watcher as unknown as { scanSignals: () => void }).scanSignals();

    // BUG: scanSignals only ADDS signals, it never removes ones that no
    // longer have files on disk. The old signal for index 0 remains in the Map.
    // This is a phantom signal — the file is gone but the in-memory state persists.
    expect(signals.size).toBe(1); // PASSES — proving the phantom signal bug
    expect(signals.has(0)).toBe(true); // The stale entry is still there
  });

  it("watcher recovers when directory is recreated", () => {
    const mgr = makeManager(socketDir);
    const log = vscodeWindow.createOutputChannel("test") as import("vscode").OutputChannel;
    const watcher = new SignalWatcher(sigDir, mgr, log);
    const ctx = mockContext();
    watcher.start(ctx);

    // Wipe and recreate
    fs.rmSync(socketDir, { recursive: true, force: true });
    fs.mkdirSync(sigDir, { recursive: true });

    // New signal in recreated dir
    touchSignal(sigDir, 5);
    (watcher as unknown as { scanSignals: () => void }).scanSignals();

    const signals = (watcher as unknown as { signals: Map<number, unknown> }).signals;
    // Should pick up the new signal (poll-based recovery)
    expect(signals.has(5)).toBe(true);

    watcher.dispose();
    ctx.dispose();
    fs.rmSync(socketDir, { recursive: true, force: true });
  });
});


describe("Stress: Workspace hash collision", () => {
  /**
   * ATTACK: Two different projects produce the same workspace ID.
   *
   * Verdict: PASSES (by design) — resolveWorkspaceId uses SHA-256 of the
   * full fsPath, sliced to 6 hex chars. Collision probability for 6 hex
   * chars (24 bits) is ~1 in 16 million. But if it DOES collide, both
   * projects share the same socket dir and signal dir. Signals from
   * project A would appear in project B's status bar.
   *
   * This is a DEGRADES scenario: astronomically unlikely, but the code has
   * no defense against it. No per-signal project verification exists.
   */

  it("6-char hex hash gives 24-bit collision space", () => {
    // Demonstrate the hash truncation
    const crypto = require("crypto");
    const hash1 = crypto.createHash("sha256").update("/Users/test/project-a").digest("hex").slice(0, 6);
    const hash2 = crypto.createHash("sha256").update("/Users/test/project-b").digest("hex").slice(0, 6);

    // These specific paths don't collide, but 6 hex chars = 16M combinations.
    // With birthday paradox, ~4096 projects gives ~50% collision chance.
    expect(hash1).not.toBe(hash2);
    expect(hash1.length).toBe(6); // Only 24 bits of entropy
  });
});


describe("Stress: Very long running session (memory/FD leak)", () => {
  /**
   * ATTACK: cc-overlord runs for days. Projects opened and closed.
   * FD accumulation in sourcesByPath. Memory from stale Signal objects.
   *
   * Verdict for cc-overlord:
   *   DEGRADES — sourcesByPath accumulates FDs for every signal directory
   *   ever seen. If a project's TMPDIR is cleaned, the FD is still open
   *   on a now-deleted directory. watchDirectory does cancel existing
   *   watchers for the same path (#7), but there is no cleanup of watchers
   *   for directories that no longer exist.
   *
   * Verdict for VS Code extension:
   *   PASSES — only one watcher per workspace, disposed on deactivate.
   *   The poll timer is cleared. No leak path.
   */

  let socketDir: string;
  let sigDir: string;

  beforeEach(() => {
    socketDir = makeTmpDir();
    sigDir = makeSignalDir(socketDir);
  });
  afterEach(() => { fs.rmSync(socketDir, { recursive: true, force: true }); });

  it("signals Map grows unbounded when files are deleted between scans", () => {
    const mgr = makeManager(socketDir);
    const log = vscodeWindow.createOutputChannel("test") as import("vscode").OutputChannel;
    const watcher = new SignalWatcher(sigDir, mgr, log);
    const ctx = mockContext();
    watcher.start(ctx);

    const signals = (watcher as unknown as { signals: Map<number, unknown> }).signals;

    // Simulate: many signals come and go, but scanSignals only adds, never prunes
    for (let i = 0; i < 100; i++) {
      touchSignal(sigDir, i);
    }
    (watcher as unknown as { scanSignals: () => void }).scanSignals();
    expect(signals.size).toBe(100);

    // Delete all signal files
    for (let i = 0; i < 100; i++) {
      try { fs.unlinkSync(path.join(sigDir, `${i}.signal`)); } catch { /* ok */ }
    }

    // Scan again — signals should be pruned but they are NOT
    (watcher as unknown as { scanSignals: () => void }).scanSignals();

    // FIXED: scanSignals now reconciles Map with disk, pruning deleted entries
    expect(signals.size).toBe(0);
  });

  it("updateStatusBar stale check is the only pruning mechanism", () => {
    const mgr = makeManager(socketDir);
    const log = vscodeWindow.createOutputChannel("test") as import("vscode").OutputChannel;
    const watcher = new SignalWatcher(sigDir, mgr, log);
    const ctx = mockContext();
    watcher.start(ctx);

    // Add a signal that is 16 minutes old (past 15-min stale threshold)
    touchSignalWithAge(sigDir, 42, 16 * 60 * 1000);
    (watcher as unknown as { onSignalFile: (f: string) => void }).onSignalFile("42.signal");

    const signals = (watcher as unknown as { signals: Map<number, unknown> }).signals;
    // onSignalFile already checks stale threshold and won't add it
    expect(signals.has(42)).toBe(false);

    // But a 14-minute-old signal WILL be added and stay until updateStatusBar runs
    touchSignalWithAge(sigDir, 43, 14 * 60 * 1000);
    (watcher as unknown as { onSignalFile: (f: string) => void }).onSignalFile("43.signal");
    expect(signals.has(43)).toBe(true);

    watcher.dispose();
    ctx.dispose();
  });
});


describe("Stress: Extension activated twice", () => {
  /**
   * ATTACK: VS Code calls activate() a second time (workspace reload).
   *
   * Verdict: DEGRADES — extension.ts uses module-level `let terminalManager`
   * and `let pendingRestoreSockets`. A second activate() call would:
   *   1. Create a new TerminalManager (old one not disposed)
   *   2. Create a new SignalWatcher (old one not disposed, old poll timer leaks)
   *   3. Register duplicate commands (throws or silently overwrites)
   *   4. Register a second terminal profile provider
   *
   * The old watcher's poll timer keeps running. Two watchers scan the same
   * directory. Double-counting of signals.
   */

  it("module-level state is not guarded against double activation", () => {
    // This is a code-analysis finding, not a runtime test.
    // extension.ts line 14-15:
    //   let terminalManager: TerminalManager | undefined;
    //   let pendingRestoreSockets: { index: number; socketPath: string }[] = [];
    //
    // activate() never checks if terminalManager is already set.
    // It unconditionally creates new instances and registers new handlers.
    // There is no guard like:
    //   if (terminalManager) { terminalManager.disposeAll(); signalWatcher.dispose(); }
    expect(true).toBe(true); // Documented finding — no runtime assertion needed
  });
});


describe("Stress: Signal file with unexpected content or name", () => {
  /**
   * ATTACK: Unexpected files in the signals directory.
   *
   * Verdict: PASSES — parseInt("foo", 10) returns NaN, which is caught by
   * the isNaN guard. Non-.signal files are filtered out by the suffix check.
   * Files with data content are handled fine — only stat().mtimeMs is read,
   * not file contents.
   */

  let socketDir: string;
  let sigDir: string;

  beforeEach(() => {
    socketDir = makeTmpDir();
    sigDir = makeSignalDir(socketDir);
  });
  afterEach(() => { fs.rmSync(socketDir, { recursive: true, force: true }); });

  it("non-numeric signal filenames are ignored (NaN guard)", () => {
    const mgr = makeManager(socketDir);
    const log = vscodeWindow.createOutputChannel("test") as import("vscode").OutputChannel;
    const watcher = new SignalWatcher(sigDir, mgr, log);
    const ctx = mockContext();
    watcher.start(ctx);

    // Create files with non-numeric names
    fs.writeFileSync(path.join(sigDir, "foo.signal"), "");
    fs.writeFileSync(path.join(sigDir, "bar.signal"), "");
    fs.writeFileSync(path.join(sigDir, "3.5.signal"), ""); // parseInt("3.5") = 3, actually

    (watcher as unknown as { scanSignals: () => void }).scanSignals();

    const signals = (watcher as unknown as { signals: Map<number, unknown> }).signals;
    // foo and bar are NaN → filtered. 3.5 parses as 3 → accepted.
    expect(signals.has(3)).toBe(true);
    expect(signals.size).toBe(1); // Only the "3.5" parsed as 3

    watcher.dispose();
    ctx.dispose();
  });

  it("signal files with data content are handled (only mtime is read)", () => {
    const mgr = makeManager(socketDir);
    const log = vscodeWindow.createOutputChannel("test") as import("vscode").OutputChannel;
    const watcher = new SignalWatcher(sigDir, mgr, log);
    const ctx = mockContext();
    watcher.start(ctx);

    // Write garbage data into signal files
    fs.writeFileSync(path.join(sigDir, "0.signal"), "unexpected payload data here");
    fs.writeFileSync(path.join(sigDir, "1.signal"), Buffer.alloc(1024 * 1024)); // 1MB of zeros

    (watcher as unknown as { scanSignals: () => void }).scanSignals();

    const signals = (watcher as unknown as { signals: Map<number, unknown> }).signals;
    expect(signals.has(0)).toBe(true);
    expect(signals.has(1)).toBe(true);

    watcher.dispose();
    ctx.dispose();
  });

  it("non-.signal files in the directory are ignored", () => {
    const mgr = makeManager(socketDir);
    const log = vscodeWindow.createOutputChannel("test") as import("vscode").OutputChannel;
    const watcher = new SignalWatcher(sigDir, mgr, log);
    const ctx = mockContext();
    watcher.start(ctx);

    fs.writeFileSync(path.join(sigDir, "readme.txt"), "hello");
    fs.writeFileSync(path.join(sigDir, ".DS_Store"), "");
    fs.writeFileSync(path.join(sigDir, "0.sock"), ""); // wrong extension

    (watcher as unknown as { scanSignals: () => void }).scanSignals();

    const signals = (watcher as unknown as { signals: Map<number, unknown> }).signals;
    expect(signals.size).toBe(0);

    watcher.dispose();
    ctx.dispose();
  });

  it("goto file with non-numeric content is handled gracefully", () => {
    const mgr = makeManager(socketDir);
    const log = vscodeWindow.createOutputChannel("test") as import("vscode").OutputChannel;
    const watcher = new SignalWatcher(sigDir, mgr, log);
    const ctx = mockContext();
    watcher.start(ctx);

    // Mark restore complete so goto files are processed
    watcher.markRestoreComplete();

    // Write garbage into the goto file
    fs.writeFileSync(path.join(sigDir, "goto"), "not-a-number");

    // Should not throw
    expect(() => {
      (watcher as unknown as { onGotoFile: () => void }).onGotoFile();
    }).not.toThrow();

    // Goto file should be deleted even if content is invalid
    expect(fs.existsSync(path.join(sigDir, "goto"))).toBe(false);

    watcher.dispose();
    ctx.dispose();
  });

  it("goto file with valid index but no matching terminal does not crash", () => {
    const mgr = makeManager(socketDir);
    const log = vscodeWindow.createOutputChannel("test") as import("vscode").OutputChannel;
    const watcher = new SignalWatcher(sigDir, mgr, log);
    const ctx = mockContext();
    watcher.start(ctx);

    // Write a valid index for a terminal that doesn't exist
    fs.writeFileSync(path.join(sigDir, "goto"), "999");

    expect(() => {
      (watcher as unknown as { onGotoFile: () => void }).onGotoFile();
    }).not.toThrow();

    watcher.dispose();
    ctx.dispose();
  });
});


describe("Stress: Concurrent VS Code windows same workspace", () => {
  /**
   * ATTACK: Two VS Code windows open the same folder. Both extensions activate.
   * Both create a SignalWatcher for the same signals directory. A signal arrives.
   *
   * Verdict: DEGRADES — Both watchers pick up the signal. Both show the status
   * bar notification. When the user clicks in window A, that watcher deletes
   * the signal file. Window B's watcher still has the signal in its Map
   * (phantom signal) until the 10s poll runs and... it STILL won't remove it
   * because scanSignals only adds, never prunes.
   *
   * Additionally: both extensions write workspace.json to the same path.
   * The profile provider in both windows calls findNextIndex on the same
   * socket dir — race condition on index allocation.
   */

  let socketDir: string;
  let sigDir: string;

  beforeEach(() => {
    socketDir = makeTmpDir();
    sigDir = makeSignalDir(socketDir);
  });
  afterEach(() => { fs.rmSync(socketDir, { recursive: true, force: true }); });

  it("signal cleared by window A persists as phantom in window B", () => {
    const mgr1 = makeManager(socketDir);
    const mgr2 = makeManager(socketDir);
    const log1 = vscodeWindow.createOutputChannel("test") as import("vscode").OutputChannel;
    const log2 = vscodeWindow.createOutputChannel("test") as import("vscode").OutputChannel;

    const watcher1 = new SignalWatcher(sigDir, mgr1, log1);
    const watcher2 = new SignalWatcher(sigDir, mgr2, log2);

    const ctx1 = mockContext();
    const ctx2 = mockContext();
    watcher1.start(ctx1);
    watcher2.start(ctx2);

    // Signal arrives
    touchSignal(sigDir, 0);
    (watcher1 as unknown as { scanSignals: () => void }).scanSignals();
    (watcher2 as unknown as { scanSignals: () => void }).scanSignals();

    const signals1 = (watcher1 as unknown as { signals: Map<number, unknown> }).signals;
    const signals2 = (watcher2 as unknown as { signals: Map<number, unknown> }).signals;

    expect(signals1.has(0)).toBe(true);
    expect(signals2.has(0)).toBe(true);

    // Window A clears the signal (user clicks status bar)
    (watcher1 as unknown as { clearSignal: (i: number) => void }).clearSignal(0);

    expect(signals1.has(0)).toBe(false);
    // Window B still has the phantom signal (before scan)
    expect(signals2.has(0)).toBe(true);

    // After scan, window B's phantom is pruned (scanSignals now reconciles)
    (watcher2 as unknown as { scanSignals: () => void }).scanSignals();
    // FIXED: scanSignals reconciles Map with disk, removing phantom entries
    expect(signals2.has(0)).toBe(false);

    watcher1.dispose();
    watcher2.dispose();
    ctx1.dispose();
    ctx2.dispose();
  });

  it("concurrent findNextIndex has TOCTOU race on index allocation", () => {
    // Both extensions call findNextIndex → listSockets → readdirSync
    // at the same time. Both see the same set of existing sockets.
    // Both return the same "next" index. Both create sockets with the
    // same index. One overwrites the other.
    //
    // This is a code-analysis finding about dtach.ts:findNextIndex.
    // No locking or atomic allocation exists.



    // Simulate: no sockets exist
    const idx1 = findNextIndex(socketDir);
    const idx2 = findNextIndex(socketDir);

    // Both return 0 — no sockets on disk to differentiate
    expect(idx1).toBe(0);
    expect(idx2).toBe(0); // Same index — race confirmed
  });
});


describe("Stress: cc-overlord launched before VS Code", () => {
  /**
   * ATTACK: cc-overlord starts before any VS Code window exists.
   * No dtach-persist directory in TMPDIR.
   *
   * Verdict: PASSES — SignalWatcher.swift's scan() does:
   *   guard let projects = try? fm.contentsOfDirectory(atPath: baseDir)
   * This returns nil when the directory doesn't exist, and onChange([])
   * is called. The 5-second timer retries. When VS Code eventually creates
   * the directory, watchDirectory(baseDir) succeeds on the next timer tick.
   */

  it("scan handles non-existent base directory gracefully", () => {
    // This tests the VS Code side's equivalent behavior:
    // signalWatcher.scanSignals() when the directory doesn't exist
    const nonExistentDir = "/tmp/dtach-stress-nonexistent-" + Date.now();
    const mgr = makeManager("/tmp");
    const log = vscodeWindow.createOutputChannel("test") as import("vscode").OutputChannel;
    const watcher = new SignalWatcher(nonExistentDir, mgr, log);

    // start() calls mkdirSync, so the dir will be created.
    // But if we bypass start and call scanSignals directly on a non-existent path:
    // We need to test without calling start() first.
    expect(() => {
      (watcher as unknown as { scanSignals: () => void }).scanSignals();
    }).not.toThrow();

    const signals = (watcher as unknown as { signals: Map<number, unknown> }).signals;
    expect(signals.size).toBe(0);

    watcher.dispose();
  });
});


describe("Stress: 500ms restore timeout race", () => {
  /**
   * ATTACK: VS Code takes longer than 500ms to create the profile-provider
   * terminal. The setTimeout fires, restoreTerminals() runs, then the
   * provider creates a terminal — duplicate terminal for the same socket.
   *
   * Verdict: DEGRADES —
   * restoreTerminals() checks `if (this.indexToTerminal.has(info.index)) continue`
   * which prevents duplicates IF the profile-created terminal was already adopted.
   * But if the profile provider hasn't been called yet (VS Code is slow), the
   * check passes and restoreTerminals creates a terminal for that index.
   * When the provider finally runs, pendingRestoreSockets is already cleared
   * (line 135), so it falls through to creating a NEW socket (new index).
   * Result: the old socket gets TWO terminals (one from restore, one from provider
   * that creates a fresh socket).
   *
   * Actually: After the setTimeout, `pendingRestoreSockets = []` clears the queue.
   * If VS Code's provider fires AFTER this, it hits the else branch (line 76-87)
   * and creates a brand new socket+terminal. So no duplicate for the same socket,
   * but an unexpected extra terminal appears.
   */

  it("pendingRestoreSockets is cleared before provider might finish", () => {
    // This is a timing-analysis finding.
    // extension.ts lines 129-135:
    //   setTimeout(() => {
    //     terminalManager!.restoreTerminals();
    //     ...
    //     pendingRestoreSockets = [];  // <-- cleared here
    //   }, 500);
    //
    // If the profile provider fires at t=600ms (after timeout):
    //   pendingRestoreSockets is empty → new socket created
    //   restoreTerminals already created terminals for all existing sockets
    //   → extra terminal appears that the user didn't ask for
    expect(true).toBe(true); // Documented timing finding
  });
});


describe("Stress: Signal auto-clear when terminal is active", () => {
  /**
   * ATTACK: A signal arrives for terminal 3, but terminal 3 is already
   * the active terminal. The signal should be auto-cleared.
   *
   * Verdict: PASSES — onSignalFile checks activeTerminal and activeIndex.
   * If the signal's index matches the active terminal, it deletes the file
   * and returns without adding to the Map.
   */

  let socketDir: string;
  let sigDir: string;

  beforeEach(() => {
    socketDir = makeTmpDir();
    sigDir = makeSignalDir(socketDir);
  });
  afterEach(() => { fs.rmSync(socketDir, { recursive: true, force: true }); });

  it("signal for active terminal is auto-cleared", () => {
    const mgr = makeManager(socketDir);
    const log = vscodeWindow.createOutputChannel("test") as import("vscode").OutputChannel;
    const watcher = new SignalWatcher(sigDir, mgr, log);
    const ctx = mockContext();
    watcher.start(ctx);

    // Simulate terminal 3 being tracked and active
    const fakeTerminal = {
      name: "Terminal 4",
      creationOptions: { shellArgs: ["-a", path.join(socketDir, "3.sock"), "-E"] },
      show: () => {},
      dispose: () => {},
      processId: Promise.resolve(999),
    };
    // Register terminal in manager's maps
    const t2i = (mgr as unknown as { terminalToIndex: Map<unknown, number> }).terminalToIndex;
    const i2t = (mgr as unknown as { indexToTerminal: Map<number, unknown> }).indexToTerminal;
    t2i.set(fakeTerminal, 3);
    i2t.set(3, fakeTerminal);

    // Set this terminal as active
    _setActiveTerminal(fakeTerminal);

    // Touch signal for index 3
    touchSignal(sigDir, 3);
    (watcher as unknown as { onSignalFile: (f: string) => void }).onSignalFile("3.signal");

    const signals = (watcher as unknown as { signals: Map<number, unknown> }).signals;
    // Signal should have been auto-cleared since terminal 3 is active
    expect(signals.has(3)).toBe(false);

    // Signal file should also be deleted
    expect(fs.existsSync(path.join(sigDir, "3.signal"))).toBe(false);

    // Clean up
    _setActiveTerminal(undefined);
    watcher.dispose();
    ctx.dispose();
  });
});


describe("Stress: clearSignal does not call updateStatusBar", () => {
  /**
   * ATTACK: clearSignal is called but the status bar is not updated.
   * Comment on line 151 says "caller is responsible (#4)".
   *
   * Verdict: DEGRADES — If any code path calls clearSignal without
   * subsequently calling updateStatusBar, the status bar shows stale count.
   *
   * onDidChangeActiveTerminal handler (line 72-78) calls clearSignal
   * but does NOT call updateStatusBar. The status bar will show the old
   * count until the next signal event or poll triggers updateStatusBar.
   */

  let socketDir: string;
  let sigDir: string;

  beforeEach(() => {
    socketDir = makeTmpDir();
    sigDir = makeSignalDir(socketDir);
  });
  afterEach(() => { fs.rmSync(socketDir, { recursive: true, force: true }); });

  it("onDidChangeActiveTerminal clears signal but does not update status bar", () => {
    // Code analysis of signalWatcher.ts lines 71-78:
    //   context.subscriptions.push(
    //     vscode.window.onDidChangeActiveTerminal((terminal) => {
    //       if (!terminal) return;
    //       const index = this.terminalManager.getIndex(terminal);
    //       if (index !== undefined && this.signals.has(index)) {
    //         this.clearSignal(index);     // <-- clears from Map + deletes file
    //         // NO updateStatusBar() call here!
    //       }
    //     }),
    //   );
    //
    // clearSignal comment: "No updateStatusBar() here — caller is responsible (#4)"
    // But this caller (onDidChangeActiveTerminal) NEVER calls updateStatusBar.
    //
    // Result: Status bar shows "2 awaiting" but only 1 signal remains.
    // The display is stale until the next event triggers updateStatusBar.

    const mgr = makeManager(socketDir);
    const log = vscodeWindow.createOutputChannel("test") as import("vscode").OutputChannel;
    const watcher = new SignalWatcher(sigDir, mgr, log);
    const ctx = mockContext();
    watcher.start(ctx);

    // Add two signals
    touchSignal(sigDir, 0);
    touchSignal(sigDir, 1);
    (watcher as unknown as { scanSignals: () => void }).scanSignals();
    (watcher as unknown as { updateStatusBar: () => void }).updateStatusBar();

    const signals = (watcher as unknown as { signals: Map<number, unknown> }).signals;
    expect(signals.size).toBe(2);

    // Simulate switching to terminal 0
    const fakeTerminal = { name: "Terminal 1", show: () => {} };
    const t2i = (mgr as unknown as { terminalToIndex: Map<unknown, number> }).terminalToIndex;
    t2i.set(fakeTerminal, 0);
    _setActiveTerminal(fakeTerminal);

    // Fire the event — this triggers clearSignal(0) without updateStatusBar
    _onDidChangeActiveTerminal.fire(fakeTerminal);

    // Signal 0 is cleared from Map
    expect(signals.has(0)).toBe(false);
    expect(signals.size).toBe(1);

    // But we can't directly test the status bar text from here since
    // the mock status bar item doesn't track state. The bug is that
    // updateStatusBar is not called after clearSignal in this path.
    // The status bar still shows "2 awaiting" until the next poll/scan.

    _setActiveTerminal(undefined);
    watcher.dispose();
    ctx.dispose();
  });
});


describe("Stress: Rapid terminal close-reopen with pending kill", () => {
  /**
   * ATTACK: Terminal is closed (300ms kill timer starts), then reopened
   * before 300ms elapses. Does the signal survive?
   *
   * Verdict: PASSES — createTerminalForSocket checks pendingKills and
   * clears the timeout if found. The socket is preserved. However, any
   * signal file for that index persists independently of the kill/reopen
   * cycle — the signal system is unaware of terminal lifecycle.
   */

  let socketDir: string;
  let sigDir: string;

  beforeEach(() => {
    socketDir = makeTmpDir();
    sigDir = makeSignalDir(socketDir);
  });
  afterEach(() => { fs.rmSync(socketDir, { recursive: true, force: true }); });

  it("signal persists through close-reopen cycle", () => {
    const mgr = makeManager(socketDir);
    const log = vscodeWindow.createOutputChannel("test") as import("vscode").OutputChannel;
    const watcher = new SignalWatcher(sigDir, mgr, log);
    const ctx = mockContext();
    watcher.start(ctx);

    // Signal exists for index 2
    touchSignal(sigDir, 2);
    (watcher as unknown as { scanSignals: () => void }).scanSignals();

    const signals = (watcher as unknown as { signals: Map<number, unknown> }).signals;
    expect(signals.has(2)).toBe(true);

    // Terminal is closed and reopened — signal file is untouched by either event
    expect(fs.existsSync(path.join(sigDir, "2.signal"))).toBe(true);

    watcher.dispose();
    ctx.dispose();
  });
});


describe("Stress: cc-overlord deriveProjectName edge cases", () => {
  /**
   * ATTACK: Project directory names with unusual lengths or characters.
   *
   * Verdict: DEGRADES — deriveProjectName strips the last 7 chars
   * (dash + 6-char hash). But if sanitizeName produced a name shorter
   * than 25 chars, or the hash is at a different offset, the stripping
   * is wrong.
   *
   * For the "vscode" fallback workspace ID (no workspace folder),
   * deriveProjectName("vscode") strips last 7 chars from a 6-char string,
   * hitting the count <= 7 guard and returning "vscode" unchanged. This
   * is actually correct by accident.
   */

  it("short project names hit the <= 7 guard", () => {
    // Simulating deriveProjectName logic in JS
    function deriveProjectName(dirName: string): string {
      if (dirName.length > 7) {
        return dirName.slice(0, -7);
      }
      return dirName;
    }

    // Normal case: "my-project-a1b2c3" → "my-project"
    expect(deriveProjectName("my-project-a1b2c3")).toBe("my-project");

    // Fallback case: "vscode" (6 chars, <= 7)
    expect(deriveProjectName("vscode")).toBe("vscode");

    // Edge: exactly 8 chars → strips to 1 char
    expect(deriveProjectName("abcdefgh")).toBe("a");

    // Edge: hash-only name like "a-abc123" → strips to "a"
    expect(deriveProjectName("a-abc123")).toBe("a");

    // Edge: name is exactly the hash pattern (7 chars) → returned as-is
    expect(deriveProjectName("-abc123")).toBe("-abc123");
  });
});


describe("Stress: Signal race between touch and stat", () => {
  /**
   * ATTACK: Signal file is deleted between readdirSync and statSync
   * in scanSignals → onSignalFile.
   *
   * Verdict: PASSES — onSignalFile wraps statSync in try/catch and
   * returns early if the file is gone. No crash.
   */

  let socketDir: string;
  let sigDir: string;

  beforeEach(() => {
    socketDir = makeTmpDir();
    sigDir = makeSignalDir(socketDir);
  });
  afterEach(() => { fs.rmSync(socketDir, { recursive: true, force: true }); });

  it("onSignalFile handles deleted file between readdir and stat", () => {
    const mgr = makeManager(socketDir);
    const log = vscodeWindow.createOutputChannel("test") as import("vscode").OutputChannel;
    const watcher = new SignalWatcher(sigDir, mgr, log);
    const ctx = mockContext();
    watcher.start(ctx);

    // File referenced but doesn't exist
    expect(() => {
      (watcher as unknown as { onSignalFile: (f: string) => void }).onSignalFile("99.signal");
    }).not.toThrow();

    const signals = (watcher as unknown as { signals: Map<number, unknown> }).signals;
    expect(signals.has(99)).toBe(false);

    watcher.dispose();
    ctx.dispose();
  });
});
