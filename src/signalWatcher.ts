import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { TerminalManager } from "./terminalManager";

const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
const POLL_INTERVAL_MS = 10 * 1000; // 10 seconds

interface Signal {
  index: number;
  timestamp: number;
}

export class SignalWatcher {
  private readonly signalDir: string;
  private readonly log: vscode.OutputChannel;
  private readonly terminalManager: TerminalManager;
  private readonly signals = new Map<number, Signal>();
  private readonly statusBarItem: vscode.StatusBarItem;
  private watcher: fs.FSWatcher | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private restoreComplete = false;

  constructor(
    signalDir: string,
    terminalManager: TerminalManager,
    log: vscode.OutputChannel,
  ) {
    this.signalDir = signalDir;
    this.terminalManager = terminalManager;
    this.log = log;

    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.statusBarItem.command = "dtach-persist.cycleSignal";
    this.updateStatusBar();
  }

  start(context: vscode.ExtensionContext): void {
    // Ensure signals directory exists
    fs.mkdirSync(this.signalDir, { recursive: true });

    // Pick up any existing signals (but defer goto until restore completes)
    this.scanSignals();

    // Watch for new signals and goto requests
    try {
      this.watcher = fs.watch(this.signalDir, (_, filename) => {
        if (filename === "goto") {
          this.onGotoFile();
        } else if (filename && filename.endsWith(".signal")) {
          this.onSignalFile(filename);
        }
      });
    } catch {
      this.log.appendLine("Failed to watch signals directory");
    }

    // Polling fallback — fs.watch on macOS can miss events
    this.pollTimer = setInterval(() => this.scanSignals(), POLL_INTERVAL_MS);

    // Register click command
    context.subscriptions.push(
      vscode.commands.registerCommand("dtach-persist.cycleSignal", () => {
        this.cycleToNext();
      }),
    );

    // Clear signal when user switches to that terminal
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        if (!terminal) return;
        const index = this.terminalManager.getIndex(terminal);
        if (index !== undefined && this.signals.has(index)) {
          this.clearSignal(index);
          this.updateStatusBar(); // Fix #1: was missing
        }
      }),
    );
  }

  /** Called by extension.ts after restoreTerminals completes */
  markRestoreComplete(): void {
    this.restoreComplete = true;
    // Process any goto file that was waiting for restore
    const gotoPath = path.join(this.signalDir, "goto");
    if (fs.existsSync(gotoPath)) {
      this.onGotoFile();
    }
  }

  /** Called by terminalManager when a terminal is closed */
  onTerminalClosed(index: number): void {
    this.clearSignal(index);
    this.updateStatusBar();
  }

  private onGotoFile(): void {
    // Don't process goto until terminals are restored (#4)
    if (!this.restoreComplete) return;

    const gotoPath = path.join(this.signalDir, "goto");
    try {
      const content = fs.readFileSync(gotoPath, "utf8").trim();
      const index = parseInt(content, 10);
      if (!isNaN(index)) {
        this.log.appendLine(`Goto request for terminal ${index}`);
        this.terminalManager.showTerminal(index);
        this.clearSignal(index);
      }
      fs.unlinkSync(gotoPath);
    } catch {
      // file may have been deleted
    }
    this.updateStatusBar(); // Fix #1: was missing
  }

  private scanSignals(): void {
    try {
      const files = fs.readdirSync(this.signalDir);

      // Process goto file if restore is complete
      if (this.restoreComplete && files.includes("goto")) {
        this.onGotoFile();
      }

      // Reconcile Map with disk — prune entries not found on disk (#2)
      const indicesOnDisk = new Set<number>();

      for (const file of files) {
        if (file.endsWith(".signal")) {
          const index = parseInt(path.basename(file, ".signal"), 10);
          if (!isNaN(index)) indicesOnDisk.add(index);
          this.onSignalFile(file);
        }
      }

      // Remove phantom entries whose files no longer exist
      for (const index of this.signals.keys()) {
        if (!indicesOnDisk.has(index)) {
          this.signals.delete(index);
          this.log.appendLine(`Pruned phantom signal for terminal ${index}`);
        }
      }

      this.updateStatusBar();
    } catch {
      // dir may not exist yet
    }
  }

  private onSignalFile(filename: string): void {
    const index = parseInt(path.basename(filename, ".signal"), 10);
    if (isNaN(index)) return;

    const filePath = path.join(this.signalDir, filename);
    let timestamp: number;
    try {
      timestamp = fs.statSync(filePath).mtimeMs;
    } catch {
      return; // file may have been deleted
    }

    // Ignore stale signals
    if (Date.now() - timestamp > STALE_THRESHOLD_MS) {
      this.deleteSignalFile(index);
      return;
    }

    // Ignore if this terminal is currently active
    const activeTerminal = vscode.window.activeTerminal;
    if (activeTerminal) {
      const activeIndex = this.terminalManager.getIndex(activeTerminal);
      if (activeIndex === index) {
        this.deleteSignalFile(index);
        return;
      }
    }

    this.signals.set(index, { index, timestamp });
    this.log.appendLine(`Signal received for terminal ${index}`);
    this.updateStatusBar();
  }

  private clearSignal(index: number): void {
    this.signals.delete(index);
    this.deleteSignalFile(index);
  }

  deleteSignalFile(index: number): void {
    try {
      fs.unlinkSync(path.join(this.signalDir, `${index}.signal`));
    } catch {
      // already gone
    }
  }

  private updateStatusBar(): void {
    // Clean stale signals — batch delete to avoid re-entrancy
    const now = Date.now();
    const stale: number[] = [];
    for (const [index, signal] of this.signals) {
      if (now - signal.timestamp > STALE_THRESHOLD_MS) {
        stale.push(index);
      }
    }
    for (const index of stale) {
      this.clearSignal(index);
    }

    const count = this.signals.size;
    if (count === 0) {
      this.statusBarItem.hide();
      return;
    }

    this.statusBarItem.text = `$(bell) ${count} awaiting`;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
    this.statusBarItem.tooltip = this.buildTooltip();
    this.statusBarItem.show();
  }

  private buildTooltip(): string {
    const lines = ["Terminals awaiting attention:"];
    const now = Date.now();
    for (const [index, signal] of this.signals) {
      const ago = Math.round((now - signal.timestamp) / 60000);
      const name = this.terminalManager.getSavedName(index) || `Terminal ${index + 1}`;
      lines.push(`  ● ${name} (${ago}m ago)`);
    }
    return lines.join("\n");
  }

  private async cycleToNext(): Promise<void> {
    if (this.signals.size === 0) return;

    // Single signal — jump directly
    if (this.signals.size === 1) {
      const index = [...this.signals.keys()][0];
      this.terminalManager.showTerminal(index);
      this.clearSignal(index);
      this.updateStatusBar();
      return;
    }

    // Multiple signals — show quick pick
    const now = Date.now();
    const items = [...this.signals.entries()]
      .sort((a, b) => b[1].timestamp - a[1].timestamp)
      .map(([index, signal]) => {
        const ago = Math.round((now - signal.timestamp) / 60000);
        const name = this.terminalManager.getSavedName(index) || `Terminal ${index + 1}`;
        return { label: `$(bell) ${name}`, description: `${ago}m ago`, index };
      });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Select terminal to switch to",
    });

    if (picked) {
      this.terminalManager.showTerminal(picked.index);
      this.clearSignal(picked.index);
      this.updateStatusBar();
    }
  }

  dispose(): void {
    this.watcher?.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.statusBarItem.dispose();
  }
}
