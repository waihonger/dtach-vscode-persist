import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { KILL_SOCKET_DELAY_MS, socketPath } from "./config";
import {
  findDtachBinary,
  removeSocket,
  listSockets,
  ensureSocketDir,
  findNextIndex,
  createSocket,
} from "./dtach";
import type { SocketInfo } from "./types";

export class TerminalManager {
  private readonly socketDir: string;
  private readonly startDir: string;
  private readonly log: vscode.OutputChannel;
  private readonly terminalToIndex = new Map<vscode.Terminal, number>();
  private readonly indexToTerminal = new Map<number, vscode.Terminal>();
  private readonly pendingKills = new Map<number, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];
  private disposing = false;

  constructor(socketDir: string, startDir: string, log: vscode.OutputChannel) {
    this.socketDir = socketDir;
    this.startDir = startDir;
    this.log = log;
  }

  private get namesPath(): string {
    return path.join(this.socketDir, "names.json");
  }

  private loadNames(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.namesPath, "utf8"));
    } catch {
      return {};
    }
  }

  private saveNames(): void {
    const names: Record<string, string> = {};
    for (const [terminal, index] of this.terminalToIndex) {
      names[index] = terminal.name;
    }
    try {
      fs.writeFileSync(this.namesPath, JSON.stringify(names));
    } catch {
      // socket dir may be gone
    }
  }

  createTerminalForSocket(info: SocketInfo, show = false, name?: string): vscode.Terminal {
    const pendingKill = this.pendingKills.get(info.index);
    if (pendingKill) {
      clearTimeout(pendingKill);
      this.pendingKills.delete(info.index);
    }

    const binary = findDtachBinary()!;
    const terminal = vscode.window.createTerminal({
      name: name || `Terminal ${info.index + 1}`,
      shellPath: binary,
      shellArgs: ["-a", info.socketPath, "-E"],
      isTransient: true,
    });

    this.terminalToIndex.set(terminal, info.index);
    this.indexToTerminal.set(info.index, terminal);
    this.log.appendLine(`Created terminal for socket ${info.index}`);

    // Send SIGWINCH after xterm.js is ready, so dtach re-reads actual
    // dimensions and the child process redraws to the correct screen.
    setTimeout(async () => {
      const pid = await terminal.processId;
      if (pid) {
        try {
          process.kill(pid, "SIGWINCH");
          this.log.appendLine(`Sent SIGWINCH to terminal ${info.index} (pid ${pid})`);
        } catch {
          // process may have exited
        }
      }
    }, 1000);

    if (show) {
      terminal.show();
    }
    return terminal;
  }

  async createNewTerminal(): Promise<vscode.Terminal> {
    ensureSocketDir(this.socketDir);
    const index = findNextIndex(this.socketDir);
    const sockPath = socketPath(this.socketDir, index);
    const binary = findDtachBinary()!;

    createSocket(binary, sockPath, this.startDir);
    this.log.appendLine(`Created socket ${index} at ${sockPath}`);

    return this.createTerminalForSocket({ index, socketPath: sockPath }, true);
  }

  restoreTerminals(): void {
    const sockets = listSockets(this.socketDir);
    const names = this.loadNames();
    this.log.appendLine(`Restoring ${sockets.length} terminal(s)`);

    for (const info of sockets) {
      this.createTerminalForSocket(info, false, names[info.index]);
    }
  }

  private onTerminalClosed(terminal: vscode.Terminal): void {
    const index = this.terminalToIndex.get(terminal);
    if (index === undefined) return;

    this.terminalToIndex.delete(terminal);
    this.indexToTerminal.delete(index);

    if (this.disposing) {
      this.log.appendLine(`VS Code shutting down — preserving socket ${index}`);
      return;
    }

    this.log.appendLine(
      `Terminal closed — scheduling kill for socket ${index}`,
    );
    const timeout = setTimeout(() => {
      this.pendingKills.delete(index);
      const sockPath = socketPath(this.socketDir, index);
      removeSocket(sockPath);
      this.log.appendLine(`Removed socket ${index}`);
    }, KILL_SOCKET_DELAY_MS);
    this.pendingKills.set(index, timeout);
  }

  registerEventHandlers(context: vscode.ExtensionContext): void {
    const closeDisposable = vscode.window.onDidCloseTerminal((terminal) =>
      this.onTerminalClosed(terminal),
    );
    this.disposables.push(closeDisposable);
    context.subscriptions.push(closeDisposable);

    const openDisposable = vscode.window.onDidOpenTerminal((terminal) => {
      if (this.terminalToIndex.has(terminal)) return;
      this.tryAdoptTerminal(terminal);
    });
    this.disposables.push(openDisposable);
    context.subscriptions.push(openDisposable);
  }

  private tryAdoptTerminal(terminal: vscode.Terminal): void {
    const opts = (terminal.creationOptions as vscode.TerminalOptions) || {};
    const args = opts.shellArgs;
    if (!Array.isArray(args)) return;

    const aIdx = args.indexOf("-a");
    if (aIdx === -1 || aIdx + 1 >= args.length) return;

    const sockPath = args[aIdx + 1];
    if (!sockPath.includes(this.socketDir)) return;

    const basename = sockPath.split("/").pop() || "";
    const index = parseInt(basename.replace(".sock", ""), 10);
    if (isNaN(index)) return;

    const pendingKill = this.pendingKills.get(index);
    if (pendingKill) {
      clearTimeout(pendingKill);
      this.pendingKills.delete(index);
    }

    this.terminalToIndex.set(terminal, index);
    this.indexToTerminal.set(index, terminal);
    this.log.appendLine(`Adopted profile-created terminal for socket ${index}`);
  }

  isTracked(terminal: vscode.Terminal): boolean {
    return this.terminalToIndex.has(terminal);
  }

  setDisposing(): void {
    this.disposing = true;
    this.saveNames();
    for (const timeout of this.pendingKills.values()) {
      clearTimeout(timeout);
    }
    this.pendingKills.clear();
    this.log.appendLine("Disposing — names saved, all pending kills cancelled");
  }

  disposeAll(): void {
    this.setDisposing();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.terminalToIndex.clear();
    this.indexToTerminal.clear();
  }
}
