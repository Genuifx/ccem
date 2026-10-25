<p align="center">
  <img src="./logo.png" alt="CCEM Logo" width="160" />
</p>

<h1 align="center">CCEM</h1>
<p align="center"><strong>一个控制中心，管好 Claude Code、Codex、OpenCode 和它们背后的所有模型。</strong></p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README_zh.md">中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/ccem"><img src="https://img.shields.io/npm/v/ccem.svg" alt="npm version" /></a>
  <a href="https://github.com/Genuifx/ccem/stargazers"><img src="https://img.shields.io/github/stars/Genuifx/ccem" alt="GitHub stars" /></a>
  <a href="https://github.com/Genuifx/ccem/releases"><img src="https://img.shields.io/github/v/release/Genuifx/ccem" alt="GitHub release" /></a>
  <a href="https://github.com/Genuifx/ccem/actions/workflows/release-desktop.yml"><img src="https://github.com/Genuifx/ccem/actions/workflows/release-desktop.yml/badge.svg" alt="Release Desktop" /></a>
  <a href="https://deepwiki.com/Genuifx/ccem"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki" /></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="license: Apache 2.0" /></a>
  <a href="https://github.com/Genuifx/ccem/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" /></a>
</p>

> **🖼️ 配图占位 1 — 主视觉**（替换 `screenshots/shots.webp`）
>
> **建议文件：** `screenshots/hero.webp` · 2400×1500 · 浅色主题，柔和的 macOS 壁纸
>
> **画面：** CCEM Desktop 主窗口居中，停在 **Workspace** 页。顶栏左上角是导航菜单按钮和状态胶囊（运行中会话、定时任务、连续天数），左侧是会话列表。中间是一个正在运行的 Claude 会话，有一段简短的流式记录：一条用户提问、一条带工具调用卡片的回复（例如对 `src/app.ts` 的 `Edit`）、记录末尾的待办卡片，以及下方的 **建议的下一步** 卡片。底部输入框里有 **Claude / Codex / OpenCode** 切换、环境标签（例如 `KIMI`）、权限标签（`auto`）、推理强度选择和 **动态路由** 标签。右侧 **侧边面板** 打开在 **浏览器** 标签，显示一个 localhost 页面。窗口外桌面右下角，**桌面猫咪** 旁边叠着两个小的会话气泡。
>
> **图注：** *选模型，选 agent，开干。CCEM Desktop 实拍。*

---

## 目录

