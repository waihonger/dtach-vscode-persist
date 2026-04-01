# dtach-persist

VS Code extension that keeps terminal sessions alive across restarts using [dtach](https://github.com/crigler/dtach). Close VS Code, reopen it, and your shells and Claude Code sessions are still running.

Unlike tmux-based approaches, dtach doesn't use alternate screen mode — so you get **native VS Code scrolling** with the scrollbar, smooth mouse wheel, and full scrollback history.

## How it works

```
VS Code Terminal Tab              VS Code Terminal Tab
  xterm.js (native scroll)         xterm.js (native scroll)
  shell: dtach -a sock0             shell: dtach -a sock1
        |                                 |
   unix socket                       unix socket
        |                                 |
  persistent PTY -> zsh            persistent PTY -> zsh
```

Each terminal tab is backed by a dtach socket. When VS Code closes, the dtach client disconnects but the PTY and shell keep running. When VS Code reopens, the extension discovers existing sockets and reattaches.

## Install

### 1. Install dtach

```bash
brew install dtach
```

### 2. Install the extension

Download the `.vsix` from [Releases](https://github.com/waihonger/dtach-vscode-persist/releases) and install:

```bash
code --install-extension dtach-persist-0.1.0.vsix
```

### 3. Set as default terminal (optional)

Add to your VS Code `settings.json`:

```json
{
  "terminal.integrated.defaultProfile.osx": "dtach terminal"
}
```

## Usage

**New terminal**: Click the "+" dropdown in the terminal panel and select "dtach terminal", or use the command palette: "dtach-persist: New Persistent Terminal".

**Close a tab**: Terminal tab closes and the dtach socket is cleaned up. The shell process exits.

**Restart VS Code**: All dtach-backed terminals are automatically restored. Running processes (Claude Code, servers, etc.) continue where they left off.

**Shell exit**: Type `exit` in a shell — the dtach socket is cleaned up and the VS Code tab closes.

## What persists

- Shell sessions (zsh, bash)
- Claude Code conversations
- Long-running processes (servers, builds, watchers)
- Working directory

## What doesn't persist

- VS Code scrollback from before the restart (new scrollback accumulates after reattach)
- Mouse tracking state in TUI apps — after restart, resize the terminal panel slightly or press Enter to re-enable scrolling in Claude Code

## Comparison with tmux-based approaches

| | dtach-persist | tmux-based |
|---|---|---|
| **Scroll** | Native VS Code scrollbar | tmux copy-mode only (line-by-line) |
| **Setup** | `brew install dtach` + extension | tmux + config + keybinding tweaks |
| **Config** | None | Disable status bar, prefix, mouse settings |
| **Architecture** | One socket per tab | Sessions, windows, linked sessions |
| **Mouse** | Native VS Code | Requires `mouse on` + binding tuning |
| **Code size** | ~6KB bundle | ~10KB+ bundle |

## How it works (details)

- **Socket dir**: `$TMPDIR/dtach-persist/<workspace-hash>/` — one `.sock` file per terminal tab
- **Workspace hash**: Folder name + 6-char SHA256 of full path (avoids collisions between same-named folders)
- **Shutdown detection**: 300ms debounce — closing a tab kills the socket, but closing VS Code preserves all sockets
- **Redraw on reattach**: Delayed SIGWINCH (1 second after attach) ensures the screen redraws after xterm.js is initialized
- **`isTransient: true`**: Prevents VS Code from double-restoring terminals via its own persistence mechanism
- **`-E` flag**: Disables dtach's detach character so no keystrokes are intercepted
- **`-z` flag**: Socket is automatically cleaned up when the shell process exits

## Requirements

- macOS or Linux
- [dtach](https://github.com/crigler/dtach) (`brew install dtach`)
- VS Code 1.85+

## License

MIT
