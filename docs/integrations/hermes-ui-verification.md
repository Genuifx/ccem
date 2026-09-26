# Hermes 界面与导航验收

## 2026-09-26：工作区授权改为可选

基于 `e260d1a4`。用户明确提出机器人不应强制绑定 workspace；本节更新下文原先将配对与工作区授权绑定的行为。原生 Hermes 的 [Channels 与 Pairing](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard) 也是分别管理渠道连接与聊天身份，不要求 CCEM 项目。

- 第三步改为“关联账号”。工作区选项默认收起；没有任何项目或不选择工作区，都可确认配对并完成向导。
- 已配对的聊天可在详情中“设置工作区权限”，添加或撤回授权，撤回全部权限仍保留配对身份。已有但不在当前会话目录列表中的授权保留在编辑器中，不会被隐式丢弃。
- 空工作区不会成为全局授权：持久化输入、通知标志均为 false，现有任务范围过滤继续拒绝访问。更新权限须匹配账号、启用状态与 generation；更新后旧 challenge 撤销，新 generation 从当前事件序号开始。旧 pending 通知在预留发送时撤销，已发送中的通知仍沿用 unknown 语义，不能声称撤回。
- 使用既有 Route 数据结构，无 schema 迁移。托管 host 仍为 `integration_only`，普通 Hermes AI 对话未接入。

验证命令为 `node --test --test-reporter=tap apps/desktop/test/hermes-panel-dom.test.mjs`（81/81）、`cargo test --locked hermes_bridge::`（59/59）、桌面目录 `pnpm exec tsc --noEmit` 与 `pnpm exec vite build`、`pnpm check:file-size`、`git diff --check`。独立审查无阻断项，独立重跑相关 DOM 测试 8/8。新增覆盖零授权配对完成、持久化与访问拒绝、后续增加/全部移除、通知与 challenge 失效、跨账号/过期 generation/暂停/撤销拒绝、已有目录保留、保存失败与焦点恢复。

真实开发实例沿用隔离 Hermes 状态，本轮由规范 launcher 启动，manifest `com.ccem.desktop.dev.idedbe6da`、MCP 57700、launcher PID 37510；未操作安装版或其他任务实例。通过实际界面打开原企微测试连接，撤回唯一测试目录并保存，后端 generation 1 → 2、workspace 数量 1 → 0、enabled 保持 true、输入和通知关闭，列表显示“已配对 · 未授权工作区”，保存后焦点回到“设置工作区权限”。截图与证明位于 `.artifacts/hermes-navigation/optional-unbound-details.png` 和 `optional-desktop-proof.json`。

原测试目录已不在当前会话目录列表中，因此使用真实 `updateRoute` IPC 按记录的原值恢复该唯一目录及原输入/通知权限（generation 3），随后通过真实界面验证目录保留、修改草稿后取消、不写入且恢复焦点。最终原企微为 running、无错误，授权范围及权限恢复原值，WebView console 无错误。没有为了测试授权其他项目。

新一轮真实企微私聊配对未完成：定位历史测试机器人时 Computer Use 连续返回 ScreenCaptureKit -3811，未发送配对指令。零工作区的新配对路径由真实 React 行为测试与 Rust 持久化测试覆盖，不记为真实平台收发验收。仅本地开发分支交付，未合入、push 或发布。

---

## 2026-09-26：列表、独立向导与详情侧栏

基于 `7c1d6bf9`，继续隔离分支 `codex/hermes-integration-phase0`。用户批准以下交互，替代本文后半部分 9 月 25 日的行内展开方案。

- 默认主页管理已添加的机器人：名称、平台、状态、工作区和输入权限摘要。待授权只更新入口提示，不自动挤开列表或抢焦点。
- 添加进入独立三步向导：渠道 → 扫码/手动 → 私聊配对与工作区授权。列表、活动、组件和旧渠道面板从向导中移除。支持稍后授权；完成后定位并高亮准确的机器人。
- 返回前等待二维码取消；失败保留页面；扫码已进入连接或已完成时继续授权。返回恢复列表滚动位置和焦点。
- 管理打开 shadcn/Radix 详情侧栏，配置编辑、配对、权限和移除确认在侧栏内处理。关闭或 Escape 返回原入口，移除后返回添加入口。

