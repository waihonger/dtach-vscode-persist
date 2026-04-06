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

export function removeSocket(sockPath: string): void {
  try {
    fs.unlinkSync(sockPath);
  } catch {
    // already gone
  }
}

export function cleanupDeadSockets(dir: string): void {
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith(".sock")) continue;
      const fullPath = path.join(dir, f);
      if (!socketFileExists(fullPath)) {
        removeSocket(fullPath);
      }
    }
  } catch {
    // dir may not exist
  }
}
