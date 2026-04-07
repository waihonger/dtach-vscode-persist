import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { TerminalManager } from "./terminalManager";

const DEFAULT_STALE_THRESHOLD_HOURS = 4;
const STALE_THRESHOLD_MS = (Number(process.env.DTACH_SIGNAL_STALE_HOURS) || DEFAULT_STALE_THRESHOLD_HOURS) * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 10 * 1000; // 10 seconds

const SIGNAL_TYPES = [".signal", ".permission", ".error"] as const;
type SignalType = "complete" | "permission" | "error";

function fileExtToType(ext: string): SignalType | null {
  if (ext === ".signal") return "complete";
  if (ext === ".permission") return "permission";
  if (ext === ".error") return "error";
  return null;
}

function typeToExt(type: SignalType): string {
  if (type === "complete") return ".signal";
  if (type === "permission") return ".permission";
  return ".error";
}

interface Signal {
  index: number;
  timestamp: number;
  type: SignalType;
}

export class SignalWatcher {
  private readonly signalDir: string;
  private readonly log: vscode.OutputChannel;
  private readonly terminalManager: TerminalManager;
  private readonly signals = new Map<string, Signal>(); // key: "index:type"
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

  private signalKey(index: number, type: SignalType): string {
    return `${index}:${type}`;
  }

