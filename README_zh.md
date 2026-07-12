<p align="center">
  <img src="./logo.png" alt="CCEM Logo" width="160" />
</p>

<h1 align="center">CCEM</h1>
<p align="center"><strong>AI 编程助手的控制中心</strong></p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README_zh.md">中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/ccem"><img src="https://img.shields.io/npm/v/ccem.svg" alt="npm version" /></a>
  <a href="https://github.com/Genuifx/claude-code-env-manager/stargazers"><img src="https://img.shields.io/github/stars/Genuifx/claude-code-env-manager" alt="GitHub stars" /></a>
  <a href="https://github.com/Genuifx/claude-code-env-manager/releases"><img src="https://img.shields.io/github/v/release/Genuifx/claude-code-env-manager" alt="GitHub release" /></a>
  <a href="https://github.com/Genuifx/claude-code-env-manager/actions/workflows/release-desktop.yml"><img src="https://github.com/Genuifx/claude-code-env-manager/actions/workflows/release-desktop.yml/badge.svg" alt="Release Desktop" /></a>
  <a href="https://deepwiki.com/Genuifx/claude-code-env-manager"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki" /></a>
  <a href="https://github.com/Genuifx/claude-code-env-manager/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/ccem.svg" alt="license" /></a>
  <a href="https://github.com/Genuifx/claude-code-env-manager/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" /></a>
</p>

![Shot](./screenshots/shots.webp)

---

## 目录

