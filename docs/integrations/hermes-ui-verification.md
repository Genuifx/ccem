# Hermes 界面重设计验收

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