  start(context: vscode.ExtensionContext): void {
    fs.mkdirSync(this.signalDir, { recursive: true });
    this.scanSignals();

    try {
      this.watcher = fs.watch(this.signalDir, (_, filename) => {
        if (filename === "goto") {
          this.onGotoFile();
        } else if (filename) {
          this.onFile(filename);
        }
      });
    } catch {
      this.log.appendLine("Failed to watch signals directory");
    }

    this.pollTimer = setInterval(() => this.scanSignals(), POLL_INTERVAL_MS);

    context.subscriptions.push(
      vscode.commands.registerCommand("dtach-persist.cycleSignal", () => {
        this.cycleToNext();
      }),
    );

    context.subscriptions.push(
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        if (!terminal) return;
        this.clearActiveTerminalSignals(terminal);
      }),
    );

    context.subscriptions.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (!state.focused) return;
        const terminal = vscode.window.activeTerminal;
        if (terminal) this.clearActiveTerminalSignals(terminal);
      }),
    );
  }

  private clearActiveTerminalSignals(terminal: vscode.Terminal): void {
    const index = this.terminalManager.getIndex(terminal);
    if (index === undefined) return;
    let changed = false;
    for (const type of ["complete", "permission", "error"] as SignalType[]) {
      const key = this.signalKey(index, type);
      if (this.signals.has(key)) {
        this.clearSignal(index, type);
        changed = true;
      }
    }
    if (changed) this.updateStatusBar();
  }

  markRestoreComplete(): void {
    this.restoreComplete = true;
    const gotoPath = path.join(this.signalDir, "goto");
    if (fs.existsSync(gotoPath)) {
      this.onGotoFile();
    }
  }

  onTerminalClosed(index: number): void {
    for (const type of ["complete", "permission", "error"] as SignalType[]) {
      this.clearSignal(index, type);
    }
    this.updateStatusBar();
  }

  private onGotoFile(): void {
    if (!this.restoreComplete) return;
    const gotoPath = path.join(this.signalDir, "goto");
    try {
      const content = fs.readFileSync(gotoPath, "utf8").trim();
      const index = parseInt(content, 10);
      if (!isNaN(index)) {
        this.log.appendLine(`Goto request for terminal ${index}`);
        this.terminalManager.showTerminal(index);
        for (const type of ["complete", "permission", "error"] as SignalType[]) {
          this.clearSignal(index, type);
        }
      }
      fs.unlinkSync(gotoPath);
    } catch {
      // file may have been deleted
    }
    this.updateStatusBar();
  }

  private scanSignals(): void {
    try {
      const files = fs.readdirSync(this.signalDir);

      if (this.restoreComplete && files.includes("goto")) {
        this.onGotoFile();
      }

      const keysOnDisk = new Set<string>();

      for (const file of files) {
        for (const ext of SIGNAL_TYPES) {
          if (file.endsWith(ext)) {
            const index = parseInt(path.basename(file, ext), 10);
            const type = fileExtToType(ext);
            if (!isNaN(index) && type) {
              keysOnDisk.add(this.signalKey(index, type));
              this.onFile(file);
            }
            break;
          }
        }
      }

      // Prune phantom entries
      for (const key of this.signals.keys()) {
        if (!keysOnDisk.has(key)) {
          this.signals.delete(key);
          this.log.appendLine(`Pruned phantom signal: ${key}`);
        }
      }

      this.updateStatusBar();
    } catch {
      // dir may not exist yet
    }
  }

  private onFile(filename: string): void {
    let signalType: SignalType | null = null;
    let ext = "";
    for (const e of SIGNAL_TYPES) {
      if (filename.endsWith(e)) {
        signalType = fileExtToType(e);
        ext = e;
        break;
      }
    }
    if (!signalType) return;

    const index = parseInt(path.basename(filename, ext), 10);
    if (isNaN(index)) return;

    const filePath = path.join(this.signalDir, filename);
    let timestamp: number;
    try {
      timestamp = fs.statSync(filePath).mtimeMs;
    } catch {
      return;
    }

    if (Date.now() - timestamp > STALE_THRESHOLD_MS) {
      this.deleteFile(index, signalType);
      return;
    }

    if (vscode.window.state.focused) {
      const activeTerminal = vscode.window.activeTerminal;
      if (activeTerminal) {
        const activeIndex = this.terminalManager.getIndex(activeTerminal);
        if (activeIndex === index) {
          this.deleteFile(index, signalType);
          return;
        }
      }
    }

    const key = this.signalKey(index, signalType);
    this.signals.set(key, { index, timestamp, type: signalType });
    this.log.appendLine(`Signal received: terminal ${index} (${signalType})`);
    this.updateStatusBar();
  }

  private clearSignal(index: number, type: SignalType): void {
    this.signals.delete(this.signalKey(index, type));
    this.deleteFile(index, type);
  }

  deleteSignalFile(index: number): void {
    for (const type of ["complete", "permission", "error"] as SignalType[]) {
      this.deleteFile(index, type);
    }
  }

  private deleteFile(index: number, type: SignalType): void {
    try {
      fs.unlinkSync(path.join(this.signalDir, `${index}${typeToExt(type)}`));
    } catch {
      // already gone
    }
  }

  private updateStatusBar(): void {
    const now = Date.now();
    const stale: string[] = [];
    for (const [key, signal] of this.signals) {
      if (now - signal.timestamp > STALE_THRESHOLD_MS) {
        stale.push(key);
      }
    }
    for (const key of stale) {
      const signal = this.signals.get(key)!;
      this.clearSignal(signal.index, signal.type);
    }

    const count = this.signals.size;
    if (count === 0) {
      this.statusBarItem.hide();
      return;
    }

    // Check for urgent signals (permission/error)
    const hasUrgent = [...this.signals.values()].some(
      (s) => s.type === "permission" || s.type === "error",
    );

    const icon = hasUrgent ? "$(alert)" : "$(bell)";
    this.statusBarItem.text = `${icon} ${count} awaiting`;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor(
      hasUrgent ? "statusBarItem.errorBackground" : "statusBarItem.warningBackground",
    );
    this.statusBarItem.tooltip = this.buildTooltip();
    this.statusBarItem.show();
  }

  private buildTooltip(): string {
    const lines = ["Terminals awaiting attention:"];
    const now = Date.now();
    const sorted = [...this.signals.values()].sort((a, b) => {
      // Urgent first, then by timestamp
      const urgencyA = a.type === "permission" ? 0 : a.type === "error" ? 1 : 2;
      const urgencyB = b.type === "permission" ? 0 : b.type === "error" ? 1 : 2;
      if (urgencyA !== urgencyB) return urgencyA - urgencyB;
      return b.timestamp - a.timestamp;
    });
    for (const signal of sorted) {
      const ago = Math.round((now - signal.timestamp) / 60000);
      const name = this.terminalManager.getSavedName(signal.index) || `Terminal ${signal.index + 1}`;
      const icon = signal.type === "permission" ? "🔴" : signal.type === "error" ? "❌" : "●";
      const label = signal.type === "permission" ? "needs approval" : signal.type === "error" ? "error" : "done";
      lines.push(`  ${icon} ${name} — ${label} (${ago}m ago)`);
    }
    return lines.join("\n");
  }

  private async cycleToNext(): Promise<void> {
    if (this.signals.size === 0) return;

    if (this.signals.size === 1) {
      const signal = [...this.signals.values()][0];
      this.terminalManager.showTerminal(signal.index);
      this.clearSignal(signal.index, signal.type);
      this.updateStatusBar();
      return;
    }

    const now = Date.now();
    const items = [...this.signals.values()]
      .sort((a, b) => {
        const urgencyA = a.type === "permission" ? 0 : a.type === "error" ? 1 : 2;
        const urgencyB = b.type === "permission" ? 0 : b.type === "error" ? 1 : 2;
        if (urgencyA !== urgencyB) return urgencyA - urgencyB;
        return b.timestamp - a.timestamp;
      })
      .map((signal) => {
        const ago = Math.round((now - signal.timestamp) / 60000);
        const name = this.terminalManager.getSavedName(signal.index) || `Terminal ${signal.index + 1}`;
        const icon = signal.type === "permission" ? "$(alert)" : signal.type === "error" ? "$(error)" : "$(bell)";
        const label = signal.type === "permission" ? "needs approval" : signal.type === "error" ? "error" : "done";
        return { label: `${icon} ${name}`, description: `${label} — ${ago}m ago`, signal };
      });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Select terminal to switch to (urgent first)",
    });

    if (picked) {
      this.terminalManager.showTerminal(picked.signal.index);
      this.clearSignal(picked.signal.index, picked.signal.type);
      this.updateStatusBar();
    }
  }

  dispose(): void {
    this.watcher?.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.statusBarItem.dispose();
  }
}
