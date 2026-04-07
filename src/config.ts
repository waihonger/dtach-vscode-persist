import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export const KILL_SOCKET_DELAY_MS = 300;
export const SOCKET_DIR_PREFIX = "dtach-persist";
export const IDLE_TIMEOUT_MS =
  (parseInt(process.env.DTACH_IDLE_TIMEOUT_HOURS || "", 10) || 72) *
  60 *
  60 *
  1000;

export function sanitizeName(name: string): string {
  let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  sanitized = sanitized.replace(/^-+/, "");
  sanitized = sanitized.slice(0, 32);
  return sanitized || "vscode";
}

export function resolveWorkspaceId(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    const fsPath = folders[0].uri.fsPath;
    const folderName = path.basename(fsPath) || "vscode";
    const hash = crypto
      .createHash("sha256")
      .update(fsPath)
      .digest("hex")
      .slice(0, 6);
    // Truncate name portion only, append hash unconditionally (#3)
    const sanitized = sanitizeName(folderName).slice(0, 25);
    return `${sanitized}-${hash}`;
  }
  return "vscode";
}

export function resolveSocketDir(): string {
  const tmpdir = os.tmpdir();
  const workspaceId = resolveWorkspaceId();
  return path.join(tmpdir, SOCKET_DIR_PREFIX, workspaceId);
}

export function resolveStartDirectory(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return os.homedir();
}

export function socketPath(dir: string, index: number): string {
  return path.join(dir, `${index}.sock`);
}

export function signalDir(socketDir: string): string {
  return path.join(socketDir, "signals");
}
