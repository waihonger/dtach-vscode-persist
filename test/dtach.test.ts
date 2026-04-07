import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  listSockets,
  findNextIndex,
  socketFileExists,
  removeSocket,
  killDtachProcess,
  isProcessBehindSocket,
  cleanupDeadSockets,
  cleanupIdleWorkspaces,
} from "../src/dtach";

const DTACH = "/opt/homebrew/bin/dtach";

function spawnDtach(sockPath: string, cwd: string): void {
  execFileSync(DTACH, ["-n", sockPath, "-E", "-z", "/bin/zsh"], {
    cwd,
    timeout: 5000,
  });
}

function findPids(pattern: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", pattern], {
      encoding: "utf8",
      timeout: 5000,
    })
      .trim()
      .split("\n")
      .map((s) => parseInt(s, 10))
      .filter((n) => n > 0);
  } catch {
    return [];
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill all dtach processes spawned in a temp directory */
function killTestDtachProcesses(tmpDir: string): void {
  try {
    const pids = execFileSync("pgrep", ["-f", `dtach -n ${tmpDir}`], {
      encoding: "utf8",
      timeout: 5000,
    })
      .trim()
      .split("\n")
      .map((s) => parseInt(s, 10))
      .filter((n) => n > 0);
    for (const pid of pids) {
      try {
        // Kill children first
        const children = execFileSync("pgrep", ["-P", String(pid)], {
          encoding: "utf8",
          timeout: 5000,
        })
          .trim()
          .split("\n")
          .map((s) => parseInt(s, 10))
          .filter((n) => n > 0);
        for (const child of children) {
          try {
            process.kill(child, "SIGTERM");
          } catch {}
        }
      } catch {}
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  } catch {
    // no processes to kill
  }
}

describe("listSockets", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtach-test-"));
  });

  afterEach(() => {
    killTestDtachProcesses(tmpDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array for empty directory", () => {
    expect(listSockets(tmpDir)).toEqual([]);
  });

  it("returns empty array for non-existent directory", () => {
    expect(listSockets("/nonexistent/path")).toEqual([]);
  });

  it("ignores non-.sock files", () => {
    fs.writeFileSync(path.join(tmpDir, "readme.txt"), "");
    expect(listSockets(tmpDir)).toEqual([]);
  });
});

describe("findNextIndex", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtach-test-"));
  });

  afterEach(() => {
    killTestDtachProcesses(tmpDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 0 for empty directory", () => {
    expect(findNextIndex(tmpDir)).toBe(0);
  });
});

describe("socketFileExists", () => {
  it("returns false for non-existent path", () => {
    expect(socketFileExists("/nonexistent/path/0.sock")).toBe(false);
  });
});

describe("isProcessBehindSocket", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtach-test-"));
  });

  afterEach(() => {
    killTestDtachProcesses(tmpDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true when a dtach process is running for the socket", () => {
    const sockPath = path.join(tmpDir, "0.sock");
    spawnDtach(sockPath, tmpDir);
    expect(isProcessBehindSocket(sockPath)).toBe(true);
  });

  it("returns false when no process is running for the socket", () => {
    const sockPath = path.join(tmpDir, "0.sock");
    // Create a fake socket file with no process
    fs.writeFileSync(sockPath, "");
    expect(isProcessBehindSocket(sockPath)).toBe(false);
  });

  it("returns false for non-existent socket", () => {
    expect(isProcessBehindSocket(path.join(tmpDir, "nope.sock"))).toBe(false);
  });
});

