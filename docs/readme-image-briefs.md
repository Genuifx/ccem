# README image briefs

Shot list for the next round of README screenshots. Each brief was checked against the real desktop UI and a recorded `ccem` terminal session (2026-10-25). All nine figures are in `screenshots/` (2026-10-25 round: real dev-instance screenshots with private details blurred; parts that cannot be captured directly, such as the routing popover, bot list, poster and tray, are drawn to match the UI). Retake them from these briefs when the UI changes. Figure 1 is now a promotional banner rather than a UI screenshot: a switchboard illustration (agents → CCEM router → providers, cords colored by Opus/Sonnet/Haiku tier, permission keycaps) rendered from `docs/readme-assets/hero.html` (serve the repo root over HTTP, open it at 2400×1350, screenshot, then `cwebp -q 86`); the UI-based hero brief below is kept for reference.

## English

> **🖼️ IMAGE PLACEHOLDER 1 — Hero shot** (replaces `screenshots/shots.webp`)
>
> **Suggested file:** `screenshots/hero.webp` · 2880×1800 (1440×900 window at 2×) · light theme on a soft macOS wallpaper
>
> **Shows:** CCEM Desktop on the **Workspace** page. The window uses an overlay title bar: there is no separate title row, and the macOS traffic lights sit inside the top-left corner on the same row as the toolbar. **Top bar, left to right:** traffic lights, the navigation-menu and conversation-list buttons, the status capsule ("Idle · 🔥 45"), the environment chip (`KIMI`), the routing chip (**Direct**), then on the right the search field, the **Review** icon and the side-panel toggle. **Left:** the conversation list grouped by project, newest session on top. **Center:** a finished Claude turn: the collapsed tool summary ("Processed · 19s · 5 calls · Bash · Read"), a short structured answer, and the **Suggested next steps** card with two suggestions, each with **New session** / **Do it here**. **Bottom:** the composer with the environment · effort chip (for example `KIMI · Max`) and the permission picker (**Auto**).
>
> **Capture note:** the next-steps card only appears right after a live turn finishes and only on the latest turn, so capture it immediately after running a short read-only prompt in a demo project.
>
> **Caption:** *Pick a model, pick an agent, ship. CCEM Desktop in action.*

> **🖼️ IMAGE PLACEHOLDER 2 — CLI interactive menu** (replaces `screenshots/cli-index.webp`)
>
> **Suggested file:** `screenshots/cli-menu.webp` · terminal at 120×36, dark theme, line height 1.0 so the pixel logo has no gaps
>
> **Shows:** Running `ccem` with no arguments. **Top left:** the colored pixel-art CCEM logo. **To its right:** `CCEM  Claude Code Env Manager`, then `Env: KIMI [自动模式]`, `URL`, `Run: opus  Opus: kimi-k3[1m]`, `Haiku` and a masked `Token: sk••••xxxx`. **Below:** the `Usage:` line (Today / Week / Total with cost) and a divider. **Then** the Inquirer menu `? Select action` with the cursor on **Start Claude Code (自动模式)**, followed by Switch Environment, Permission Mode, View Usage, Set Default Mode and Exit. **Second window, bottom right:** `ccem ls` output, a cli-table3 table (Name / Base URL / Opus) with 5–6 preset environments and the current one marked `*`.
>
> **Capture note:** use a demo config (fake keys, preset environments) so no private endpoints or key suffixes show; a config with some usage history makes the Usage line more convincing than all zeros.
>
> **Caption:** *`npx ccem`: everything one keystroke away.*