- [为什么做这个](#为什么做这个)
- [ccem 能做什么](#ccem-能做什么)
- [同类工具对比](#同类工具对比)
- [快速上手](#快速上手)
- [CLI](#cli)
- [Desktop App](#desktop-app)
- [即将推出](#即将推出)
- [数据存在哪](#数据存在哪)
- [技术栈](#技术栈)
- [参与贡献](#参与贡献)
- [License](#license)

---

## 为什么做这个

说实话，用 Claude Code 用久了，有些事真的挺烦的。

你想用 KIMI 写前端、用 Opus 搞架构、用 DeepSeek 跑脚本。但每次切换模型都得手动 `export` 一堆环境变量，切着切着终端开了七八个，自己都忘了哪个窗口连的哪个模型。

权限也是。每条命令都要点"允许"——烦。`--dangerously-skip-permissions` 又太放飞自我——万一它把 `.env` 删了呢。

然后你想看看这个月到底烧了多少钱。Claude Code 不告诉你，Codex 也不告诉你。两边加起来？没数。

最离谱的是——你出门喝个咖啡，突然想让 Claude 帮你改个东西。电脑在家里跑着，你在外面干瞪眼。

还有，每晚想让 Claude 自动跑一遍测试、Review 一下 PR，跑完把结果发到手机上。这需求不过分吧？但就是没有现成的工具干这事。

**所以我做了 ccem。** 环境切换、权限管理、多模型并行、用量统计、定时任务、手机远程控制——一个工具全搞定。

---

## ccem 能做什么

两种形态，看你喜欢哪种。

| 功能 | CLI | Desktop |
|---|---|---|
| 多模型环境切换 | ✅ | ✅ |
| 权限模式预设（6 种） | ✅ | ✅ |
| 用量统计 & 费用追踪 | ✅ | ✅ |
| Skill 管理（发现 + 安装） | ✅ | ✅ 流式搜索 |
| 团队配置共享（加密远程加载） | ✅ | ✅ |
| Claude Code + Codex 双引擎 | — | ✅ |
| Workspace 工作台 | — | ✅ |
| 多会话并行管理 | — | ✅ |
| Telegram 远程控制 | — | ✅ |
| 微信远程控制 | — | ✅ |
| 企业微信 Bot 桥接 | — | ✅ |
| 定时任务 | — | ✅ |
| 系统托盘迷你面板 | — | ✅ |
| 对话历史浏览器 | — | ✅ |
| API 请求调试 | — | ✅ |
| 会话回顾（Todos、Artifacts、Subagent） | — | ✅ |
| Checkpoint 回退 | — | ✅ |
| 全局搜索（跨历史会话） | — | ✅ |
| ccem:// 深度链接 & JSON-RPC API | — | ✅ |
| 自动更新 | — | ✅ |
| 分享海报（AI 编程周报） | — | ✅ |

两边共享同一份配置（`~/.ccem/config.json`），Desktop 改了环境 CLI 立刻生效，反过来也一样。

---

## 同类工具对比

| | ccem | ccswitch | OpenClaw | 原生 Claude Code |
|---|---|---|---|---|
| **多模型切换** | CLI + GUI | CLI only | — | 手动 export |
| **权限预设** | 6 种模式 | — | — | 3 种内置 |
| **双引擎**（Claude + Codex） | ✅ | — | — | — |
| **桌面应用** | Tauri 原生 | — | — | — |
| **远程控制** | Telegram / 微信 / 企微 | — | 自部署 | — |
| **定时任务** | 模板 + AI 生成 | — | — | — |
| **用量分析** | Claude + Codex 统一 | — | — | — |
| **托盘面板** | ✅ | — | — | — |
| **对话历史** | 统一浏览器 | — | Web UI | — |
| **API 抓包调试** | 内置 | — | — | — |
| **外部 API** | JSON-RPC + deeplinks | — | — | — |
| **会话回顾** | Todos、Artifacts、Subagent | — | — | — |
| **团队配置共享** | 加密远程加载 | — | — | — |
| **价格** | 免费 & 开源 | 免费 & 开源 | 免费 & 开源 | 免费 |

---

## 快速上手

### CLI（终端）

```bash
npx ccem              # 交互菜单 — 无需安装就能用
```

或者装到全局：

```bash
npm install -g ccem
ccem add kimi         # 添加环境（自动填好 URL 和模型）
ccem use kimi         # 切换
ccem dev              # 用 dev 权限模式启动 Claude Code
```

### Desktop

从 [GitHub Releases](https://github.com/Genuifx/claude-code-env-manager/releases) 下载：

- **macOS**：`.dmg`（Apple Silicon / Intel）
- **Windows**：`.exe` 安装包（x64）

启动后用起来 — 添加环境，选 Claude 或 Codex，开跑。

---

# CLI

终端里搞定环境切换、权限管理、用量统计、Skill 安装。

## 安装

```bash
npm install -g ccem
# 或：pnpm add -g ccem
# 或直接跑：npx ccem
```

## 环境管理

```bash
ccem              # 交互菜单
ccem add kimi     # 添加环境，自动填好 URL 和模型
ccem use kimi     # 切换环境
ccem ls           # 列出所有环境
ccem current      # 当前环境
ccem env          # 输出 export 命令，配合 eval 用
ccem env --json   # JSON 格式
ccem run <cmd>    # 带着环境变量跑命令
ccem del <name>   # 删除环境
ccem rename <a> <b>
ccem cp <src> <dst>
```

### 内置预设

| 预设 | Base URL | 主模型 | 快速模型 |
|---|---|---|---|
| GLM（智谱） | `https://open.bigmodel.cn/api/anthropic` | glm-5.2[1m] | glm-4.7 |
| KIMI（月之暗面） | `https://api.moonshot.cn/anthropic` | kimi-k2.7-code | kimi-k2.7-code |
| Kimi Code Plan | `https://api.kimi.com/coding/` | kimi-for-coding | kimi-for-coding |
| MiniMax | `https://api.minimaxi.com/anthropic` | MiniMax-M3[1m] | MiniMax-M3[1m] |
| DeepSeek | `https://api.deepseek.com/anthropic` | deepseek-v4-pro[1m] | deepseek-v4-flash |
| 百炼（阿里云） | `https://dashscope.aliyuncs.com/apps/anthropic` | qwen3.7-max | qwen3.6-flash |
| 百炼 Code Plan | `https://coding.dashscope.aliyuncs.com/apps/anthropic` | qwen3.7-plus | qwen3.7-plus |
| OpenRouter | `https://openrouter.ai/api/v1` | anthropic/claude-opus-4.7 | anthropic/claude-haiku-4.5 |
| Ollama | `http://localhost:11434` | gemma4:31b | gemma4:e4b |
| MiMo（小米） | `https://api.xiaomimimo.com/anthropic` | mimo-v2.5-pro | mimo-v2.5 |
| MiMo Token Plan | `https://token-plan-cn.xiaomimimo.com/anthropic` | mimo-v2.5-pro | mimo-v2.5-pro |

> 官方环境默认 `claude-sonnet-4-5-20250929` + `claude-haiku-4-5-20251001`。

### Shell 集成

`ccem use` 切换后，当前终端的环境变量不会自动更新。加这段到 `~/.zshrc`：

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

加完 `source ~/.zshrc`。

## 权限模式

六种预设，在"什么都要确认"和"什么都不管"之间找个平衡。

| 模式 | 说明 | 适用场景 |
|---|---|---|
| **yolo** | 全部放开 | 自己的项目，完全信任 |
| **dev** | 开发权限，屏蔽敏感文件 | 日常开发 |
| **readonly** | 只读 | 看代码、学习 |
| **safe** | 限制网络和修改 | 不熟的代码库 |
| **ci** | CI/CD 用 | 自动化流程 |
| **audit** | 只读 + 搜索 | 安全审计 |

```bash
ccem yolo / dev / readonly / safe / ci / audit   # 临时模式（退出即还原）
ccem setup perms --dev                            # 永久应用
ccem setup default-mode --dev                     # 设默认
ccem --mode                                       # 查看当前
```

## 用量统计

```bash
ccem usage          # 交互式，带日历热力图
ccem usage --json   # 机器可读格式
```

解析 `~/.claude/projects/` 下的 JSONL 日志，计算 token 用量和费用。价格数据从 LiteLLM 拉取并缓存本地。

## Skill 管理

```bash
ccem skill add              # 交互选择（Tab 切换分组）
ccem skill add <name>       # 安装预设
ccem skill add <github-url> # 从 GitHub 安装
ccem skill ls               # 列出已装
ccem skill rm <name>        # 删除
```

**官方预设：** frontend-design、skill-creator、web-artifacts-builder、canvas-design、algorithmic-art、theme-factory、mcp-builder、webapp-testing、pdf/docx/pptx/xlsx、brand-guidelines、doc-coauthoring

**精选：** superpowers、ui-ux-pro-max、Humanizer-zh

## 远程配置

团队共享 API 配置，加密传输。

```bash
ccem load https://your-server.com/api/env --key YOUR_KEY --secret YOUR_SECRET
```

服务端代码在 `server/`。AES-256-GCM 带认证加密（v2）、Rate Limiting、热加载。

## CLI 命令速查

<details>
<summary><b>展开完整列表</b></summary>

| 命令 | 说明 |
|---|---|
| `ccem` | 交互菜单 |
| `ccem ls` | 列出环境 |
| `ccem use <name>` | 切换 |
| `ccem add <name>` | 添加 |
| `ccem del <name>` | 删除 |
| `ccem rename <a> <b>` | 重命名 |
| `ccem cp <src> <dst>` | 复制 |
| `ccem current` | 当前环境 |
| `ccem env [--json]` | 输出环境变量 |
| `ccem run <cmd>` | 带环境跑命令 |
| `ccem load <url>` | 远程加载 |
| `ccem yolo/dev/readonly/safe/ci/audit` | 临时权限模式 |
| `ccem --mode` | 当前模式 |
| `ccem --list-modes` | 所有模式 |
| `ccem setup perms --<mode>` | 永久权限 |
| `ccem setup default-mode --<mode>` | 默认模式 |
| `ccem setup init` | 初始化（跳过引导 + 关遥测） |
| `ccem usage [--json]` | 用量统计 |
| `ccem skill add/ls/rm` | Skill 管理 |

</details>

---

# Desktop App

基于 **Tauri 2.0** 构建的原生桌面应用——真正的 Rust + React，不是套壳浏览器。支持 macOS 和 Windows。

除了 CLI 的所有功能，Desktop 还有 Workspace 工作台、双引擎、远程控制、定时任务和托盘迷你面板。

## 安装

从 [GitHub Releases](https://github.com/Genuifx/claude-code-env-manager/releases) 下载：

- **Windows x64**：`CCEM Desktop_*_x64-setup.exe`
- **macOS（Apple Silicon / Intel）**：`.dmg` — macOS 10.15+

## Workspace — 你的指挥中心

![Sessions](./screenshots/sessions.webp)

Workspace 是会话的管理中枢——不只是一个启动器，而是一个完整的控制面板。

**Prompt Composer —** 富文本启动器：`$skill` 令牌、`/commands` 命令、`@file` 文件引用、图片附件、模型/提供商/effort 选择器。所有参数一次性配好，开跑。

**Slash Commands —** ccem 自动扫描你安装的 Claude Code 命令文件和 `.claude/commands/` 目录，解析 YAML 头信息。直接在 Composer 里使用。

**全局搜索（Cmd+K） —** 实时搜索所有历史对话和项目。三天前 Claude 说的那句话，一秒找到。

**多会话并行 —** 窗口 A 跑 Claude Code，窗口 B 跑 Codex，窗口 C 跑 DeepSeek——同时进行，各自独立的环境和权限模式。

- 网格 / 列表视图切换
- 每个会话显示：项目目录、环境、权限模式、PID、来源（Desktop / CLI / Telegram / 微信 / 企微 / Cron）
- 单个会话操作：聚焦、最小化、停止、关闭
- 孤儿会话恢复：检测未被管理的 Claude 进程，一键接管

**会话回顾面板 —** 打开任意会话，查看结构化回顾：最终回复、变更文件（git + SDK）、提取的 Todos、工具调用证据、生成的 Artifacts（HTML/图片/报告）、Subagent 追踪。

**Checkpoints & Rewind —** Claude 的文件检查点系统可视化。创建检查点、回退到检查点、追踪回退失败。

**Subagent 追踪 —** ccem 追踪 Subagent 生命周期，使用科学家人名命名（Turing、Curie、Feynman、Hopper 等），每个都有独特的符号和主题色。

## Claude Code + Codex 双引擎

![History](./screenshots/history.webp)

Desktop 同时支持 **Claude Code** 和 **OpenAI Codex CLI** 两个运行时。Dashboard 启动面板有下拉菜单——选 Claude 还是 Codex，点一下就跑。

选 Claude 时，环境切换和权限模式正常工作。选 Codex 时，这些控件自动隐藏——Codex 有自己的配置体系。

两种会话在统一视图中管理，各自带着正确的图标和状态。Proxy Debug 同时抓取两个引擎的 API 流量。

ccem Desktop 不只是 Claude Code 管理器——它是你本地 AI 编程助手的控制台。

## 远程控制 — Telegram、微信 & 企业微信

![Telegram](./screenshots/telegram.webp)

用手机控制你电脑上跑着的 Claude Code 会话。和官方 Claude 移动端不同（需要 Anthropic 订阅），ccem 用的是你自己配的 API Key，什么环境都能用。

### Telegram

基于 Forum Topic 机制——每个 Topic 绑定一个项目目录。一个 Topic，一个项目，一个持久会话。互不干扰。

1. 在 ChatApp 中配置 Bot Token + 授权用户
2. 把每个 Forum Topic 绑定到项目目录、环境和权限模式
3. 在手机上发消息，ccem 在本地启动（或复用）Claude Code 会话
4. 结果实时回传，可选择是否显示 tool calls

### 微信

私聊直连模式——发消息，ccem 启动 headless Claude 会话，跑完结果回传。扫码登录、用户白名单、权限审批（回复 `/approve` / `/deny`）。

### 企业微信

完整的企业微信 Bot 桥接：多 Bot 管理、WebSocket 长连接、管理员/用户权限分离、群聊支持、@提及触发、定时任务结果推送到企微。

> 飞书集成——即将推出。

## 定时任务 — 自动化执行 + 结果推送

![Cron Tasks](./screenshots/cron.webp)

写好 cron 表达式和 prompt，ccem 按计划自动跑 Claude Code 任务，完成后把结果推到 Telegram、微信或企微。

- **模板**：PR Review、测试执行、文档生成、安全审计、Changelog
- **AI 生成**：用自然语言描述需求，自动生成 cron 表达式和 prompt
- **结果自动推送**：跑完（或跑挂）结果自动发到绑定的聊天工具
- **运行历史**：每次执行的状态、耗时、日志
- **下次运行预览**：查看接下来几次的执行时间
- **失败重试**：一键重跑

## 数据分析 — Claude + Codex，一屏全览

![Analytics](./screenshots/analytics.webp)

GitHub 风格的使用统计，Claude Code 和 Codex 数据统一展示。

- 每日活跃热力图 + 按模型的 token/费用趋势
- 一键切换 Claude / Codex / 全部视图
- 连续使用天数 + 趋势箭头（和上周对比涨跌）
- **分享海报**：一键生成你的 AI 编程周报

## Tray Cockpit — 系统托盘迷你面板

常驻系统托盘的迷你控制面板，独立于主窗口：

- 当前环境和权限模式，一目了然
- 今日 token 用量和费用
- 12 小时活跃图，支持交互式光标追踪
- Provider 分布：Claude / Codex / OpenCode
- 活跃会话带状态指示灯
- 定时任务排期预览
- 快速启动入口：Workspace、Sessions、Proxy Debug

## 对话历史

过往所有 Claude Code 和 Codex 对话，统一浏览。按来源筛选（全部 / Claude / Codex），按项目目录分组，支持 `/compact` 分段边界。

## Proxy Debug

内置 API 请求调试：

- 实时流量列表：时间戳、方法、URL、状态码、大小
- 请求/响应详情查看，JSON 格式化 + SSE 流检测
- Claude 和 Codex 各自独立的上游地址配置

## 环境 & Skill 管理

和 CLI 功能相同，可视化操作：

- **环境**：卡片式列表、预设一键填充、远程配置同步
- **Skills**：流式搜索（边打边出结果），一键安装/卸载

## 自动更新

内置 Tauri 更新器——在 App 内检查、下载、安装新版本，带进度追踪和状态指示。

## 外部控制 API

本地 JSON-RPC 服务，支持程序化控制：

- `ccem://` URI 深度链接到会话、事件和历史
- Token 认证的 localhost 端点
- `create_session`、`list_sessions`、`send_input`、`open_session` 等方法
- 支持 Bot 到会话的绑定以及外部工具集成

## 设置

- 主题：亮色 / 暗色 / 跟随系统
- 语言：中文 / English
- 默认权限模式 / 默认工作目录
- 终端偏好（iTerm2 / Terminal.app）
- AI 增强模式：用选定环境驱动 AI 相关功能
- 依赖检测：自动检查 CLI / claude / codex / tmux 是否装好

## 快捷键

| 快捷键 | 功能 |
|---|---|
| Cmd+1~9 | 切换页面 |
| Cmd+Enter / Cmd+N | 启动会话 |
| Cmd+K | 全局搜索 |
| Cmd+, | 设置 |
| Cmd+Q | 退出 |

---

## 即将推出

- **飞书** — Bot 桥接集成
- **Pet/Companion** — 像素风桌面伙伴，伴随你的编程会话实时互动

---

## 数据存在哪

| 路径 | 内容 |
|---|---|
| `~/.ccem/config.json` | 环境配置（API Key 加密存储） |
| `~/.ccem/usage-cache.json` | 用量缓存 |
| `~/.ccem/model-prices.json` | 价格缓存 |
| `.claude/settings.json` | 项目权限配置 |
| `.claude/skills/` | 已安装的 Skills |

---

## 技术栈

```
apps/cli/          CLI — Commander.js + Inquirer.js + Ink（React for CLI）
apps/desktop/      Desktop — Tauri 2.0 + React 18 + Rust
packages/core/     共享逻辑 — presets、types、encryption
server/            远程配置服务器
```

pnpm workspaces monorepo。**前端**：Vite、Tailwind CSS、Zustand、shadcn/ui、Recharts、GSAP。**后端**：Rust + Tauri 2.0、window-vibrancy（macOS 原生毛玻璃）。**i18n**：中英双语。

---

## 参与贡献

欢迎提 Issue 和 PR！

## License

MIT
