# Hermes 多渠道、多连接验收

日期：2026-09-23。沿用 `codex/hermes-integration-phase0` 隔离工作树，在既有企微扫码链路上扩展；不升级用户独立 Hermes checkout，不改已安装的 CCEM 正式版。

2026-09-25 补充：飞书已增加官方扫码创建及手动备用入口，见[飞书扫码验收](hermes-feishu-qr-verification.md)。下文保留 9 月 23 日的历史验证范围。

## 行为合同与设计

用户在「远程控制 → 连接聊天工具 → 添加渠道」选择平台。同一平台可添加多个账号，连接的配置、进程、配对、授权和通知按 accountRef 隔离。停止 A 保留 A 的配置与授权，移除 A 撤销 A 的授权及待发通知，均不改变 B。修改凭据需重新授权，仅改名称保留授权。

| 渠道 | 创建/配置入口 | 当前托管范围 |
| --- | --- | --- |
| 企业微信 | 官方扫码创建、手动 Bot ID / Secret | 顶层私聊 |
| Telegram | Hermes 官方服务扫码创建、手动 Bot token | 顶层私聊 |
| 飞书 | App ID / App secret、官方配置指南 | WebSocket、顶层私聊 |
| Discord | Bot token、官方配置指南 | 顶层真人私聊 |
| Slack | Bot token / App token、官方配置指南 | 一个 workspace 的顶层真人私聊，使用 `!ccem` |

扫码产生机器人连接，不自动授权工作区。Telegram 返回的 owner_user_id 不成为授权依据。所有渠道都要求原生私聊口令及桌面批准；其他 Hermes 渠道可搜索但标明未接入，不因 SDK 可导入就承诺可用。