> **🖼️ IMAGE PLACEHOLDER 3 — Composer, annotations & browser panel** (replaces `screenshots/sessions.webp`)
>
> **Suggested file:** `screenshots/workspace.webp` · 2880×1800 · dark theme · overlay title bar with inset traffic lights
>
> **Shows:** One Claude session mid-turn. **Center:** a reply with one passage highlighted and the **annotation toolbar** above it (Copy, marker/wave style, five colors), and a hover menu on an earlier turn showing **Fork a session from this turn**. **Bottom:** the composer with a queued message in the dock waiting to steer the running turn, a `$skill` token, an `@src/auth.ts` file chip, a pasted image thumbnail, the environment · effort chip with its menu open (Effort: Low → Max, then the environment list), and the permission picker. **Right:** the side panel (tabs **Browser · Changes · Browse · Agents**) on **Browser**, with a URL bar, back/forward/reload, the amber **Agent controlling** pill and the **Pause Agent control** button.
>
> **Capture note:** the embedded browser is a native view, so a webview screenshot shows it blank; use a macOS window screenshot for this one.
>
> **Caption:** *Steer the agent mid-turn, mark up its answers, and watch it drive the browser.*

> **🖼️ IMAGE PLACEHOLDER 4 — Dynamic routing popover**
>
> **Suggested file:** `screenshots/routing.webp` · 1600×1000 · light theme, cropped to the top bar and transcript
>
> **Shows:** The **Dynamic routing** popover opened from the routing chip in the top bar (the chip reads **Direct** or **Routed**). At the top, the route state and the **Route profile** selector (My defaults · Main env only · Budget chores) with "Budget chores" selected. **Custom bindings** expanded: **Bindings by type** with *Explore → GLM*, *Background tasks → DeepSeek*, *Other agents → Follow default*. Under that, the **Allow agent self re-routing** toggle and an **Agent may reroute to** list with 3 envs checked. Footer buttons: **Apply changes** and **Save as my default**. Optional inset: the session usage panel's **Sub-route usage (Router-observed)** breakdown.
>
> **Caption:** *Keep the main thread on your best model and send busywork to cheaper ones.*

> **🖼️ IMAGE PLACEHOLDER 5 — Session Review & Changes**
>
> **Suggested file:** `screenshots/session-review.webp` · 2880×1800 · dark theme · overlay title bar with inset traffic lights
>
> **Shows:** A finished session with two things open. **Session Review**, a popover anchored under the **Review** icon in the top bar: header "Session Review · <env> · claude", **Task progress**, then **Evidence** rows for **Changed files**, **Artifacts**, **Failed tools** and **Subagents** with counts, and the environment and branch in the footer. **Right:** the side panel on **Changes** with the **All / Session / Git** filter and counts, a filter field, the file list grouped by directory, and the selected file's diff with green/red lines and an **Open** button.
>
> **Caption:** *Know exactly what the agent did before you merge.*

> **🖼️ IMAGE PLACEHOLDER 6 — Remote Control / Hermes bots** (replaces `screenshots/telegram.webp`)
>
> **Suggested file:** `screenshots/chat-bots.webp` · composite: desktop window on the left (60%), phone frame on the right (40%)
>
> **Shows:** *Left:* the **Remote Control** page, section **Bots**, with the **Hermes chat component** card (installed, with its version) and **Your bots**: a **WeCom** bot ("Account paired · Access to 2 workspaces", mode **CCEM sessions only**) and a **Feishu** bot (mode **Full Hermes**). A collapsed **Other connection methods** row sits below. *Right:* a phone showing a Feishu or WeCom chat: the user asks "run the tests in ccem-web and fix failures", the bot replies with a task card showing the session status, then a short summary of the result.
>
> **Capture note:** needs the Hermes chat component installed and at least one paired bot; on a fresh install the page only shows the install card.
>
> **Caption:** *Your agents, reachable from the chat app you already use.*

> **🖼️ IMAGE PLACEHOLDER 7 — Cron Tasks page** (replaces `screenshots/cron.webp`)
>
> **Suggested file:** `screenshots/cron.webp` · 2880×1800 · light theme · overlay title bar with inset traffic lights
>
> **Shows:** The **Cron Tasks** page. **Top right:** **AI Create** and **Add Task**. **Top:** a 24-hour timeline with a dot for each of today's runs and a marker for the current time. **Left:** **Upcoming**: 5 tasks, each with its next run time, name, cron expression (for example `0 9 * * 1-5`) and a status badge (Success / Timed out), then a **Disabled** group. **Right:** **Recent runs** with Today / 7 days / All filters, each row showing status, task name, start time, duration and an **Open session** link.
>
> **Caption:** *Set it once and wake up to finished work.*

