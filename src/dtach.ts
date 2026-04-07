import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { socketPath } from "./config";
import type { SocketInfo } from "./types";

let dtachBinaryPath: string | null | undefined;

export function findDtachBinary(): string | null {
  if (dtachBinaryPath !== undefined) {
    return dtachBinaryPath;
  }
  const candidates = [
    "/opt/homebrew/bin/dtach",
    "/usr/local/bin/dtach",
    "/usr/bin/dtach",
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      dtachBinaryPath = candidate;
      return candidate;
    } catch {
      // not found here
    }
  }
  try {
    const result = execFileSync("which", ["dtach"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (result) {
      dtachBinaryPath = result;
      return result;
    }
  } catch {
    // not in PATH
  }
  dtachBinaryPath = null;
  return null;
}

export function ensureSocketDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function listSockets(dir: string): SocketInfo[] {
  try {
    const files = fs.readdirSync(dir);
    return files
      .filter((f) => f.endsWith(".sock"))
      .map((f) => {
        const index = parseInt(path.basename(f, ".sock"), 10);
        if (isNaN(index)) return null;
        return { index, socketPath: path.join(dir, f) };
      })
      .filter((s): s is SocketInfo => s !== null)
      .filter((s) => socketFileExists(s.socketPath))
      .sort((a, b) => a.index - b.index);
  } catch {
    return [];
  }
}

export function socketFileExists(sockPath: string): boolean {
  try {
    fs.statSync(sockPath);
    return true;
  } catch {
    return false;
  }
}

export function findNextIndex(dir: string): number {
  const existing = listSockets(dir);
  const used = new Set(existing.map((s) => s.index));
  let i = 0;
  while (used.has(i)) i++;
  return i;
}

export function createSocket(
  dtachBinary: string,
  sockPath: string,
  startDir: string,
  index: number,
  signalDir: string,
): void {
  const shell = process.env.SHELL || "/bin/zsh";
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "vscode",
    DTACH_SOCKET_INDEX: String(index),
    DTACH_SIGNAL_DIR: signalDir,
  };
  execFileSync(dtachBinary, ["-n", sockPath, "-E", "-z", shell], {
    cwd: startDir,
    timeout: 5000,
    env,
  });
}

export function killDtachProcess(sockPath: string): void {
  let pids: number[];
  try {
    pids = execFileSync("pgrep", ["-f", `dtach -n ${sockPath}`], {
      encoding: "utf8",
      timeout: 5000,
    })
      .trim()
      .split("\n")
      .map((s) => parseInt(s, 10))
      .filter((n) => n > 0);
  } catch {
    return; // no matching processes
  }

  for (const pid of pids) {
    // Kill child processes (the shell) first
    try {
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
        } catch {
          // already exited
        }
      }
    } catch {
      // no children or pgrep error
    }
    // Kill the dtach server process
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already exited
    }
  }
}

export function removeSocket(sockPath: string): void {
  killDtachProcess(sockPath);
  try {
    fs.unlinkSync(sockPath);
  } catch {
    // already gone
  }
}

export function isProcessBehindSocket(sockPath: string): boolean {
  try {
    execFileSync("pgrep", ["-f", `dtach -n ${sockPath}`], {
      encoding: "utf8",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

export function cleanupDeadSockets(dir: string): void {
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith(".sock")) continue;
      const fullPath = path.join(dir, f);
      if (!isProcessBehindSocket(fullPath)) {
        removeSocket(fullPath);
      }
    }
  } catch {
    // dir may not exist
  }
}

export function cleanupIdleWorkspaces(
  currentSocketDir: string,
  maxIdleMs: number,
): void {
  const parentDir = path.dirname(currentSocketDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(parentDir);
  } catch {
    return;
  }

  const now = Date.now();

  for (const entry of entries) {
    const workspaceDir = path.join(parentDir, entry);
    if (workspaceDir === currentSocketDir) continue;

    // Only process directories
    try {
      if (!fs.statSync(workspaceDir).isDirectory()) continue;
    } catch {
      continue;
    }

    // Check if workspace has any sockets worth cleaning
    const sockets = listSockets(workspaceDir);
    if (sockets.length === 0) continue;

    // Check workspace.json mtime — if missing, treat as stale
    const metaPath = path.join(workspaceDir, "workspace.json");
    let isStale = true;
    try {
      const stat = fs.statSync(metaPath);
      isStale = now - stat.mtimeMs > maxIdleMs;
    } catch {
      // No workspace.json — treat as stale
    }

    if (!isStale) continue;

    // Kill all dtach processes and remove sockets for this workspace
    for (const sock of sockets) {
      removeSocket(sock.socketPath);
    }
  }
}