- [为什么做 ccem](#为什么做-ccem)
- [功能一览](#功能一览)
- [快速上手](#快速上手)
- [CLI](#cli)
- [Desktop App](#desktop-app)
- [外部控制 JSON-RPC、Deeplink 与 CLI](#外部控制json-rpcdeeplink-与-cli)
- [和原生 Claude Code 对比](#和原生-claude-code-对比)
- [数据存在哪](#数据存在哪)
- [Agent 数据与登录](#agent-数据与登录)
- [技术栈](#技术栈)
- [参与贡献](#参与贡献)
- [License](#license)

---

## 为什么做 ccem

Claude Code 很好用。可一旦每天认真用，事情就开始乱了。

- **模型太多。** 前端用 KIMI，脚本用 DeepSeek，重构用 GLM，飞机上用本地 Ollama。每切一次都要手动 `export` 环境变量，开到第八个终端标签，谁也记不清哪个标签连的是哪家。
- **审批疲劳。** 一天点 200 次 *允许* 谁都受不了。可 `--dangerously-skip-permissions` 放在 `.env` 旁边，怎么看都不放心。
- **不知道花了多少。** Claude Code、Codex、OpenCode 各记各的日志，没有地方把它们加起来。
- **人不在电脑前。** 你出门买咖啡，测试挂了，电脑在家里。
- **本该自己跑的活。** 每晚跑测试、周一扫一遍 PR、周五出 changelog，跑完把结果发到手机。

**ccem 把这些都包了。** 它是免费开源的 CLI 加原生 Tauri 桌面应用：一个按键切模型，一个词设权限，把 subagent 路由到便宜的模型，统计每一个 token，跑定时任务，还能在 Telegram、微信、企业微信或飞书里接着聊一个会话。

---

## 功能一览

| | CLI | Desktop |
|---|:---:|:---:|
| **11 个服务商预设**（GLM、KIMI、DeepSeek、通义/百炼、MiniMax、MiMo、OpenRouter、Ollama…），自动映射 Opus / Sonnet / Haiku 档位 | ✅ | ✅ |
| **5 种权限模式**：`yolo` · `auto` · `dev` · `readonly` · `safe` | ✅ | ✅ |
| **独立 agent 配置目录**：CCEM 的 Claude Code 数据与官方应用分开；Codex 可选择隔离 | ✅ `ccem auth` | ✅ |
| **用量与费用统计**，带日历热力图 | ✅ | ✅ Claude + Codex + OpenCode |
| **Skill 安装**：20 个精选预设 + 任意 GitHub 地址 | ✅ | ✅ 流式搜索 |
| **加密的团队配置分发**（`ccem load`） | ✅ | ✅ |
| **DeepSeek Harness（`dsh`）**：用 DeepSeek 的 agent 运行时跑 ccem 环境 | ✅ `ccem dsh` | ✅ 历史来源 |
| **基于 tmux 的会话**：在任何终端里列出、接入 | ✅ `ccem sessions` / `attach` | ✅ |
| **定时任务**：创建、列出、删除、立即触发 | ✅ | ✅ 调度器、模板、AI 生成、运行历史 |
| **用脚本驱动 Desktop**：会话、输入、事件、路由 | ✅ `ccem desktop …` | ✅ 20 个方法的 JSON-RPC |
| **一个工作区里三个 agent**：Claude Code、Codex、OpenCode | — | ✅ |
| **按 subagent 路由模型**，经由本地路由代理 | — | ✅ |
| **内置浏览器侧边面板**，agent 可以操作，你随时可以暂停 | — | ✅ |
| **运行中插话**、**从任意一轮分叉**、**回退到文件检查点** | — | ✅ |
| **会话回顾**：diff、待办、产物、subagent 轨迹 | — | ✅ |
| **聊天机器人**：基于 Hermes 的企业微信和飞书机器人，以及 Telegram / 微信 / 企业微信桥接 | — | ✅ |
| **桌面猫咪**：始终置顶的小伙伴，旁边叠着你运行中和已完成的会话 | — | ✅ |
| **托盘面板**、**Proxy Debug**、**分享海报**、**自动更新** | — | ✅ |

CLI 和 Desktop 读写同一个配置文件（`~/.ccem/config.json`），在一边添加的环境，另一边立刻能看到。

---

## 快速上手

### CLI：30 秒，免安装

```bash
npx ccem              # 交互式菜单
```

或者全局安装：

```bash
npm install -g ccem
ccem add kimi         # 起个名字，选 KIMI 预设，粘贴 key
ccem use kimi         # 切过去
ccem dev              # 以 dev 权限模式启动 Claude Code
```

### Desktop

从 [GitHub Releases](https://github.com/Genuifx/ccem/releases) 下载：

- **macOS**：`.dmg`，支持 Apple Silicon（`aarch64`）和 Intel（`x86_64`）
- **Windows**：`.exe` 安装包（x64）

打开后添加一个环境，选 **Claude**、**Codex** 或 **OpenCode**，描述任务，按 <kbd>Cmd</kbd>+<kbd>Enter</kbd>。

---

# CLI

终端里需要的都在这：环境、权限、用量、skill、定时任务、DeepSeek Harness、tmux 会话，以及远程控制正在运行的 Desktop。

## 安装

```bash
npm install -g ccem
# 或：pnpm add -g ccem
# 或直接：npx ccem
```

> **🖼️ 配图占位 2 — CLI 交互菜单**（替换 `screenshots/cli-index.webp`）
>
> **建议文件：** `screenshots/cli-menu.webp` · 终端约 120×36，深色主题，清晰的等宽字体
>
> **画面：** 不带参数运行 `ccem`。顶部是 ASCII/像素风 CCEM logo，下面一行状态：当前环境（例如 `KIMI`）和权限模式（`dev`）。再往下是 Ink 渲染的交互菜单，光标停在 *切换环境* 之类的项上，其他项可见（添加环境、权限模式、用量、skill 等）。可选：第二个窗格或小图展示 `ccem ls` 的输出，一张 cli-table3 表格列出 4–5 个环境的名称、Base URL 和模型，当前环境高亮。
>
> **图注：** *`npx ccem`：什么都在一个按键之内。*

## 环境管理

```bash
ccem              # 交互式菜单
ccem add kimi     # 给环境起名，再选预设或手动填写
ccem use kimi     # 切换环境
ccem ls           # 列出所有环境
ccem current      # 查看当前环境
ccem env          # 输出 export 命令（方便管道使用）
ccem env --json   # 同上，JSON 格式
ccem run <cmd>    # 注入环境变量后运行任意命令
ccem del <name>   # 删除
ccem rename <a> <b>
ccem cp <src> <dst>
```

### 内置预设

每个预设会填好 Base URL，并把 Claude Code 的 **Opus / Sonnet / Haiku** 三个档位映射到该服务商的模型（`ANTHROPIC_DEFAULT_OPUS_MODEL`、`…_SONNET_MODEL`、`…_HAIKU_MODEL`），同时设置 `ANTHROPIC_MODEL=opus`。这样 Claude Code 的 `/model` 选择器和 subagent 都会用上对应档位的模型。

| 预设 | Base URL | Opus 档 | Sonnet 档 | Haiku 档 |
|---|---|---|---|---|
| GLM（智谱） | `https://open.bigmodel.cn/api/anthropic` | glm-5.3[1m] | glm-5.3[1m] | glm-5.3-flash |
| KIMI（月之暗面） | `https://api.moonshot.cn/anthropic` | kimi-k3[1m] | kimi-k3[1m] | kimi-k2.7-code |
| Kimi Code Plan | `https://api.kimi.com/coding/` | k3[1m] | k3[1m] | k3[1m] |
| MiniMax | `https://api.minimax.cn/anthropic` | MiniMax-M3.1-Flash[1m] | MiniMax-M3.1-Flash[1m] | MiniMax-M3.1-Flash[1m] |
| DeepSeek | `https://api.deepseek.com/anthropic` | deepseek-flash[1m] | deepseek-flash[1m] | deepseek-flash |
| 百炼（阿里云） | `https://dashscope.aliyuncs.com/apps/anthropic` | qwen3.7-max | qwen3.7-max | qwen3.6-flash |
| 百炼 Coding Plan | `https://coding.dashscope.aliyuncs.com/apps/anthropic` | qwen3.7-plus | qwen3.7-plus | qwen3.7-plus |
| OpenRouter | `https://openrouter.ai/api` | ~anthropic/claude-opus-latest[1m] | ~anthropic/claude-sonnet-latest[1m] | ~anthropic/claude-haiku-latest |
| Ollama（本地） | `http://localhost:11434` | gemma4:31b | gemma4:26b | gemma4:e4b |
| MiMo（小米） | `https://api.xiaomimimo.com/anthropic` | mimo-v2.6-pro | mimo-v2.6-pro | mimo-v2.6-pro |
| MiMo Token Plan | `https://token-plan-cn.xiaomimimo.com/anthropic` | mimo-v2.6-pro | mimo-v2.6-pro | mimo-v2.6-pro |

其他兼容 Anthropic 协议的接口也能用：自己填 Base URL、key 和模型即可。API key 加密存储。

### Shell 集成

`ccem use` 改不了当前 shell 里的环境变量。要么在命令前加 `ccem run`，要么把下面这段加进 `~/.zshrc`：

```bash
ccem() {
  command ccem "$@"
  local exit_code=$?
  if [[ $exit_code -eq 0 ]]; then
    if [[ "$1" == "use" || -z "$1" ]]; then
      eval "$(command ccem env)"
    fi
  fi
  return $exit_code
}
```

然后 `source ~/.zshrc`。

## 权限模式

五个预设，介于“全部允许”和“什么都不允许”之间。

| 模式 | 允许什么 | 适合场景 |
|---|---|---|
| **yolo** | 全部 | 自己的项目，完全信任 |
| **auto** | 由模型逐次判断操作风险，低风险的自动放行（即 Claude Code 的 Auto 模式） | 长时间运行，不想一直盯着审批 |
| **dev** | 正常开发，屏蔽敏感文件 | 日常工作 |
| **readonly** | 只能读取和搜索 | 代码评审、安全审计、熟悉代码库 |
| **safe** | 限制网络和写入 | 不熟悉或不信任的仓库、自动化任务 |

```bash
ccem yolo | auto | dev | readonly | safe           # 临时生效，Claude Code 退出后还原
ccem setup perms --dev                           # 写入项目的 .claude/settings.json
ccem setup default-mode --dev                    # 设为默认模式
ccem --mode                                      # 查看当前模式
ccem --list-modes                                # 查看所有模式
```

已下线的 `ci` 和 `audit` 仍能识别：用到它们的已保存默认值和 API 调用会分别变成 `safe` 和 `readonly`。

## 用量统计

```bash
ccem usage          # 交互式视图，带日历热力图
ccem usage --json   # 机器可读
```

ccem 解析 CCEM 配置目录（`~/.ccem/agents/claude/projects/`）和官方 `~/.claude/projects/` 下的 Claude Code JSONL 日志，再用缓存的 LiteLLM 模型价格计算 token 和费用。

## Skill 管理

```bash
ccem skill add              # 交互式选择（Tab 切换分组）
ccem skill add <name>       # 安装预设
ccem skill add <github-url> # 从任意 GitHub 仓库或子目录安装
ccem skill ls               # 列出已安装的 skill
ccem skill rm <name>        # 删除
```

**官方预设（16 个）：** frontend-design、skill-creator、web-artifacts-builder、canvas-design、algorithmic-art、theme-factory、mcp-builder、webapp-testing、pdf、docx、pptx、xlsx、brand-guidelines、doc-coauthoring、internal-comms、slack-gif-creator

**精选社区 skill：** superpowers、ui-ux-pro-max、Humanizer-zh、skill-writer

ccem 还自带教 Claude Code 使用 ccem 本身的 skill：

```bash
ccem setup cron       # 安装 ccem-cron skill：让 Claude 帮你安排定时任务
ccem setup bot-bind   # 安装 ccem-bot-bind skill：让 Claude 把会话挂到聊天机器人上
```

## Agent 配置目录与登录

通过 ccem 启动的 Claude Code 使用自己的配置目录，你官方的 Claude Code 设置不会被动到。Codex 默认共用官方配置。详见 [Agent 数据与登录](#agent-数据与登录)。

```bash
ccem auth claude      # 登录 CCEM 的 Claude Code 配置（用于官方订阅）
ccem auth codex       # 登录当前选中的 Codex 配置
```

使用 ccem 环境里的 API key 不需要登录。

## DeepSeek Harness（`dsh`）

用 **DeepSeek Harness**（一个独立的 agent 运行时）来跑 ccem 环境。ccem 会把环境转换成 dsh 的 provider 配置，并映射 Opus/Sonnet/Haiku 档位，同一套 key 两边都能用。

```bash
ccem dsh doctor                       # 离线就绪检查：二进制、版本、配置
ccem dsh inspect --env deepseek       # 预览 dsh provider 配置（隐藏密钥）
ccem dsh run --tier sonnet "fix the flaky test in auth.spec.ts"
```

`run` 支持 `--env`、`--tier opus|sonnet|haiku`、`--model`、`--cwd` 和 `--permission read-only|workspace-write|danger-full-access`。Desktop 正式版内置 dsh，它的会话会出现在历史页的 **DeepSeek** 下。

## tmux 会话

装了 tmux 时，交互式会话跑在 tmux 里，任何终端都能接上：

```bash
ccem sessions         # 列出基于 tmux 的交互式会话
ccem attach [id]      # 在当前终端接入
```

## 团队配置分发

通过加密通道把 API 配置分发给团队：

```bash
ccem load https://your-server.com/api/env --key YOUR_KEY --secret YOUR_SECRET
# 或者不让密钥进 shell 历史：
echo '{"key":"…","secret":"…"}' | ccem load https://your-server.com/api/env --credentials-stdin
```

可直接部署的服务端在 [`server/`](./server)。它使用 AES-256-GCM 认证加密和限流，附带示例配置和 PM2 ecosystem 文件。

## 从 CLI 管理定时任务

```bash
ccem cron create --name weekday-review --schedule '0 9 * * 1-5' \
  --prompt 'Inspect this project and summarize issues that need attention' \
  --execution-profile conservative --disabled --json
ccem cron list --json
ccem cron trigger weekday-review      # 通过正在运行的 Desktop 立即执行
ccem cron delete weekday-review
ccem cron notification-targets        # 查看结果可以发到哪里
```

其他选项：`--working-dir`、`--env-name`、`--max-budget-usd`、`--allowed-tools`、`--disallowed-tools`、`--timeout-secs`、`--template-id`、`--from-json`，以及把结果发到企业微信的 `--wecom-result` / `--wecom-bot-id` / `--wecom-peer-id`。定时执行由 Desktop 的调度器触发。CLI 负责写入任务记录，`trigger` 让正在运行的 Desktop 去执行。

## 从 CLI 驱动 Desktop

Desktop 运行时：

```bash
ccem desktop health --json
ccem desktop create --env kimi --perm dev --json      # 新建工作区会话
ccem desktop sessions --cwd . --status running --json
ccem desktop status <runtimeId> --json
ccem desktop events <runtimeId> --since 0 --limit 50 --json
ccem desktop send <runtimeId> --text "now add tests"   # 发送输入，配合 --message-id 可幂等
ccem desktop routes <runtimeId> --set Explore=glm      # 会话中途重新绑定路由
ccem desktop open 'ccem://workspace/session?…'         # 在 Desktop 中聚焦某个会话
```

## CLI 命令速查

<details>
<summary><b>全部命令</b></summary>

| 命令 | 说明 |
|---|---|
| `ccem` | 交互式菜单 |
| `ccem ls` / `use <name>` / `add <name>` / `del <name>` | 列出、切换、添加、删除环境 |
| `ccem rename <a> <b>` / `cp <src> <dst>` | 重命名 / 复制环境 |
| `ccem current` | 查看当前环境 |
| `ccem env [--json]` | 输出环境变量 |
| `ccem run <cmd>` | 注入环境变量后运行命令 |
| `ccem load <url>` | 加载加密的远程配置 |
| `ccem yolo/auto/dev/readonly/safe` | 以指定权限模式启动 Claude Code |
| `ccem auth claude\|codex` | 登录 CCEM 的 agent 配置 |
| `ccem --mode` / `--list-modes` | 当前模式 / 所有模式 |
| `ccem setup perms --<mode>` / `--reset` | 写入项目权限 |
| `ccem setup default-mode --<mode>` | 设置默认模式 |
| `ccem setup init [--chrome]` | 初始化 Claude Code（跳过引导、关闭遥测；可选添加 chrome-devtools MCP） |
| `ccem setup migrate [--clean] [--force]` | 迁移旧版配置 |
| `ccem setup cron` / `setup bot-bind` | 安装 ccem-cron / ccem-bot-bind skill |
| `ccem usage [--json]` | 用量统计 |
| `ccem skill add/ls/rm` | Skill 管理 |
| `ccem dsh run/inspect/doctor` | DeepSeek Harness 集成 |
| `ccem sessions` / `attach [id]` | 基于 tmux 的交互式会话 |
| `ccem bot-bind` | 把当前会话绑定到聊天机器人 |
| `ccem cron create/list/delete/trigger/notification-targets` | 定时任务 |
| `ccem desktop health/create/sessions/status/events/send/routes/open` | 控制正在运行的 Desktop |

</details>

---

# Desktop App

基于 **Tauri 2** 的原生应用（Rust 后端 + React 前端，不是 Electron 套壳），支持 **macOS** 和 **Windows**。CLI 能做的它都能做，另外还有一个完整的 agent 工作区。

## Workspace：Claude Code、Codex 与 OpenCode 同处一地

> **🖼️ 配图占位 3 — 带输入框和侧边面板的 Workspace**（替换 `screenshots/sessions.webp`）
>
> **建议文件：** `screenshots/workspace.webp` · 2400×1500 · 深色主题
>
> **画面：** Workspace 页，左侧是项目列表，一个项目下分组排着几个会话，状态点分别表示运行中、等待审批、已完成。中间是一个活跃 Claude 会话的记录，某一轮上悬停出菜单 **“从这一轮分叉新会话”**。底部输入框里有一个 `$skill` 标记、一个 `@src/auth.ts` 文件标签、一张粘贴的图片缩略图、**Claude / Codex / OpenCode** 切换、环境标签、权限标签，以及展开的 **推理强度** 下拉（Minimal → Max）。右侧面板打开在 **浏览器** 标签，有地址栏、前进/后退/刷新，一个琥珀色的 **“Agent 控制中”** 标记和 **暂停 Agent 控制** 按钮。
>
> **图注：** *三个 agent，一个输入框，一个 agent 能操作的浏览器。*

Workspace 不只是个启动器。你在这里发起、引导和回顾 agent 的每一次运行。

- **三个 agent**：在同一个输入框里发起 **Claude Code**、**Codex** 或 **OpenCode** 会话。Claude 和 Codex 跑在原生界面里，OpenCode 会话在 OpenCode Web 中打开。
- **功能齐全的输入框**：`$skill` 标记、`/slash` 命令（从已安装的 Claude Code 命令和 `.claude/commands/` 中扫描）、`@file` 引用、拖入图片和文件，以及模型、服务商和推理强度选择。
- **运行中插话**：Claude 干活时发一条消息，它会直接进入正在运行的这一轮，不会打断。**停止** 依然可以取消。
- **待办卡片与下一步建议**：agent 的待办列表固定在记录末尾。一轮结束后，ccem 会给出最多两条后续建议，可以在当前会话执行，也可以开新会话。
- **批注**：用五种颜色高亮回复中的任意内容，并附上备注。
- **从任意一轮分叉**：新开一个 Claude 会话，保留到那一轮为止的完整上下文，原会话不受影响。
- **文件检查点与回退**：从记录里把工作区恢复到任意一个 Claude 文件检查点。
- **内置浏览器侧边面板**：内嵌浏览器，使用**独立的登录配置**，不碰你自己的 Chrome 数据。agent 可以操作它，你可以暂停、接管，并查看它的截图、控制台日志和操作记录。
- **全局搜索（<kbd>Cmd</kbd>+<kbd>K</kbd>）**：搜索所有项目和历史对话。
- **交给机器人**：把正在运行的会话挂到已配对的聊天机器人上。Hermes 决定哪些进展值得推送，你在聊天里的回复会接着这个会话继续。

## 按 Subagent 路由模型

> **🖼️ 配图占位 4 — 模型路由弹窗**
>
> **建议文件：** `screenshots/routing.webp` · 1600×1000 · 浅色主题，裁到输入框区域
>
> **画面：** 输入框上方展开的 **动态路由** 弹窗。顶部是 **路由方案** 选择器，显示“省钱杂活”。下面是 **按类型绑定**：*主线程 → KIMI*、*Explore → GLM*、*后台任务 → DeepSeek*、*其他 agent → 跟随默认*。再往下是 **允许 agent 自行改路由** 开关，以及勾选了 3 个环境的 **agent 可改路由到** 列表。底部按钮：**应用更改** 和 **存为我的默认**。可选：一张会话用量面板的小图，展示 **子路由用量（路由器观测）** 明细。
>
> **图注：** *主线程留在最好的模型上，杂活交给便宜的。*

`grep` 凭什么要付顶级模型的钱？给 Claude 会话打开 **动态路由**，ccem 会让它经过一个本地路由代理（绑定在 `127.0.0.1`），把活分给不同的环境：

- 把 **subagent 类型**（例如 `Explore`）和 **后台任务** 绑定到不同环境。主线程跟随输入框里选的环境。
- 保存可复用的 **路由方案**，或用模板生成：**省钱杂活**（把 Explore 和后台模型交给更便宜的环境）或 **专长分工**（把某种 subagent 绑定到专门的模型）。
- 可选：允许 agent 在白名单环境之间 **自行改路由**。
- 会话中途也能改绑定，从下一次请求开始生效。
- 在会话的 **路由用量** 明细里看每个环境分别处理了什么。

路由按会话单独开启，不用的会话直连。

## 会话与会话回顾

> **🖼️ 配图占位 5 — 会话回顾抽屉**
>
> **建议文件：** `screenshots/session-review.webp` · 2400×1500 · 深色主题
>
> **画面：** 一个已完成会话上打开的 **会话回顾** 抽屉。顶部是 **任务进度 · 5/6** 进度条、环境和 Git 分支。左栏分为 **改动文件**（4 个文件，带增删行数）、**Subagent**（两条）和 **产物**（一份 HTML 报告和一张 PNG）。右侧是选中文件的 diff，红绿行分明，带 **在编辑器中打开** 按钮。一个 **失败的工具** 标签显示 1 次失败。
>
> **图注：** *合并之前，先弄清 agent 到底做了什么。*

- 网格或列表视图展示所有会话，包括项目、环境、权限模式、agent，以及发起来源（Desktop、CLI、聊天机器人或定时任务）。
- **会话回顾**：待办进度快照、来自 Git 和 SDK 的改动文件（按文件分组展示 diff）、生成的产物（HTML、图片、报告）、失败的工具调用，以及每个 subagent 的轨迹。
- tmux 会话的 **交互事件**：结构化的工具提示、计划审阅和终端审批。
- 运行中实时显示 token 计数，结束后显示平均 token 速度。
- 任务完成或失败时，或者有计划、提问、权限请求需要你处理时，弹出桌面通知。

## 远程控制：聊天机器人

> **🖼️ 配图占位 6 — Chat Apps / Hermes 机器人**（替换 `screenshots/telegram.webp`）
>
> **建议文件：** `screenshots/chat-bots.webp` · 拼图：左侧桌面窗口（60%），右侧手机框（40%）
>
> **画面：** *左：* **Chat Apps** 页的 **机器人** 面板，显示 **Hermes 聊天组件** 及其版本，以及 **你的机器人**：一个 **企业微信** 机器人（“账号已配对 · 可访问 2 个工作区”）和一个 **飞书** 机器人。下方可见折叠的 **其他连接方式**。*右：* 手机上的飞书或企业微信聊天，用户发“run the tests in ccem-web and fix failures”，机器人回一张显示会话状态的任务卡片，随后是简短的结果总结。
>
> **图注：** *在你本来就在用的聊天软件里找到你的 agent。*

在手机上继续工作区里的任务，用的是 **你配置的任意 API key**，而不仅限于 Anthropic 订阅。

**Hermes 机器人（企业微信和飞书）。** Desktop 会帮你安装和管理 **Hermes** 聊天组件。扫码创建机器人（或连接已有的），配对你的聊天账号，再选择每个机器人能访问哪些工作区。机器人可以运行在 **仅 CCEM 会话** 模式（只能在授权工作区里使用 ccem 会话工具），或 **完整 Hermes** 模式（可联网，使用 skill、记忆、本地文件和命令）。可以指定 Hermes 对话所用的 API 环境，也可以把定时任务结果发到聊天里。

**其他连接方式。** 原来的桥接方式依然可用：

- **Telegram**：Forum Topics，每个话题绑定一个项目目录、环境和权限模式。一个话题，一个长期会话。
- **微信**：私聊桥接，扫码登录，用户白名单，用 `/approve` / `/deny` 处理权限请求。
- **企业微信**：多机器人桥接，区分管理员和普通用户，支持群聊和 `@` 触发。

装了 tmux 时远程控制效果最好（支持恢复和多终端工作流）。

## 定时任务：自动化执行

> **🖼️ 配图占位 7 — 定时任务页**（替换 `screenshots/cron.webp`）
>
> **建议文件：** `screenshots/cron.webp` · 2400×1500 · 浅色主题
>
> **画面：** **定时任务** 页。左侧是 4 个任务的列表（例如“每晚测试 · `0 2 * * *`”、“工作日 PR 评审 · `0 9 * * 1-5`”），带启用开关和 **下次运行** 时间。右侧是创建/编辑表单：**快速模板** 一行（PR 评审、测试运行、文档生成、安全审计、Changelog）、自然语言 **AI 生成** 输入框、cron 表达式、工作目录、**执行配置** 分段控件（保守 / 标准 / 自主）及其说明，以及 **预算上限** 字段。底部是 **运行历史**，有 ✓/✗ 状态、耗时，失败的那次带 **重试** 按钮。
>
> **图注：** *设一次，醒来活就干完了。*

- 按本地时间解析的 **五段式 cron** 表达式，并预览接下来几次运行时间。
- **快速模板**：PR 评审、测试运行、文档生成、安全审计、Changelog。
- **AI 生成**：用大白话描述任务，拿回 cron 表达式和提示词。
- **执行配置**：
  - **保守**：只能读、搜、编辑和写入，预算更低，没有 shell 和网络。
  - **标准**：增加 Bash 和网络工具。
  - **自主**：预算更高，跳过权限审批，只用于信得过的任务。
- 每个任务单独的 **预算上限**、工具允许/禁止列表和超时时间。
- **运行历史**：状态、耗时和日志，一键重试。
- **结果通知** 发到 Telegram、企业微信或 Hermes 机器人。

定时执行需要 Desktop 保持运行。

## 数据分析：Claude + Codex + OpenCode

> **🖼️ 配图占位 8 — 数据分析与分享海报**（替换 `screenshots/analytics.webp`）
>
> **建议文件：** `screenshots/analytics.webp` · 2400×1500 · 深色主题
>
> **画面：** **数据分析** 页，顶部是来源切换（全部 / Claude / Codex / OpenCode），以及 token、费用、**连续天数** 和周环比箭头的统计卡片。下面是 GitHub 风格的 **活动热力图（日历）**，以及按模型堆叠的 token/费用趋势图。右侧叠着 **分享海报** 对话框，预览 **Terminal** 风格的海报和“Gold Coder”段位徽章，风格标签有 Classic / Terminal / Data Ink。
>
> **图注：** *所有 agent 的每个 token 一屏看完，随时可以分享。*

- 每日活动热力图、按模型的 token 和费用趋势、连续天数和周环比。
- 一键在 **全部、Claude、Codex、OpenCode** 之间切换。
- **分享海报** 有三种风格（Classic、Terminal、Data Ink），段位从 Bronze 到 Legendary Coder。

费用来自 ccem 能读到的用量记录和已知的模型价格。缺价格的部分，ccem 只显示已知费用，并单列未定价的 token 数，不会瞎猜。这些数字是估算，不是服务商账单。

## 桌面猫咪与托盘面板

> **🖼️ 配图占位 9 — 桌面猫咪 + 托盘面板**
>
> **建议文件：** `screenshots/cat-and-tray.webp` · 1800×1100 · macOS 桌面，纯色壁纸，不开主窗口
>
> **画面：** *右上：* 菜单栏下拉出的 **托盘面板**，显示环境和权限标签、**今日 Token** 和 **今日费用**、带小时/天切换的 **Token 趋势** 图、**模型类型占比** 条、带状态点的 **活跃项目**、**定时任务**、一行健康状态（tmux ok · bridge online · cron ok · 版本号）以及启动按钮（Workspace、会话、诊断）。*右下：* 始终置顶的 **桌面猫咪**，旁边叠着三个会话气泡：两个运行中（转圈），一个带未读“已完成”角标。
>
> **图注：** *看一眼菜单栏或那只猫，就知道 agent 们在干嘛。*

- **桌面猫咪**（设置 → 桌面猫咪）：始终置顶的小伙伴，旁边叠着运行中的会话和未读的已完成会话。点一下直接跳过去。
- **托盘面板**：菜单栏里的迷你仪表盘，显示当前环境和权限模式、今日 token 和费用、按小时或按天的趋势、模型类型占比、活跃项目、即将运行的定时任务、健康检查（tmux、bridge、cron、版本）和快捷启动按钮。

## 还有这些

- **对话历史**：在一个地方浏览 Claude、Codex、OpenCode 和 DeepSeek Harness 的对话，按项目分组，正确处理 `/compact` 边界，支持从历史继续。
- **Proxy Debug**：实时请求列表（方法、URL、状态、大小），详情视图能解析 JSON 和 SSE，Claude 和 Codex 的上游地址分开设置。
- **环境与 Skill**：CLI 功能的可视化版本，一键预设、远程配置同步、流式 skill 搜索。
- **自动更新**：在 **stable** 或 **beta** 渠道后台下载，准备好后重启即可。
- **设置**：浅色、深色或跟随系统主题。中文或英文。默认权限模式和工作目录。终端可选 Terminal.app、iTerm2 或 Ghostty。开机启动。通知。AI 增强所用的环境。Agent 数据与登录。检查 ccem CLI、`claude`、`codex`、OpenCode 和 tmux 等依赖。

### 快捷键

| 快捷键 | 作用 |
|---|---|
| <kbd>Cmd</kbd>+<kbd>1</kbd>…<kbd>9</kbd> | Workspace、会话、环境、Skill、历史、定时任务、Chat Apps、数据分析、Proxy Debug |
| <kbd>Cmd</kbd>+<kbd>Enter</kbd> / <kbd>Cmd</kbd>+<kbd>N</kbd> | 启动会话 |
| <kbd>Cmd</kbd>+<kbd>K</kbd> | 全局搜索 |
| <kbd>Cmd</kbd>+<kbd>B</kbd> | 打开导航 / 切换会话列表 |
| <kbd>Cmd</kbd>+<kbd>,</kbd> | 设置 |
| <kbd>Cmd</kbd>+<kbd>Q</kbd> | 退出 |

---

## 外部控制：JSON-RPC、Deeplink 与 CLI

Desktop 运行时，会在 **`127.0.0.1` 上提供一个需要 token 认证的 JSON-RPC 接口**。地址和 token 写在本地控制描述文件里（`~/.ccem/control.json`，可用 `CCEM_CONTROL_FILE` 覆盖）。脚本、机器人和其他工具可以通过它发起和引导会话。`ccem desktop …` 和 `ccem cron trigger` 用的就是这个接口。

<details>
<summary><b>全部 20 个方法</b></summary>

| 类别 | 方法 |
|---|---|
| 健康检查 | `ccem.health` |
| 工作区会话 | `ccem.workspace.createSession`、`listSessions`、`getSession`、`getEvents`、`sendInput`、`openSession`、`restartDirect` |
| 会话路由 | `ccem.workspace.getRouter`、`ccem.workspace.updateRouter` |
| 路由器 | `ccem.router.status`、`ccem.router.getSettings`、`ccem.router.updateSettings` |
| 远程 | `ccem.remote.getEvents` |
| 定时任务 | `ccem.cron.list`、`ccem.cron.trigger`、`ccem.cron.notificationTargets` |
| 环境 | `ccem.environment.references`、`ccem.environment.rename`、`ccem.environment.delete` |

</details>

**Deeplink。** `ccem://workspace/session?…` 链接会在 Desktop 中打开并聚焦某个会话，可以来自聊天消息、通知或 `ccem desktop open`。

---

## 和原生 Claude Code 对比

| | ccem | 原生 Claude Code |
|---|---|---|
| 多服务商切换 | 11 个预设，自动映射档位，CLI + 图形界面 | 手动 `export` |
| 权限预设 | 5 个一词切换的模式，含 Auto | 内置模式，需手动配置 |
| Agent | Claude Code、Codex、OpenCode（CLI 另有 DeepSeek Harness） | Claude Code |
| 按 subagent 路由模型 | 本地路由代理、路由方案、模板 | — |
| 远程控制 | Hermes 企业微信/飞书、Telegram、微信、企业微信 | — |
| 定时自动化 | 带模板、执行配置和预算的定时任务 | — |
| 统一用量统计 | Claude + Codex + OpenCode | — |
| 会话回顾、分叉与回退 | diff、待办、产物、subagent 轨迹 | 部分支持（CLI 回退） |
| 外部 API | 20 个方法的 JSON-RPC + `ccem://` deeplink | — |
| 价格 | 免费开源 | CLI 免费 |

---

## 数据存在哪

| 路径 | 内容 |
|---|---|
| `~/.ccem/config.json` | 环境（API key 加密）和设置，CLI 与 Desktop 共用 |
| `~/.ccem/agents/claude/` | CCEM 的 Claude Code 配置目录：配置、登录、历史、记忆 |
| `~/.codex/`（或 `CODEX_HOME`） | Codex 配置目录，默认与官方应用共用 |
| `~/.ccem/agents/codex/` | 可选的隔离 Codex 配置目录 |
| `~/.ccem/agents/profiles.json` | Codex 隔离偏好，CLI 与 Desktop 共用 |
| `~/.ccem/cron-tasks.json` | 定时任务 |
| `~/.ccem/usage-cache.json` | 用量缓存 |
| `~/.ccem/model-prices.json` | 模型价格缓存 |
| `~/.ccem/control.json` | 本地 JSON-RPC 接口描述（Desktop 运行时） |
| `.claude/settings.json` | 项目权限配置 |
| `~/.claude/skills/`、`.claude/skills/` | 已安装的 skill |

### Agent 数据与登录

- **Claude Code** 始终使用 CCEM 自己的配置目录。**Codex** 默认复用官方的配置、登录、历史和记忆，除非你打开 **设置 → Agent 数据与登录 → 隔离 Codex 数据**。这个设置对新会话生效，运行中的会话在重连和转交终端时保持原来的配置目录。
- 第一次使用隔离配置目录时，ccem 会把现有的对话和记忆复制过去，并保留会话 ID。Claude 插件也会一并导入。登录凭据、全局设置和插件注册表不会复制。
- 之后两边各自变化。关闭隔离后，隔离的副本仍留在磁盘上，再次打开时会继续使用。
- ccem 的 API key 在所有配置目录里都能用。官方订阅需要在每个隔离配置目录里各登录一次，入口在设置页或 `ccem auth claude` / `ccem auth codex`。
- 首次迁移前，请先结束旧版 ccem 发起的会话，这样它们的最后几轮也能被复制过去。隔离只针对应用数据，不限制 agent 访问文件系统。要使用别的 agent 数据根目录，把 `CCEM_AGENT_HOME` 设为一个绝对路径。

---

## 技术栈

```
apps/cli/          CLI：Commander + Inquirer + Ink（终端里的 React）
apps/desktop/      Desktop：Tauri 2 + Rust 后端 + React 18 前端
packages/core/     共享的预设、类型、加密、路由（Node + 浏览器两套构建）
server/            远程配置服务端（Express）
```

pnpm workspaces 单仓。**前端**：Vite、Tailwind CSS、Zustand、shadcn/ui、Recharts、GSAP。**后端**：基于 Tauri 2 的 Rust，支持 macOS 窗口毛玻璃效果。**国际化**：中文和英文。

给贡献者的架构说明：[Desktop 后端](docs/architecture/desktop-backend.md) · [Desktop 前端](docs/architecture/desktop-frontend.md) · [设计系统](docs/architecture/design-system.md)

---

## 参与贡献

欢迎提 Issue 和 PR！

```bash
pnpm install
pnpm --filter @ccem/core build   # 先构建 core
pnpm run dev                     # 所有包进入开发模式
pnpm verify                      # 完整的本地 CI 检查
```

Desktop 开发请运行 `cd apps/desktop && pnpm tauri:dev`。开发实例的规则见 [CLAUDE.md](./CLAUDE.md)。

## License

Apache License 2.0。完整条款见 [LICENSE](./LICENSE)。