> **🖼️ IMAGE PLACEHOLDER 8 — Analytics & share poster** (replaces `screenshots/analytics.webp`)
>
> **Suggested file:** `screenshots/analytics.webp` · 2880×1800 · dark theme · overlay title bar with inset traffic lights
>
> **Shows:** The **Analytics** page. **Top card:** the source switcher (All / Claude / Codex / OpenCode / DSH) with refresh and share buttons, the total token count with a week-over-week change badge, known cost (with an "unpriced tokens" note), this week's tokens and the **Streak** with a flame, and on the right the **Activity Heatmap (Calendar)**. **Below:** the token consumption chart with Hour / Day / Week / Month tabs. Overlaid on the right, the **Share Poster** dialog with a **Terminal**-style preview, a "Gold Coder" rank badge and style tabs Classic / Terminal / Data Ink.
>
> **Caption:** *Every token across every agent in one view, ready to share.*

> **🖼️ IMAGE PLACEHOLDER 9 — Tray Cockpit**
>
> **Suggested file:** `screenshots/tray-cockpit.webp` · 1200×1400 · macOS menu bar on a plain wallpaper, no main window
>
> **Shows:** The menu-bar **Tray Cockpit** dropped down: **Env** and **Perm** chips, **Tokens Today** and **Cost Today** with "this month" underneath, the **Token Trend** chart with **Hour / Day** tabs, the **Model Type Split** bar, **Active Projects** with status dots, **Scheduled Tasks**, the health row (tmux ok · bridge online · cron ok · version) and the **Workspace / Sessions / Diagnostics** buttons.
>
> **Capture note:** the tray is a separate native window; capture it with a macOS screenshot.
>
> **Caption:** *Today's tokens, cost and running work, one click from the menu bar.*

## 中文

> **🖼️ 配图占位 1 — 主视觉**（替换 `screenshots/shots.webp`）
>
> **建议文件：** `screenshots/hero.webp` · 2880×1800（1440×900 窗口，2 倍）· 浅色主题，柔和的 macOS 壁纸
>
> **画面：** CCEM Desktop 停在 **工作间** 页。窗口使用叠加式标题栏：没有单独的标题行，macOS 红绿灯内嵌在左上角，和工具栏在同一行。**顶栏从左到右：** 红绿灯、导航菜单和会话列表按钮、状态胶囊（“空闲 · 🔥 45”）、环境标签（`KIMI`）、路由标签（**直连**），右侧是搜索框、**审查** 图标和侧边面板开关。**左侧：** 会话列表，按项目分组，最新会话在最上。**中间：** 一轮已完成的 Claude 会话：折叠的工具摘要（“已处理 · 19s · 5 个调用 · Bash · Read”）、一段简短的结构化回答，以及 **建议的下一步** 卡片，两条建议各带 **新会话** / **在这里做**。**底部：** 输入框，有环境 · 推理深度标签（例如 `KIMI · 极限`）和权限选择（**Auto**）。
>
> **拍摄说明：** 建议的下一步卡片只在一轮实时会话刚结束时、且只在最新一轮上出现，所以要在演示项目里跑一个简短的只读提问后立刻截图。
>
> **图注：** *选模型，选 agent，开干。CCEM Desktop 实拍。*

