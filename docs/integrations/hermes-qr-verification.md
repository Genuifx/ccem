# 企业微信扫码接入验收：2026-09-22

本次接续托管 Hermes 实现，按用户要求将「扫码创建新机器人并自动关联 CCEM」作为默认入口，保留手动配置。真实新机器人已完成「创建确认 → 自动连接 → 私聊配对 → 查询 → 预览并确认执行 → 完成通知」验收；另验证取消不执行、重复确认不重复执行。9 月 10 日既有 Hermes 机器人的收发记录不作为本次新托管连接的证据。以下是本地开发版结果，不代表合入主线或正式发行。

## 行为合同

用户在 CCEM 的「远程控制」安装组件、生成二维码，用企业微信完成新机器人创建。CCEM 自动获取完整凭据并加密保存，建立私有连接；用户在新机器人私聊发送一次配对口令，然后在 Desktop 仅授权测试工作区。随后从企微查询测试任务，提交只读提示，核对预览并另发确认，最终在真实聊天中收到与该次执行关联的完成通知。

取消、过期和刷新后的旧扫码结果不能改变配置。扫码返回的机器人凭据不代表扫码者已获得工作区权限；手动配置与扫码接入使用同一套配对和授权规则。

## 现场环境

- 分支：`codex/hermes-integration-phase0`，本次改动基于 `8cf1e7a2cabd2b5eb3ba4798df84823523e72ce9`。
- 通过工作树规范 `pnpm tauri:dev` 启动专属开发实例，bundle ID `com.ccem.desktop.dev.idedbe6da`，MCP 57700。共享后台服务关闭，使用专属 Hermes 状态目录和 CLI 控制描述文件。
- 新运行包 `2026.9.22.1` / sequence 2，使用本地测试信任根。生产签名、公证和发行不在这次现场证据中。
- 验收会话使用真实 Codex `gpt-6-astra`、`readonly`，工作区为本工作树的 `.artifacts/hermes-qr-live/workspace`，runtime ID `native-527527e74ecd5b00593f5033c27bb08f`。
- 没有配置、切换或重启用户原有的机器人连接。

## 当前实际观测

| 验证面 | 证据与边界 |
| --- | --- |
| 新包依赖与能力 | 私有包加载真实 WeCom 适配器，`available=true`、`qrSetup=true`；修正旧包漏带 `aiohttp` 的问题。不能把旧包的“已安装”当作企微可连接。 |
| 空状态安装 | 在实际 Desktop 点击「安装聊天组件」，观察下载、校验到「已安装」，版本为 `2026.9.22.1`。安装使用真实签名测试包与完整文件校验。 |
| 默认入口 | 安装后实际界面显示「扫码创建企业微信机器人」「生成二维码」及独立的「已有机器人？手动连接」。 |
| 官方二维码 | 在实际界面点击生成，私有 host 请求官方接口，UI 呈现真实二维码并进入等待确认；二维码内容为官方 `auth_url`。保留现场截图 `qr-waiting.png`。 |
| 过期 | 首个未扫码会话在 300 秒后进入 expired，实际 UI 隐藏二维码并显示重新生成入口。该次未创建机器人、未取得凭据。 |
| 手动入口 | 在真实 UI 点击「已有机器人？手动连接」，看到空的 Bot ID 与 password 类型的 Secret 字段；点击「改用扫码创建」回到默认入口。没有写入手工凭据。 |
| 原生测试任务 | CLI 事件 seq 8 为 `CCEM_QR_READY_20260922`，seq 9 为 `turn_completed`，seq 12 为 `ready`；已证明模型实际执行，尚不是从企微发起执行的证明。 |
| 创建与自动连接 | 后续二维码在企微侧完成创建确认后，Desktop 的 setup 实际进入 connected，gateway 进入 running；新机器人沿用创建者默认名称。未手工抄写 Bot ID 或 Secret。 |
| 私聊配对与范围 | 新机器人私聊实际发送 `/ccem connect <nonce>` 后，Desktop 出现原生发送者的待配对项。在 UI 仅选中测试工作区、后续指令和通知开关，再点击确认配对；持久 route 的范围与 UI 一致。 |
| 查询 | 在真实企微客户端发送 `/ccem list`，只返回本次测试 runtime；`/ccem status <runtime>` 返回 ready 和实际时间。 |
| 取消不执行 | 第一条待确认输入在聊天中取消，实际收到 cancelled。回读原生事件仍止于 seq 12，没有新 user_prompt，也没有新操作。 |
| 预览与确认执行 | 新指令的完整预览要求不使用工具、不读写文件、只回复验收标记；随后以独立企微消息确认。原生 seq 16 的 client_message_id 与桥操作 ID 相同；seq 22 返回 `CCEM_QR_WECOM_CONFIRMED_20260922`，seq 23 为对应 SDK input_operation completed，seq 24 为 turn_completed。 |
| 完成通知 | 新机器人私聊实际出现对应 runtime 的 completed 通知和操作查询指令；同时核对客户端 AX 与截图。桥仅有一条 sent 投递，receipt 为 WeCom ACK。真实收件以客户端观测为依据，不只看 ACK。 |
| 重复确认 | 在同一聊天再次发送同一确认，返回同一 completed 操作。重放前后原生事件完全相同，最新 seq 均为 27，该 client_message_id 只对应一个 user_prompt；桥仍只有一条通知。此项证明本次顺序重放，不扩写为任意并发下 exactly-once。 |
| 聊天回读结果 | `/ccem events <runtime> 21` 在企微返回精确验收标记和 turn_completed，游标 26。 |

现场期间 Computer Use 曾超时，随后恢复。尝试自动打开官方创建页时，浏览器安全策略拒绝该操作，因此没有绕过策略代替用户执行创建确认；企微侧确认完成后，继续通过原生客户端完成了上述聊天操作。实际发送仅限本人文件传输助手中的这次短时创建链接，以及新建机器人的验收消息。

## 自动回归与复审

- Python QR、host 并发与本地 HTTPS：26 项通过；既有 host 6 项、真实适配器来源配对 1 项通过。
- 实际私有运行包：4 项通过，含缺少 `aiohttp` 时自检必须失败的负向测试。
- Rust 专项：35 项通过，覆盖真实子进程的迟到回复与停止、替换隔离，以及 SQLite 中途故障后的完整回滚和重开。
- 全仓 JavaScript/TypeScript 测试：core 124、native runtime helper 324、CLI 337、server 17、Desktop 1267 项通过，Desktop 2 项跳过。
- 最终扫码 DOM 回归：32 项通过；TypeScript、i18n、Desktop 构建、文件大小门及 diff 检查通过。
- 首次 Rust 全量为 1711 项通过、1 项失败、4 项跳过。确定性复现表明，并发 fork 的继承描述符使仅 close 的 Store 保留文件锁；修复为 SQLite 关闭后由 RAII guard 显式 unlock，没有加 sleep 或重试。最终全量 **1713 项通过、0 失败、4 项跳过**。

证据保存在本工作树未跟踪的 `.artifacts/hermes-qr-live/`：`verification.json`、`native-before-confirm.json`、`native-after-confirm.json`、`native-after-replay.json`、`runtime-package/build-receipt.json`、`runtime-build.log`、`qr-setup.png`、`qr-waiting.png`、`manual-setup.png`、`connected-completed.png`、`monorepo-tests.log`、`rust-tests-final.log`、`desktop-build-final.log`。企微真实收件截图在本次 Computer Use 会话中。扫码截图仅用于这次短时现场验收，不提交二维码、轮询码、凭据、控制令牌或私钥。
