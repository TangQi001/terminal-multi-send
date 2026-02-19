# TQ Terminal Nexus

[English](README.md) | [简体中文](README.zh-CN.md)

A VS Code extension for multi-terminal broadcasting: type once and send to multiple integrated terminals.

## Features

- Multi-terminal selection and broadcasting:
  - Command mode with multi-select `QuickPick`
  - Auto-pass through when only one terminal is available
- Command input flow:
  - Manual input
  - Command history
  - Preset commands (`quickCommands`)
- Placeholder injection:
  - `{index}`: send sequence index (starts from 1)
  - `{name}`: terminal name
  - `{name:quoted}`: terminal name wrapped with escaped double quotes
- Safety and stability:
  - Sensitive keyword guard (with secondary confirmation)
  - Optional "confirm before send"
  - Wave sending with delay when terminal count exceeds threshold
- Sidebar control panel (Webview):
  - Select terminals, select all, clear, refresh
  - Grouping (by tool type) and sorting (name/PID/selected-first/custom)
  - Drag-and-drop reordering in custom sort mode
  - Auto-send after input (debounced)
  - Update core settings directly in the panel
- Internationalization:
  - English by default
  - `zh-CN` localization

## Install and Run

### 1) Local development

1. Install dependencies: `npm install`
2. Build extension: `npm run compile`
3. Press `F5` in VS Code to launch Extension Development Host

### 2) Install VSIX (optional)

Sample build artifacts already included in this repository:

- `cursor-terminal-nexus-0.0.1.vsix`
- `cursor-terminal-nexus-0.0.2.vsix`

You can install them via "Extensions: Install from VSIX..." in VS Code.

## Usage

### Command mode (recommended for quick send)

1. Run command: `TQ Terminal Nexus: Broadcast Command`
2. Select target terminals (multi-select supported)
3. Choose "Enter New Command / History / Preset"
4. Confirm and send in batch

Default keybinding: `Alt+Shift+B`

### Sidebar panel mode (for continuous operation)

1. Run command: `TQ Terminal Nexus: Open Control Panel`
2. Open `TQ Terminal Nexus` view in Explorer sidebar
3. In the panel:
   - Manage terminal selection
   - Enter text/command (`Ctrl/Cmd + Enter` to send quickly)
   - Configure auto-send, wave parameters, and safety options

## Configuration

Search `cursorTerminalNexus` in VS Code `Settings`:

| Key | Default | Description |
| --- | --- | --- |
| `cursorTerminalNexus.autoSelectRegex` | `""` | Regex for auto-selecting terminals by name |
| `cursorTerminalNexus.requireConfirmBeforeBroadcast` | `false` | Show confirmation dialog before every send |
| `cursorTerminalNexus.enableSensitiveCommandGuard` | `true` | Warn on sensitive command keywords |
| `cursorTerminalNexus.sensitiveKeywords` | `["rm -rf","shutdown","reboot","mkfs","format","del /s","poweroff"]` | Sensitive keyword list (case-insensitive) |
| `cursorTerminalNexus.waveThreshold` | `20` | Enable wave sending when selected terminal count exceeds this value |
| `cursorTerminalNexus.waveDelayMs` | `20` | Delay between sends in wave mode (ms) |
| `cursorTerminalNexus.quickCommands` | `[]` | Preset command list |
| `cursorTerminalNexus.enableHistory` | `true` | Enable command history |
| `cursorTerminalNexus.maxHistory` | `30` | Maximum stored history entries |
| `cursorTerminalNexus.autoSendEnabled` | `false` | Auto-send after input in control panel |
| `cursorTerminalNexus.autoSendDelayMs` | `800` | Debounce delay for auto-send (ms, minimum 200) |

## Placeholder Example

Input:

```bash
echo terminal={name} idx={index} safe={name:quoted}
```

Values are resolved per terminal at send time.

## Project Structure

```text
src/
  extension.ts            # Extension entry and command registration
  terminalManager.ts      # Terminal discovery, PID resolution, QuickPick multi-select
  quickCommands.ts        # History and preset command handling
  broadcaster.ts          # Safety checks, placeholder injection, wave sending
  controlPanelProvider.ts # Sidebar control panel (Webview)
  config.ts               # Configuration read/update helpers
scripts/
  esbuild.js              # Build script
```

## Development Commands

- `npm run check-types`: TypeScript type check
- `npm run compile`: Development build
- `npm run watch`: Watch build
- `npm run package`: Production build (minified)

## License

MIT