> **🖼️ 配图占位 2 — CLI 交互菜单**（替换 `screenshots/cli-index.webp`）
>
> **建议文件：** `screenshots/cli-menu.webp` · 终端 120×36，深色主题，行高 1.0，像素 logo 才不会出现缝隙
>
> **画面：** 不带参数运行 `ccem`。**左上：** 彩色像素风 CCEM logo。**右侧：** `CCEM  Claude Code Env Manager`，下面依次是 `Env: KIMI [自动模式]`、`URL`、`Run: opus  Opus: kimi-k3[1m]`、`Haiku` 和掩码后的 `Token: sk••••xxxx`。**再往下：** `Usage:` 一行（Today / Week / Total 及费用）和一条分隔线。**然后** 是 Inquirer 菜单 `? Select action`，光标停在 **Start Claude Code (自动模式)**，其后是 Switch Environment、Permission Mode、View Usage、Set Default Mode 和 Exit。**右下第二个窗口：** `ccem ls` 的输出，一张 cli-table3 表格（Name / Base URL / Opus），列出 5–6 个预设环境，当前环境带 `*`。
>
> **拍摄说明：** 用演示配置（假 key、预设环境），避免露出私有地址或 key 尾号；有一些用量记录的配置会比 Usage 全为 0 更有说服力。
>
> **图注：** *`npx ccem`：什么都在一个按键之内。*

> **🖼️ 配图占位 3 — 输入框、批注与浏览器面板**（替换 `screenshots/sessions.webp`）
>
> **建议文件：** `screenshots/workspace.webp` · 2880×1800 · 深色主题 · 叠加式标题栏，红绿灯内嵌
>
> **画面：** 一个正在运行的 Claude 会话。**中间：** 一条回复里有一段被高亮，上方是 **批注工具条**（复制、马克笔/波浪线样式、五种颜色）；更早的一轮上悬停出菜单 **从这一轮分叉新会话**。**底部：** 输入框上方的队列里有一条待插入当前一轮的消息，输入框里有 `$skill` 标记、`@src/auth.ts` 文件标签、一张粘贴的图片缩略图、展开菜单的环境 · 推理深度标签（推理深度：低 → 极限，下面是环境列表）和权限选择。**右侧：** 侧边面板（标签依次为 **浏览器 · 改动 · 浏览 · Agent**）停在 **浏览器**，有地址栏、前进/后退/刷新、琥珀色的 **Agent 正在控制** 标记和 **暂停 Agent 控制** 按钮。
>
> **拍摄说明：** 内嵌浏览器是原生视图，webview 截图里是空白，这张要用 macOS 窗口截图。
>
> **图注：** *运行中随时插话，给回答做批注，看 agent 操作浏览器。*

> **🖼️ 配图占位 4 — 动态路由弹窗**
>
> **建议文件：** `screenshots/routing.webp` · 1600×1000 · 浅色主题，裁到顶栏和会话记录区域
>
> **画面：** 从顶栏路由标签（显示 **直连** 或 **已路由**）打开的 **动态路由** 弹窗。顶部是路由状态和 **选择路由方案**（我的默认 · 仅主环境 · 省钱杂活），选中“省钱杂活”。展开的 **自定义绑定**：**按类型绑定** 里有 *Explore → GLM*、*后台任务 → DeepSeek*、*其他 Agent → 跟随默认*。再往下是 **允许 Agent 自主改派** 开关，以及勾选了 3 个环境的 **Agent 可改派到** 列表。底部按钮：**应用更改** 和 **存为我的默认**。可选小图：会话用量面板里的 **子路由用量（Router 观测）** 明细。
>
> **图注：** *主线程留在最好的模型上，杂活交给便宜的。*

> **🖼️ 配图占位 5 — 会话审查与改动**
>
> **建议文件：** `screenshots/session-review.webp` · 2880×1800 · 深色主题 · 叠加式标题栏，红绿灯内嵌
>
> **画面：** 一个已完成的会话，同时打开两样东西。**会话审查**：锚在顶栏 **审查** 图标下的弹层，标题“会话审查 · <环境> · claude”，下面是 **任务进度**，再是 **证据** 里的 **改动文件**、**产物**、**失败工具**、**子 Agent** 及数量，底部是环境和分支。**右侧：** 侧边面板停在 **改动**，有 **全部 / 会话 / Git** 筛选和数量、筛选输入框、按目录分组的文件列表，以及选中文件的 diff（红绿行）和 **打开** 按钮。
>
> **图注：** *合并之前，先弄清 agent 到底做了什么。*

