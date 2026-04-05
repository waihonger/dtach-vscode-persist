# dtach-persist

**Stop losing your terminals and Claude Code sessions when VS Code crashes or restarts.**

VS Code extension that keeps terminal sessions alive using [dtach](https://github.com/crigler/dtach). Close VS Code, reopen it, and your shells and Claude Code conversations are still running — right where you left off.

## The problem

VS Code crashes. Or you restart it. All your terminal tabs are gone. Your Claude Code sessions are dead. If you were running multiple Claude Code instances on the same project, you now have to resume each one and hunt for the right session. It's painful.

## Why not tmux?

Most people suggest tmux for persistent terminals. We tried it. Here's why we switched to dtach:

- **tmux kills native scrolling** — tmux uses alternate screen mode, which disables VS Code's scrollbar. You're stuck with tmux's copy-mode (clunky line-by-line scrolling instead of smooth native scroll)
- **tmux tends to crash VS Code** — multiple users reported VS Code instability when running tmux inside the integrated terminal
- **tmux needs tons of config** — you have to disable the status bar, disable the prefix key, configure mouse mode, tune keybindings, set up linked sessions for independent tab views... it's a rabbit hole
- **dtach is simpler** — it does one thing (keep a PTY alive) and gets out of the way. No alternate screen, no config, no UI. VS Code stays fully in control

## How it works

```
VS Code Terminal Tab              VS Code Terminal Tab
  xterm.js (native scroll!)        xterm.js (native scroll!)
  shell: dtach -a sock0             shell: dtach -a sock1
        |                                 |
   unix socket                       unix socket
        |                                 |
  persistent PTY -> zsh            persistent PTY -> zsh
```

Each terminal tab is backed by a dtach socket. When VS Code closes, the dtach client disconnects but the PTY and shell keep running. When VS Code reopens, the extension finds existing sockets and reattaches automatically.

## Install

### 1. Install dtach

```bash
brew install dtach        # macOS
sudo apt install dtach    # Ubuntu/Debian
```

### 2. Install the extension

Download the `.vsix` from [Releases](https://github.com/waihonger/dtach-vscode-persist/releases) and install:

```bash
code --install-extension dtach-persist-0.1.0.vsix
```

### 3. Configure VS Code settings

Add to your VS Code `settings.json` (`Cmd+Shift+P` → "Preferences: Open User Settings (JSON)"):

```json
{
  "terminal.integrated.defaultProfile.osx": "dtach terminal",
  "terminal.integrated.enablePersistentSessions": false,
  "terminal.integrated.launchOnStartup": false
}
```

- **`defaultProfile.osx`** — makes every new terminal use dtach automatically
- **`enablePersistentSessions`** — disables VS Code's built-in session restore (dtach handles this)
- **`launchOnStartup`** — prevents VS Code from spawning a rogue terminal on startup

The extension auto-sets the last two on activation, but adding them explicitly ensures correct behavior from the first launch.

## Usage

- **New terminal**: click the "+" dropdown and select "dtach terminal", or Ctrl+` if set as default
- **Close a tab**: the dtach socket is cleaned up and the shell exits
- **Restart VS Code**: all dtach-backed terminals are restored automatically. Claude Code sessions, running servers, everything picks up where it left off
- **Type `exit`**: shell exits, socket is cleaned up, tab closes

## What persists across restarts

- Shell sessions (zsh, bash) with full command history
- Claude Code conversations (Claude Code maintains its own conversation history)
- Long-running processes (servers, builds, watchers)
- Working directory
- Multiple terminal tabs (each gets its own socket)

## Known quirks

- **Claude Code scroll after restart**: after a VS Code restart, you may need to resize the terminal panel slightly or press Enter to re-enable mouse scrolling in Claude Code. This is because the new terminal doesn't inherit the old mouse tracking state
- **Pre-restart scrollback**: VS Code's scroll buffer only contains output received since the reattach. Output from before the restart isn't in the buffer (but Claude Code keeps its own conversation history, and `history` still has your shell commands)

## How it compares

| | dtach-persist | tmux-based solutions |
|---|---|---|
| **Native VS Code scroll** | Yes | No (alternate screen kills it) |
| **Setup** | `brew install dtach` + extension | tmux + config + scripts + another extension |
| **Config needed** | None | Disable status bar, prefix key, mouse settings, linked sessions... |
| **VS Code stability** | No issues | tmux can crash VS Code |
| **Works with** | Any shell, Claude Code, any TUI | Same, but with scroll/mouse issues |
| **Architecture** | One socket per tab | Sessions, windows, panes, linked sessions |
| **Extension size** | ~6KB | ~10KB+ |

## Technical details

- **Auto-disables conflicting settings**: on activation, the extension sets `terminal.integrated.enablePersistentSessions` and `terminal.integrated.launchOnStartup` to `false` to prevent VS Code from creating duplicate or rogue terminals alongside dtach-restored ones
- **Socket dir**: `$TMPDIR/dtach-persist/<workspace-hash>/` with one `.sock` file per terminal tab
- **Workspace isolation**: folder name + 6-char SHA256 hash of full path prevents collisions between same-named folders
- **Shutdown detection**: 300ms debounce distinguishes "user closed a tab" (kill socket) from "VS Code shutting down" (preserve all sockets)
- **Screen redraw**: delayed SIGWINCH (1s after attach) ensures the screen redraws after VS Code's terminal is initialized
- **`isTransient: true`**: prevents VS Code from double-restoring terminals via its own persistence mechanism
- **`-E` flag**: disables dtach's detach character so no keystrokes are intercepted
- **`-z` flag**: socket is automatically cleaned up when the shell process exits

## Requirements

- macOS or Linux
- [dtach](https://github.com/crigler/dtach)
- VS Code 1.85+

## License

MIT