技术方案比较了每连接独立进程与 multiplex：采用独立 profile/进程/令牌，共享签名运行包。[Hermes 官方多 profile 文档](https://hermes-agent.nousresearch.com/docs/user-guide/multi-profile-gateways)提供技术参考；[隔离问题](https://github.com/NousResearch/hermes-agent/issues/109417)和[连接身份问题](https://github.com/NousResearch/hermes-agent/issues/94811)用于识别风险。这些资料比固定源码 `bc1330e` 更新，不视作该基线已经具备的修复。产品路径参考 [OpenClaw 渠道选择](https://docs.openclaw.ai/channels)与[账号路由](https://docs.openclaw.ai/channels/channel-routing)。最小 spike 使用两个真实私有 host，停止 A 后 B 仍可响应，不连接外部账户。

旧配置通过单个 SQLite 事务迁移，保留 accountRef、原密文和路由。修改前使用 SQLite backup 保存私有备份；实际迁移后逐项比较均一致，结果保存在 `.artifacts/hermes-multichannel/migration-proof.json`。

## 回归与审查

- 最终全量 Rust 回归：1734 通过、4 显式忽略；Hermes 状态、协议与启动队列聚焦 55 项通过。
- 初轮 Desktop 全量行为回归：1286 通过、2 跳过；最终 UI 专门 DOM 回归 63 项通过，三项独立复现均已转绿。
- Python host/扫码回归：11 + 28 + 8 + 3 项通过，覆盖严格来源、完整输入预览、私有轮询凭据、取消/过期/替换、重定向、响应大小及错误脱敏。
- 新的实际 adapter/HTTP 回归：22 项通过；原托管契约 15 项通过。导入真实 pinned adapter，替换外部 SDK/HTTP 边界，验证 native ingress、首次配对可达、精确目标、原生回执、一次发送、拒绝线程/群聊、断线和恢复。
- 最终私有制品：5 项通过，实际导入五渠道依赖；禁止网络的自检通过，分别屏蔽 aiohttp、Telegram SDK 后同一自检必须失败。
- 文件长度检查及 Desktop 构建通过。测试包使用 `2026.9.23.3 / sequence 5`，源码、补丁、锁文件与签名清单可复核。

独立复审已修复：更新失败/取消隐藏旧连接；慢配对锁住其他账户；迟到状态覆盖新动作；QR 重试成功保留旧错误；通知截断丢失末行查询命令；投影错误误报连接断开；Telegram/企微断线仍显示在线；更新与后台自动启动竞争旧运行包租约。通知保留完整末行命令；Slack 仅转换桥生成的末行前缀，不改用户任务正文。

实际桌面测试还发现新增连接的完整运行包校验持有全局锁。最终改为单个后台验证队列，同目标合并待办；每次启动仍执行完整签名和文件校验。连接立即显示 `starting`，旧连接可配对、停止或移除。停止、删除、改凭据及更新撤销旧启动代次；更新在锁外等验证租约释放后才切换版本，卸载保留原同步操作语义。QR 的连接超时从进程实际发布后计时，进程与待办状态在同一临界区读取。回归使用真实队列、Store 和私有 GatewayProcess，受控阻塞验证时先完成另一连接的授权读取、配对、停止和删除，再释放验证并证明旧启动未发布。

现场 Telegram 请求发现官方 broker 返回私聊管理机器人的 `https://t.me/<bot>?start=<nonce>` 链接，原先只接受 `/newbot/...` 会误拒绝。依据实际 HTTPS 返回和 [Telegram 官方 deep linking 文档](https://core.telegram.org/bots/features#deep-linking)补齐私聊形态；仍只接受固定 broker 返回的精确 `t.me` 域名、单个受限参数，不允许群聊、跳转、额外或重复参数。新增回归先复现失败再修复，修正后的私有 helper 实际取得二维码并轮询到 `waiting`；独立边界审查另验证 16 个 URL 用例。

本轮日志、签名测试包和安装观测保留在忽略目录 `.artifacts/hermes-multichannel/`。构建 receipt 记录包字节、全部文件数、原生依赖审计和重定位自检；私钥、机器人凭据和原始 SQLite 备份不进入 Git。

## 真实桌面观测

使用本工作树的标准 `pnpm tauri:dev` 启动器，按 manifest 精确连接 `com.ccem.desktop.dev.idedbe6da / MCP 57700`。通过实际 WebView DOM 点击、输入事件和 Tauri 后端执行，而非替换 IPC 的演示页面。

- 五个入口均可选择，飞书、Discord、Slack 展示各自必填字段与官方指南；缺少必填值时不能提交。其他渠道搜索 WhatsApp 后仍明确不可连接。
- 在隔离状态目录添加三个使用虚构凭据的 Telegram 测试连接，分别显示身份与错误；修改名称不回显旧密钥，未修改的编辑表单不可重复提交。逐个通过本账号确认框移除，测试连接已全部清理。
- 最终后台版本再添加一个测试连接：它仍显示「正在连接」时，原企微成功打开本人配对并渲染配对区；同时可移除该启动中的连接，实际状态立即只剩企微，原有效授权仍为一条。此前全局校验阻塞的现场复现已经转绿。
- 原有企微连接停止后仍保留同一 accountRef 和一条有效授权，随后重新启动恢复 `running`。这证明连接生命周期和已有配置保留，不等于客户端收到新消息。
- 用私有 loopback 测试源模拟离线，实际点击更新后得到 `source_response`；旧运行包 `2026.9.23.2` 保留，企微自动恢复且界面显示「已连接」，配对和重试按钮可用。恢复测试源后，从「重试安装」成功安装 `2026.9.23.3 / sequence 5`，企微再次自动恢复 `running`。安装期间按钮被禁用，直接调用 `refreshPlatforms` 和 `beginSetup` 均返回 `installation_already_running`；测试源故障开关已清除。
- 最终运行包实际请求 Telegram 官方服务，二维码在页面渲染为 208 × 208 SVG，状态进入 `waiting`，继续轮询后仍无错误，企微同时保持在线。随后实际点击取消，二维码消失且状态为 `cancelled`；未扫码、未创建 Telegram 账号连接。开发版最终停留在五渠道选择页，原企微账号和一条授权保留，四个虚构测试连接均已移除。
- 本轮 Mac 持续锁屏，Computer Use 明确无法进入企业微信，截图也未成功。本轮保留 WebView 行为与后端状态记录，不将其描述为原生鼠标验证、屏幕截图或企微客户端实聊复测。

上述最终状态的脱敏记录在 `.artifacts/hermes-multichannel/desktop-completed-proof.json`；制品与当前补丁、host、helper 的一致性记录在同目录 `source-package-proof.json`。

## 验证边界

此前真实新企微机器人的「扫码 → 配对 → 查询 → 确认执行 → 完成通知」见 [扫码现场验收](hermes-qr-verification.md)。本轮不把该结果改标为新增四渠道的真实账号验收。Telegram、飞书、Discord、Slack 的实际用户账号收发仍需对应账号配置；adapter 边界测试不能证明平台侧权限或用户已收到消息。

本地源码、签名测试运行包、开发版界面与正式发行是不同交付状态。当前没有发布生产源、Apple 签名公证或新正式版本；未 push、未合入主线。

## 本地交付

分支 `codex/hermes-integration-phase0`。主 checkout 与 `/Users/wzt/G/hermes` 保持干净。后续合并前须先协调主线差异并复验；确认合并后再清理工作树：

```sh
git merge codex/hermes-integration-phase0
git worktree remove .worktrees/hermes-integration-phase0
```

清理前先保存需要的私有 `.artifacts` 验收证据；以上命令本轮未执行。
