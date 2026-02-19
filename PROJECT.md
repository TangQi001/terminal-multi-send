---

### 1. 项目基本信息 (Project Metadata)

* **项目名称**: `cursor-terminal-nexus` (暂定名，意为终端连接中枢)
* **核心功能**: 识别当前上下文中的所有集成终端，提供筛选/分组功能，并将用户输入的指令同步广播到选中的终端中。
* **技术栈**:
  * **Runtime**: Node.js (VS Code 扩展宿主环境)
  * **Language**: TypeScript (类型安全，适合逻辑严谨的控制逻辑)
  * **Framework**: VS Code Extension API
* **开发工具**: Cursor (直接自举开发)

---

### 2. 系统架构设计 (System Architecture)

我们将项目解耦为三个核心模块，实现你想要的“插拔式”和“自定义”特性。

**Code snippet**

```
graph TD
    User((用户输入)) --> UI[交互层 (UI Layer)]
  
    subgraph Core_Logic [核心逻辑层]
        TM[终端管理器 (Terminal Manager)]
        Filter[筛选过滤器 (Filter Engine)]
        CmdStore[指令仓库 (Command Store)]
    end
  
    subgraph Execution [执行层]
        B[广播器 (Broadcaster)]
    end
  
    subgraph Targets [目标终端池]
        T1[Terminal: Agent 1]
        T2[Terminal: Agent 2]
        Tn[Terminal: Agent N]
    end

    UI --> CmdStore
    UI --> Filter
    TM -- 提供终端列表 --> Filter
    Filter -- 输出目标终端 --> B
    CmdStore -- 输出指令文本 --> B
    B -- sendText() --> T1
    B -- sendText() --> T2
    B -- sendText() --> Tn
```

#### 模块详述：

1. **交互层 (UI Layer)**:
   * 利用 VS Code 原生 `QuickPick` 实现终端的多选。
   * 利用 `InputBox` 获取即时指令。
   * **设计亮点**：无侵入式 UI，只有调用时才出现，符合“插拔式”理念。
2. **核心逻辑层 (Core Logic)**:
   * **终端管理器**: 实时监听 `vscode.window.terminals`，维护终端 ID 和 Name 的映射。
   * **筛选过滤器**: 支持正则匹配（例如：自动选中所有名字包含 "Sim-\*" 的终端）。
   * **指令仓库**: (自定义功能) 读取 `settings.json` 或本地历史记录，提供常用指令（如 `python main.py`）的快速选择，避免重复打字。
3. **执行层 (Execution)**:
   * 遍历目标终端对象，调用 `sendText` 方法。
   * **关键点**: 需处理并发发送的微小延迟，防止 UI 卡顿。

---

### 3. 项目目录结构 (Directory Structure)

这是一个标准的 TypeScript 扩展结构，保持轻量化。

**Plaintext**

```
cursor-terminal-nexus/
├── .vscode/                # 调试配置
│   ├── launch.json
│   └── tasks.json
├── src/                    # 源代码
│   ├── extension.ts        # 入口文件 (Main Entry)
│   ├── terminalManager.ts  # 终端发现与筛选逻辑
│   ├── broadcaster.ts      # 指令发送逻辑
│   └── quickCommands.ts    # 预设指令管理 (自定义功能)
├── package.json            # 插件清单 (定义命令、快捷键、配置项)
├── tsconfig.json           # TypeScript 配置
├── .gitignore
└── README.md
```

---

### 4. 详细业务流程 (Workflow)

这个流程模拟了你操作一次广播的完整生命周期：

#### 阶段一：触发与发现 (Trigger & Discovery)

1. **·用户行为**: 按下快捷键 `Alt+Shift+B` (自定义)。
2. **系统行为**: `TerminalManager` 扫描当前所有打开的终端。
   * *判定*: 若无终端打开，弹出 Error 提示并终止。
   * *判定*: 若只有一个终^ ^端，自动选中该终端进入下一步（省去选择步骤）。

#### 阶段二：筛选与配置 (Selection & Config)

1. **系统行为**: 弹出 QuickPick 列表。
   * 列表项展示：`<图标> 终端名称 (PID: 12345)`。
   * **智能特性**: 如果你在配置里设置了 `autoSelectRegex: "Agent.*"`，系统自动勾选匹配项。
2. **用户行为**: 手动微调勾选状态，按回车确认。

#### 阶段三：指令输入 (Command Input)

1. **系统行为**: 弹出 InputBox，同时展示“最近使用的指令”列表（History）。
2. **用户行为**:
   * *路径 A*: 手动输入 `python train.py --epoch=100`。
   * *路径 B*: 从下拉列表中选择预设指令。
3. **变量注入 (高级功能)**:
   * 用户输入 `echo "I am Agent {index}"`。插件会在发送时自动将 `{index}` 替换为 1, 2, 3...

#### 阶段四：执行与反馈 (Execution & Feedback)

1. **系统行为**: 循环调用 `terminal.sendText(cmd, true)`。
2. **系统行为**: 右下角 StatusBar 显示 `⚡ 已广播至 10 个终端`，3秒后消失。

---

### 5. 核心开发注意点 (Critical Checkpoints)

作为控制工程硕士，你需要特别关注系统的**稳定性**和**边界条件**：

#### A. 终端状态的不确定性 (State Uncertainty)

* **问题**: 某个终端可能正运行着一个阻塞程序（比如正在跑 `top` 或 `vim`）。
* **后果**: 你发送的 `python script.py` 会被当成文本输入到 `vim` 里，造成混乱。
* **对策**: 插件**无法**知道终端内部运行什么（这是 VS Code API 限制）。
  * *解决方案*: 发送前弹出一个“确认框”（可选配置），或者你自己确保终端处于 Shell Ready 状态。

#### B. 换行符与 Shell 差异 (Cross-Platform)

* **问题**: 你的开发环境可能是 Windows (PowerShell/WSL)，但连接的远程服务器是 Linux (Bash)。
* **对策**: `sendText` 方法通常会自动处理换行，但如果在指令中包含复杂的转义字符（如 `\n`, `&&`），需注意不同 Shell 的语法差异。建议指令尽量通用。

#### C. 安全性 (Safety Guardrails)

* **问题**: 误操作广播了 `rm -rf *` 或者 `shutdown`。
* **对策**: 在代码中设置**敏感指令拦截**。如果检测到 `rm`, `del`, `shutdown` 等关键词，强制弹出二次确认框红色警告。

#### D. 性能与并发 (Concurrency)

* **问题**: 瞬间向 20 个终端发送指令可能会导致 UI 瞬时冻结。
* **对策**: 虽然 JS 是单线程的，但 API 调用是异步的。对于大规模（>20个）终端，建议使用简单的 `SetTimeout` 引入 10ms-50ms 的间隔，形成“波次发送”。

### 6. 下一步计划

如果你认可这个架构，我们可以进入**实施阶段**。

我建议先实现一个 **MVP (最小可行性产品)**：

1. 不包含“指令仓库”和“变量注入”。
2. 只实现：获取列表 -> 勾选 -> 输入 -> 发送。

**你要我现在为你生成这个 MVP 的完整代码吗？** 你只需要复制粘贴就能跑起来。