产品依据：[Home Assistant 添加集成](https://www.home-assistant.io/getting-started/integration/)、[Slack 添加应用](https://slack.com/help/articles/202035138-Add-apps-to-your-Slack-workspace)、[Atlassian Panel 使用边界](https://atlassian.design/components/panel/usage)、[Carbon 创建流程](https://carbondesignsystem.com/community/patterns/create-flows/)。技术采用既有 Radix Dialog 1.1.x 的 Portal、焦点、Escape 和受控生命周期；[官方文档](https://www.radix-ui.com/primitives/docs/components/dialog) 当前显示 1.1.20，本地依赖范围 ^1.1.15，未新增或升级依赖。

### 状态与审查修正

`configureChannel` 动作新增临时 `configuredAccountRef` 回执，直接来自后端保存结果，不入持久化状态；前端不再根据全量列表差集猜账号。单次动作结果与共享轮询快照分开处理，取消以本次 setup 回执决定导航，最终刷新结束后再次检查动作序号，防止旧取消把新二维码切到手动。

真实后台 WebView 暴露了原弹窗遮挡队列仅等待 requestAnimationFrame 的问题，导致详情不出现。增加 100ms post-commit 等待兜底，仍等待所有原生 surface hide ACK，且恢复前检查活动弹层。独立审查确认未绕过遮挡保护。

### 本轮自动验证

```sh
# 仓库根
node --test apps/desktop/test/hermes-panel-dom.test.mjs
node --test apps/desktop/test/workspace-motion-lifecycle-dom.test.mjs apps/desktop/test/locale-provider-dom.test.mjs
node --test apps/desktop/test/native-surface-occlusion.test.mjs apps/desktop/test/delete-env-confirm-dialog-dom.test.mjs
pnpm check:file-size
git diff --check
# apps/desktop
pnpm build
# apps/desktop/src-tauri
cargo test --locked hermes_bridge::
```

Hermes DOM 75、动画与语言 28、原生遮挡与弹窗 18，共 121 项；Rust Hermes bridge 56 项通过。DOM 包含显式授权后完成、账号归属、同时创建、取消与扫码并发、旧取消不得覆盖新二维码、侧栏焦点/Escape、列表滚动和无抢焦点。独立复审通过，最终 DOM 无 act 警告。构建包含既有大 chunk 和 Tailwind 类名警告。最后补充连接名称与状态显示后，重跑 Hermes DOM、`pnpm exec tsc --noEmit` 和 `pnpm exec vite build`。

### 本轮真实开发版证据

证据保存在 `.artifacts/hermes-navigation/`；使用本任务规范 launcher、manifest 精确匹配的 `com.ccem.desktop.dev.idedbe6da` 与 MCP 57700。Hermes 状态复用隔离 `.artifacts/hermes-qr-live/state`，运行包 2026.9.25.1 使用已有本地测试签名信任源；共享后台服务关闭。启动参数修正后，仅停止了本任务创建、通过 PID/cwd 核对的旧开发进程。

- 实际 WebView DOM 点击列表管理，侧栏出现并聚焦标题；关闭返回原入口。后台窗口仍能打开侧栏，没有替换 IPC 或伪造渲染状态。
- 添加切到独立页面，列表行数为 0；回到列表恢复焦点。900 × 430 窗口中实测原滚动量 158 → 向导 0 → 返回 158。
- 飞书通过真实服务生成二维码，状态 `waiting`；返回后后端 `cancelled`、二维码消失，原企微连接保持 `running`、原授权一条。
- 使用明确无效的 Slack 测试凭据在隔离状态中新增临时机器人，真实 Rust 保存回执将向导推进到该账号的第三步。稍后授权返回后，新行高亮并获得焦点；随后通过详情确认移除测试记录。此测试没有证明 Slack 登录或收发。
- 500 × 1000 实际窗口：向导改为单列；侧栏宽 500px，无横向溢出，焦点留在侧栏。Tauri MCP Escape 实测关闭侧栏并返回列表入口。修改配置时保存的密码保持空白，未修改时保存按钮禁用。
- 截图含 `bots-list-light.png`、`bots-list-dark.png`、`add-channels-light.png`、`add-channels-narrow.png`、`details-light.png`、`details-narrow.png` 和 `feishu-qr-light.png`。仅临时切换根主题 class 检查深色，完成有限时长动画后截图，最终恢复浅色和 1120 × 900 窗口。测试二维码已取消，临时 Slack 记录已移除，最终仅原企微 `running`、无错误、原授权一条。

具体 UI 结果见同目录 `desktop-proof.json` 与截图。真实外部平台扫码创建/私聊/收发与 UI 导航验收分开；自动配对授权全链路由行为测试夹具覆盖，不能算新一轮真实平台账号验收。本轮本地提交，未合并、未 push、未正式发行。

---

## 2026-09-25：前一版视觉重设计（历史记录）

2026-09-25，基于 `b7b0242c`，隔离分支 `codex/hermes-integration-phase0`。本轮覆盖 CCEM 内 Hermes 的渠道选择、扫码与手动接入、连接管理、配对授权和运行组件管理；未改变渠道协议或持久化结构。

## 交互与设计

新增渠道在页面上方独立展开，按扫码和凭据分组。飞书、Telegram、企业微信默认扫码；Discord、Slack 进入手动表单，扫码渠道也保留手动入口。扫码页采用说明与二维码两栏，容器变窄时改为单栏。

现有连接以状态、配对数量和主要操作为摘要，管理详情按需展开；错误、待授权请求和移除确认自动显露。工作区保持逐项选择，输入权限默认关闭。正常运行组件收起为一行，异常或安装期间自动展开。通知列表显示名称和时间，编号缩短并保留完整 title。

沿用 shadcn/ui、项目 Hugeicons 适配器、字体和主题变量，无新增依赖。参照 [Linear 集成目录](https://linear.app/docs/integration-directory) 的渠道入口、[Slack 应用指南](https://slack.com/help/articles/360001537467-Guide-to-apps-in-Slack) 的连接与权限分离，以及 [WAI disclosure](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/) 的展开语义。

## 行为合同

- 添加或返回渠道时焦点进入接入标题，成功保存或关闭后回到“添加渠道”。晚返回结果不能关闭新编辑器。
- 切换手动、返回或关闭前取消当前二维码；取消失败保留原界面；连接中禁止切换。
- 扫码建立连接后仍须私聊配对和显式工作区批准，不自动授予工作区或输入权限。
- 每条连接单独展开、操作和报错；移除保留确认步骤。
- 页面在后台 WebView 中也必须可见。实际发现 CSS/GSAP 入场时钟暂停会留下透明内容，因此移除 ChatApp 的初始透明动画，并让全局页切换在 `document.hidden` 时直接恢复可见样式。

## 自动验证

命令从 `apps/desktop` 执行：

```sh
node --test test/hermes-panel-dom.test.mjs test/workspace-motion-lifecycle-dom.test.mjs test/locale-provider-dom.test.mjs
pnpm exec tsc --noEmit
pnpm build
```

Hermes 行为 70 项、真实 React/GSAP 生命周期 21 项、语言提供器 7 项，共 98 项。包含原扫码竞态、迟到凭据、连接范围、授权控制，以及新增折叠、注意状态自动展开、取消失败保留、保存/关闭焦点恢复、后台可见性。通知日期无效时仍显示投递状态。

仓库根另执行 `pnpm check:file-size` 和 `git diff --check`。构建存在原有 chunk 大于 500 kB 提示。独立审查修复了窄窗口刷新入口和保存后的焦点，复审无阻断问题。本轮未改 Rust/Python，未重跑此前运行包与协议完整测试。

## 实际开发版验证

复用本任务拥有的规范 `pnpm tauri:dev` 实例，manifest 为 `.artifacts/tauri-dev/hermes-integration-phase0-dedbe6da.json`，标识 `com.ccem.desktop.dev.idedbe6da`，MCP `57700`。状态目录为已有隔离的 `.artifacts/hermes-qr-live/state`，运行组件 `2026.9.25.1`。

通过实际 WebView DOM 点击和真实 IPC，未替换 IPC、状态或二维码数据：

- 飞书生成真实官方二维码，进入 `waiting`，刷新产生新会话。
- 切换手动后状态 `cancelled`、二维码消失，Secret 为密码框；关闭后焦点回到添加按钮。
- Discord、Slack 选择后进入各自凭据表单，Token 为密码框，空凭据不能保存。
- 连接和运行组件分别展开；移除确认出现后取消，保留原连接。
- 在 1120 × 900 和 500 × 1000 实际窗口检查布局。窄窗口面板宽 419px、单栏、二维码白底 236px，页面无横向溢出，刷新入口可见。
- 临时切换根主题 class 检查深色，未写共享主题设置。后台 WebView 的 CSS 过渡暂停，截图前通过 Web Animations API 完成有限时长过渡；主题最终恢复浅色。没有改写内容来制作截图。
- 开发构建导致应用重载后，原企微连接经界面重新启动，最终 `running`、无错误，授权仍为原来的一条。所有测试二维码已取消，未创建飞书/Discord/Slack 账号。

原生 Enter 工具在后台 WebView 返回成功但未激活聚焦的按钮，因此未记为真实键盘验收；本轮实际操作证据为 DOM 点击。按钮使用原生 button 与 aria-expanded/aria-controls，未替换其键盘实现。该工具限制不计为键盘验证通过。

证据位于忽略目录 `.artifacts/hermes-ui-redesign/`：`desktop-proof.json`、`final-tests.log`、`typecheck.log`、`build.log`、`file-size.log`，以及 `channels-light.png`、`feishu-light.png`、`feishu-dark.png`、`manual-light.png`、`connections-light.png`、`channels-narrow.png`。

真实飞书机器人创建、私聊配对和任务收发仍未在本轮完成；二维码生成与 UI 验证不等同于账号端到端验收。交付为本地源码提交，未合入主线、未 push、未正式发行。

## 渠道图标补齐（2026-09-26）

行为契约：打开机器人列表和添加渠道页时，每个已知渠道有可识别的品牌或功能图标；进入扫码、凭据流程仍到达原有页面；图标不改变渠道的可连接状态。深浅主题及窄窗口均能显示，未知插件保留通用图标。

当前真实运行组件目录共 23 个渠道：21 个条目使用品牌资产（企业微信的两种接入复用同一标识），Email 与 IRC 分别使用 Hugeicons 邮件和井号。共内置 19 个 SVG 和 1 个 PNG，不依赖远程图标服务。来源、改动与许可证见 `apps/desktop/src/assets/hermes-platforms/NOTICE.md`。

在本任务独占的规范 `pnpm tauri:dev` 实例（MCP `57700`）执行真实 DOM 点击：

- 列表 → 添加 → 展开其他渠道，23 个条目的图标全部渲染，所有品牌图片 `decode()` 成功；原有 18 个未开放的渠道仍不可连接。
- 选择飞书进入扫码准备页，大图标为 28px；返回后选择 Discord，进入密码字段隐藏的手动凭据页；再次返回机器人列表。
- 1240 × 960 与 540 × 980 窗口均无横向溢出；窄窗口图标保留 24px，列表转为单栏。
- 临时切换根主题 class 检查深色；Buzz、Matrix、Raft、SimpleX 单色标识适配正常，彩色品牌保持原配色。完成后恢复浅色，未写共享主题设置。控制台未发现错误。

验证：`node --test --test-reporter=tap apps/desktop/test/hermes-panel-dom.test.mjs` 81 项通过；`pnpm exec tsc --noEmit`、`pnpm exec vite build`、`pnpm check:file-size`、`git diff --check` 通过。仅修改前端展示，未重跑 Rust 测试或外部机器人收发验收。

证据保存在 `.artifacts/hermes-navigation/`：`icons-proof.json`、`icons-{typecheck,build,dom,file-size}.log`，以及 `icons-channel-picker.png`、`icons-bot-list.png`、`icons-other-channels.png`、`icons-other-dark.png`、`icons-adaptive-dark.png`、`icons-feishu-setup-dark.png`、`icons-channels-narrow.png`。

## 原有 Remote Control 兼容检查（2026-09-26）

行为契约：Hermes 状态仍在加载、读取失败或尚未安装时，用户仍能展开“其他连接方式”，在原 Telegram / 微信 / 企微页面之间切换；Hermes 状态恢复后保留原来选中的平台。进入旧页面不安装 Hermes、不迁移或重写旧配置。

发现旧入口作为 `HermesPanel` 的 children 位于 `status && …` 内，首轮状态未返回或失败会隐藏旧入口。将入口移出该状态条件，保留添加向导期间的原有页面切换行为。新增行为回归先复现加载中、失败两项不通过，再验证修复后三种情况均可展开并切换三个旧平台；完整 Hermes DOM 套件 84 项通过。

代码比对确认此分支未修改原 Telegram / 微信 / 企微面板、桥接模块、配置接口或启动条件。旧配置路径仍是 `~/.ccem/{telegram,weixin,wecom}.json`，Hermes 使用单独的 `~/.ccem/hermes/`。Hermes 的重复身份检查只覆盖自身连接库，尚无跨新旧桥接服务的机器人身份互斥；同一机器人同时启用新旧服务不在本次兼容保证范围。

规范开发实例 MCP `57700` 的真实 UI 操作：展开旧入口，分别点击 Telegram、微信、企微，页面均加载，企微原有两个机器人及设置可见，控制台无配置加载错误。没有点击保存、启动、停止或发送消息。检查前后旧企微配置文件 SHA-256 相同，原先不存在的 Telegram / 微信配置文件仍不存在。开发实例自动后台服务关闭，截图“未运行”不代表安装版服务状态。

原生 invoke 属性不可改写，因此尝试注入 Hermes 状态失败未生效，没有将它记为桌面故障验证；故障与恢复由上述真实 React DOM 行为测试覆盖。后台 WebView 的 GSAP 过渡暂停，截图前完成对应三个有限过渡，未改写页面内容。

类型检查、Vite 构建、文件大小检查和 diff 检查通过。证据为 `.artifacts/hermes-navigation/legacy-compat-{before,dom,typecheck,build,file-size}.log`、`legacy-config-unchanged.json`、`legacy-wecom-preserved.png`。本次验证旧入口与配置保留，不等同于真实聊天收发验收，也未合入或发布。