> **🖼️ 配图占位 6 — 远程控制 / Hermes 机器人**（替换 `screenshots/telegram.webp`）
>
> **建议文件：** `screenshots/chat-bots.webp` · 拼图：左侧桌面窗口（60%），右侧手机框（40%）
>
> **画面：** *左：* **远程控制** 页的 **机器人** 部分，上方是 **Hermes 聊天组件** 卡片（已安装，带版本号），下面是 **已添加的机器人**：一个 **企业微信** 机器人（“账号配对完成 · 可访问 2 个工作区”，模式为 **仅 CCEM 会话**）和一个 **飞书** 机器人（模式为 **完整 Hermes**）。下方是折叠的 **其他连接方式**。*右：* 手机上的飞书或企业微信聊天：用户发“run the tests in ccem-web and fix failures”，机器人回一张显示会话状态的任务卡片，随后是简短的结果总结。
>
> **拍摄说明：** 需要已安装 Hermes 聊天组件并至少配对一个机器人；新装状态下这个页面只有安装卡片。
>
> **图注：** *在你本来就在用的聊天软件里找到你的 agent。*

> **🖼️ 配图占位 7 — 定时任务页**（替换 `screenshots/cron.webp`）
>
> **建议文件：** `screenshots/cron.webp` · 2880×1800 · 浅色主题 · 叠加式标题栏，红绿灯内嵌
>
> **画面：** **定时任务** 页。**右上：** **AI 创建** 和 **添加任务**。**顶部：** 24 小时时间轴，今天每次执行一个圆点，并标出当前时间。**左侧：** **即将执行**：5 个任务，每个有下次执行时间、名称、cron 表达式（例如 `0 9 * * 1-5`）和状态标签（成功 / 超时），下面是 **已禁用** 分组。**右侧：** **最近执行**，带 今天 / 近 7 天 / 全部 筛选，每行有状态、任务名、开始时间、耗时和 **打开会话** 链接。
>
> **图注：** *设一次，醒来活就干完了。*

> **🖼️ 配图占位 8 — 数据分析与分享海报**（替换 `screenshots/analytics.webp`）
>
> **建议文件：** `screenshots/analytics.webp` · 2880×1800 · 深色主题 · 叠加式标题栏，红绿灯内嵌
>
> **画面：** **分析** 页。**顶部卡片：** 来源切换（全部 / Claude / Codex / OpenCode / DSH）及刷新、分享按钮，总 tokens 和周环比标签、已知费用（附“未定价 token”说明）、本周 Token、带火焰的 **连续使用**，右侧是 **活跃热力图（按日历）**。**下方：** Token 消耗分布图，带 小时 / 日 / 周 / 月 切换。右侧叠着 **分享海报** 对话框，预览 **Terminal** 风格的海报和“Gold Coder”段位徽章，风格标签有 Classic / Terminal / Data Ink。
>
> **图注：** *所有 agent 的每个 token 一屏看完，随时可以分享。*

> **🖼️ 配图占位 9 — 托盘面板**
>
> **建议文件：** `screenshots/tray-cockpit.webp` · 1200×1400 · macOS 菜单栏，纯色壁纸，不开主窗口
>
> **画面：** 菜单栏下拉出的 **托盘面板**：**环境** 和 **权限** 标签、**今日 Tokens** 和 **今日消费**（下方显示本月费用）、带 **小时 / 日** 切换的 **Token 曲线** 图、**模型类型分布** 条、带状态点的 **活跃项目**、**定时任务**、健康状态一行（tmux ok · bridge online · cron ok · 版本号），以及 **工作区 / 会话 / 诊断** 按钮。
>
> **拍摄说明：** 托盘是独立的原生窗口，要用 macOS 截图。
>
> **图注：** *今天的 token、费用和运行中的任务，菜单栏一点就看到。*
