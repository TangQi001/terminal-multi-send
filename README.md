# TQ Terminal Nexus

一个用于 VS Code 的终端广播插件：多选终端，一次输入，批量发送。

## 当前已实现

- 国际化（i18n）：支持英文默认 + `zh-CN` 本地化
- 终端发现与多选（`QuickPick`，支持自动勾选、全选、清空）
- 单终端自动直通（仅一个终端时跳过选择）
- 命令输入（支持“手动输入 / 历史命令 / 预设命令”）
- 广播发送（`terminal.sendText(command, true)`）
- 敏感指令关键词拦截（二次确认）
- 大规模终端分波发送（可配置延迟）
- `{index}` 变量注入（例如 `echo Agent {index}`）
- 侧边栏控制面板（终端选择、发送内容、常用配置）
- 输入后自动发送（可配置延迟）

## 使用方式

1. 在扩展开发模式启动插件（`F5`）。
2. 命令模式：执行 `TQ Terminal Nexus: Broadcast Command`。
3. 选择目标终端。
4. 输入命令并确认发送。

默认快捷键：`Alt+Shift+B`

## 开发与打包

- 开发构建：`npm run compile`
- 监听构建：`npm run watch`
- 生产打包构建（压缩）：`npm run package`

## 侧边栏面板

1. 执行命令 `TQ Terminal Nexus: Open Control Panel`（会定位到资源管理器侧栏）。
2. 在 `TQ Terminal Nexus` 面板里：
   - 勾选/全选终端
   - 输入要发送的内容
   - 点击发送
   - 按需开启“输入后自动发送”

## 配置项

在 VS Code Settings 搜索 `cursorTerminalNexus`：

- `cursorTerminalNexus.autoSelectRegex`
- `cursorTerminalNexus.requireConfirmBeforeBroadcast`
- `cursorTerminalNexus.enableSensitiveCommandGuard`
- `cursorTerminalNexus.sensitiveKeywords`
- `cursorTerminalNexus.waveThreshold`
- `cursorTerminalNexus.waveDelayMs`
- `cursorTerminalNexus.quickCommands`
- `cursorTerminalNexus.enableHistory`
- `cursorTerminalNexus.maxHistory`
- `cursorTerminalNexus.autoSendEnabled`
- `cursorTerminalNexus.autoSendDelayMs`
