import * as vscode from "vscode";
import {
  findDtachBinary,
  ensureSocketDir,
  listSockets,
  cleanupDeadSockets,
  findNextIndex,
  createSocket,
} from "./dtach";
import { resolveSocketDir, resolveStartDirectory, socketPath } from "./config";
import { TerminalManager } from "./terminalManager";

let terminalManager: TerminalManager | undefined;
let pendingRestoreSockets: { index: number; socketPath: string }[] = [];

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const log = vscode.window.createOutputChannel("dtach-persist");
  context.subscriptions.push(log);
  log.appendLine("Activating dtach-persist");

  const binary = findDtachBinary();
  if (!binary) {
    vscode.window.showErrorMessage(
      "dtach-persist: dtach is not installed. Install it with `brew install dtach`.",
    );
    return;
  }
  log.appendLine(`dtach binary: ${binary}`);

  const socketDir = resolveSocketDir();
  const startDir = resolveStartDirectory();
  log.appendLine(`Socket dir: ${socketDir}`);
  log.appendLine(`Start dir: ${startDir}`);

  ensureSocketDir(socketDir);
  cleanupDeadSockets(socketDir);

  terminalManager = new TerminalManager(socketDir, startDir, log);

  // Register synchronous providers, commands, and event handlers before any
  // async work so VS Code can resolve the profile immediately on startup
  terminalManager.registerEventHandlers(context);

  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider("dtach-persist.terminal", {
      provideTerminalProfile: () => {
        // If restoring, serve an existing socket instead of creating new
        if (pendingRestoreSockets.length > 0) {
          const info = pendingRestoreSockets.shift()!;
          const savedName = terminalManager?.getSavedName(info.index);
          log.appendLine(`Profile provider: serving existing socket ${info.index}`);
          return new vscode.TerminalProfile({
            name: savedName || `Terminal ${info.index + 1}`,
            shellPath: binary,
            shellArgs: ["-a", info.socketPath, "-E"],
          });
        }
        ensureSocketDir(socketDir);
        const index = findNextIndex(socketDir);
        const sockPath = socketPath(socketDir, index);
        createSocket(binary, sockPath, startDir);
        log.appendLine(`Profile provider: created socket ${index}`);

        return new vscode.TerminalProfile({
          name: `Terminal ${index + 1}`,
          shellPath: binary,
          shellArgs: ["-a", sockPath, "-E"],
        });
      },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dtach-persist.newTerminal", () =>
      terminalManager!.createNewTerminal(),
    ),
  );

  context.subscriptions.push({
    dispose: () => {
      terminalManager?.setDisposing();
    },
  });

  // Auto-restore existing sockets
  const sockets = listSockets(socketDir);
  if (sockets.length > 0) {
    // Queue sockets for the profile provider — VS Code will request one
    // terminal via the provider after activate() returns. The provider serves
    // an existing socket instead of creating new, so no rogue terminal.
    // We restore the remaining sockets ourselves.
    pendingRestoreSockets = [...sockets];
    log.appendLine(`Found ${sockets.length} existing socket(s) — queued for restore`);
    terminalManager.restoreTerminals();

    // Close rogue non-dtach terminals (e.g. plain zsh) that VS Code created
    // before the extension activated
    for (const t of vscode.window.terminals) {
      if (!terminalManager!.isTracked(t)) {
        log.appendLine("Closing pre-existing rogue terminal");
        t.dispose();
      }
    }

    // Also catch any that open after activate returns
    const rogueWatcher = vscode.window.onDidOpenTerminal((t) => {
      if (!terminalManager!.isTracked(t)) {
        log.appendLine("Closing rogue terminal");
        t.dispose();
      }
    });
    setTimeout(() => rogueWatcher.dispose(), 2000);
  }

  log.appendLine("dtach-persist activated");
}

export function deactivate(): void {
  terminalManager?.setDisposing();
}