describe("cleanupDeadSockets", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtach-test-"));
  });

  afterEach(() => {
    killTestDtachProcesses(tmpDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes socket files with no process behind them", () => {
    // Create a stale socket file (no dtach process)
    const staleSock = path.join(tmpDir, "0.sock");
    fs.writeFileSync(staleSock, "");

    // Create a live socket
    const liveSock = path.join(tmpDir, "1.sock");
    spawnDtach(liveSock, tmpDir);

    cleanupDeadSockets(tmpDir);

    expect(fs.existsSync(staleSock)).toBe(false);
    expect(fs.existsSync(liveSock)).toBe(true);
  });

  it("leaves sockets with a live process behind them", () => {
    const sockPath = path.join(tmpDir, "0.sock");
    spawnDtach(sockPath, tmpDir);

    cleanupDeadSockets(tmpDir);

    // Socket and process should both still exist
    expect(fs.existsSync(sockPath)).toBe(true);
    const pids = findPids(`dtach -n ${sockPath}`);
    expect(pids.length).toBe(1);
  });

  it("does nothing for empty directory", () => {
    cleanupDeadSockets(tmpDir);
    // no error
  });

  it("does nothing for non-existent directory", () => {
    cleanupDeadSockets("/nonexistent/path");
    // no error
  });
});

