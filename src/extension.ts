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
    log.appendLine(`Found ${sockets.length} existing socket(s) — restoring`);
    terminalManager.restoreTerminals();
  }

  // Disable VS Code's built-in terminal persistence and auto-launch
  // to prevent duplicate/rogue terminals on restart (see GitHub issue #1)
  const terminalConfig = vscode.workspace.getConfiguration("terminal.integrated");
  await terminalConfig.update("enablePersistentSessions", false, vscode.ConfigurationTarget.Global);
  await terminalConfig.update("launchOnStartup", false, vscode.ConfigurationTarget.Global);

  log.appendLine("dtach-persist activated");
}

export function deactivate(): void {
  terminalManager?.setDisposing();
}