describe("killDtachProcess", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtach-test-"));
  });

  afterEach(() => {
    killTestDtachProcesses(tmpDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("kills dtach server process and its child shell", () => {
    const sockPath = path.join(tmpDir, "0.sock");
    spawnDtach(sockPath, tmpDir);

    const before = findPids(`dtach -n ${sockPath}`);
    expect(before.length).toBeGreaterThan(0);

    killDtachProcess(sockPath);
    execFileSync("sleep", ["0.1"]);

    const after = findPids(`dtach -n ${sockPath}`);
    expect(after.length).toBe(0);
  });

  it("kills multiple zombie processes for the same socket path", () => {
    const sockPath = path.join(tmpDir, "0.sock");

    spawnDtach(sockPath, tmpDir);
    fs.unlinkSync(sockPath);
    spawnDtach(sockPath, tmpDir);

    const before = findPids(`dtach -n ${sockPath}`);
    expect(before.length).toBe(2);

    killDtachProcess(sockPath);
    execFileSync("sleep", ["0.1"]);

    const after = findPids(`dtach -n ${sockPath}`);
    expect(after.length).toBe(0);
  });

  it("does nothing when no matching process exists", () => {
    killDtachProcess(path.join(tmpDir, "nonexistent.sock"));
  });

  it("also kills child processes (zsh shells)", () => {
    const sockPath = path.join(tmpDir, "0.sock");
    spawnDtach(sockPath, tmpDir);

    const dtachPids = findPids(`dtach -n ${sockPath}`);
    expect(dtachPids.length).toBe(1);

    let childPids: number[] = [];
    try {
      childPids = execFileSync("pgrep", ["-P", String(dtachPids[0])], {
        encoding: "utf8",
        timeout: 5000,
      })
        .trim()
        .split("\n")
        .map((s) => parseInt(s, 10))
        .filter((n) => n > 0);
    } catch {}
    expect(childPids.length).toBeGreaterThan(0);

    killDtachProcess(sockPath);
    execFileSync("sleep", ["0.1"]);

    for (const pid of childPids) {
      expect(isProcessAlive(pid)).toBe(false);
    }
  });
});

describe("removeSocket", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtach-test-"));
  });

  afterEach(() => {
    killTestDtachProcesses(tmpDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("kills process and removes socket file", () => {
    const sockPath = path.join(tmpDir, "0.sock");
    spawnDtach(sockPath, tmpDir);

    expect(fs.existsSync(sockPath)).toBe(true);
    const before = findPids(`dtach -n ${sockPath}`);
    expect(before.length).toBe(1);

    removeSocket(sockPath);
    execFileSync("sleep", ["0.1"]);

    expect(fs.existsSync(sockPath)).toBe(false);
    const after = findPids(`dtach -n ${sockPath}`);
    expect(after.length).toBe(0);
  });
});

describe("cleanupIdleWorkspaces", () => {
  let parentDir: string;

  beforeEach(() => {
    parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtach-idle-test-"));
  });

  afterEach(() => {
    // Kill all dtach processes spawned under parentDir
    killTestDtachProcesses(parentDir);
    fs.rmSync(parentDir, { recursive: true, force: true });
  });

  it("kills processes and removes sockets from idle workspaces", () => {
    // Create a stale workspace (workspace.json with old mtime)
    const staleDir = path.join(parentDir, "stale-workspace-abc123");
    fs.mkdirSync(staleDir, { recursive: true });
    const staleSock = path.join(staleDir, "0.sock");
    spawnDtach(staleSock, staleDir);
    fs.writeFileSync(path.join(staleDir, "workspace.json"), '{"path":"/tmp"}');
    // Set mtime to 4 days ago
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(staleDir, "workspace.json"), fourDaysAgo, fourDaysAgo);

    const pidsBefore = findPids(`dtach -n ${staleSock}`);
    expect(pidsBefore.length).toBe(1);

    // Current workspace should not be touched
    const currentDir = path.join(parentDir, "current-workspace-def456");
    fs.mkdirSync(currentDir, { recursive: true });

    cleanupIdleWorkspaces(currentDir, 72 * 60 * 60 * 1000);
    execFileSync("sleep", ["0.1"]);

    // Stale workspace cleaned up
    expect(fs.existsSync(staleSock)).toBe(false);
    const pidsAfter = findPids(`dtach -n ${staleSock}`);
    expect(pidsAfter.length).toBe(0);
  });

  it("leaves fresh workspaces alone", () => {
    // Create a fresh workspace (workspace.json with recent mtime)
    const freshDir = path.join(parentDir, "fresh-workspace-abc123");
    fs.mkdirSync(freshDir, { recursive: true });
    const freshSock = path.join(freshDir, "0.sock");
    spawnDtach(freshSock, freshDir);
    fs.writeFileSync(path.join(freshDir, "workspace.json"), '{"path":"/tmp"}');
    // mtime is now — fresh

    const currentDir = path.join(parentDir, "current-workspace-def456");
    fs.mkdirSync(currentDir, { recursive: true });

    cleanupIdleWorkspaces(currentDir, 72 * 60 * 60 * 1000);

    // Fresh workspace untouched
    expect(fs.existsSync(freshSock)).toBe(true);
    const pids = findPids(`dtach -n ${freshSock}`);
    expect(pids.length).toBe(1);
  });

  it("never touches the current workspace", () => {
    // Current workspace with old mtime — should still be left alone
    const currentDir = path.join(parentDir, "current-workspace-abc123");
    fs.mkdirSync(currentDir, { recursive: true });
    const sock = path.join(currentDir, "0.sock");
    spawnDtach(sock, currentDir);
    fs.writeFileSync(path.join(currentDir, "workspace.json"), '{"path":"/tmp"}');
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(currentDir, "workspace.json"), oldDate, oldDate);

    cleanupIdleWorkspaces(currentDir, 72 * 60 * 60 * 1000);

    expect(fs.existsSync(sock)).toBe(true);
    const pids = findPids(`dtach -n ${sock}`);
    expect(pids.length).toBe(1);
  });

  it("treats workspaces without workspace.json as stale", () => {
    const noMetaDir = path.join(parentDir, "nometa-workspace-abc123");
    fs.mkdirSync(noMetaDir, { recursive: true });
    const sock = path.join(noMetaDir, "0.sock");
    spawnDtach(sock, noMetaDir);

    const currentDir = path.join(parentDir, "current-workspace-def456");
    fs.mkdirSync(currentDir, { recursive: true });

    cleanupIdleWorkspaces(currentDir, 72 * 60 * 60 * 1000);
    execFileSync("sleep", ["0.1"]);

    expect(fs.existsSync(sock)).toBe(false);
    const pids = findPids(`dtach -n ${sock}`);
    expect(pids.length).toBe(0);
  });

  it("does nothing when no sibling workspaces exist", () => {
    const currentDir = path.join(parentDir, "only-workspace");
    fs.mkdirSync(currentDir, { recursive: true });

    cleanupIdleWorkspaces(currentDir, 72 * 60 * 60 * 1000);
    // no error
  });
});
