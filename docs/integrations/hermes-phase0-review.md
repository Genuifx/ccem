# REQ-0007 接手 review 与阶段 0

日期：2026-09-09 至 09-10。状态：阶段 0a 本地接手、review 和安全修复已验证；完整阶段 0 未通过。

用户本轮要求接手 Hermes 集成，先 review，再按指定 complex-feature-dev-mode 推进。
附件 req-0007-arch-v3.md 是需求与历史决策材料，其中“本轮只写方案”等上一轮指令不替代当前授权。
初次 0a 未推送、发布、迁移账号、修改全局 Hermes 配置或发送外部消息。
随后用户要求直接验证；已完成真实 CCEM 任务通知至企业微信本人私聊、顺序重复投递和 Hermes 原生命令往返，见 [真实渠道验收记录](hermes-live-verification.md)。完整阶段 0 仍未通过。

## 用户结果与架构判断

目标继续是：用户在 CCEM 内按需准备聊天组件、授权渠道并确认目标，之后在聊天中收通知、查任务、确认后继续任务。
CCEM 拥有任务、路由、访问策略、操作与投递账本；Hermes 拥有平台 SDK、聊天身份、账号与连接。
新平台不在 CCEM 再增加一个 SDK/平台分支；个人微信只能通知。

v3 总体边界可保留，但不能按原样直接进入阶段 1。尤其需要修改 12.2 的默认逐消息 CLI 调用，以及补齐 12.3 的可信来源和 12.4 的操作关联。
“已有 helper”“传了 clientMessageId”“返回 success”均不足以替代这些契约。

## 接手基线

- CCEM：已 fetch 的远端 main `4984ab70`，在独立分支 `codex/hermes-integration-phase0` 开发。
- 旧阶段提交 `9bc77edf` 保留，内容无冲突引入为 `3df96985`，没有修改旧需求 worktree。
- Hermes：本地源码 `bc1330eebc0aa8a443501b5f62586eb7361353a5`，声明 0.21.0、Python >=3.11,<3.14；本地探针 Python 为 3.11.16。这是验证快照，不是已批准的发行基线。
- Hermes uv.lock SHA-256：`6393f09ee88cc5683f0e563306f96b5c068f901a8baa60f7209f302c1ac602d9`。
- 主 checkout 的 README、assets、docs/drafts 与两份 research 草稿保持原样。独立 Hermes checkout 未被改写。
- 首发系统/平台已经向用户征询；无答复时仅以当前 macOS arm64 做本地探针，不把企业微信合成样例当成首发账号选择或发送授权。

## Review findings

| ID | 级别 | 问题、证据与影响 | 处理 |
| --- | --- | --- | --- |
| R1 | P1 | 旧 remote send 直接调用全权限 workspace.sendInput；source 与 --confirm 均为调用者自述。旧 CLI remoteBridge.ts 的注册路径、external_control.rs 的全局 Bearer 验证可证。 | 本轮关闭该实验入口；后续必须用桥专用令牌与可信来源，不能把旧控制描述文件交给插件。 |
| R2 | P1 | native_runtime 的 Claude 路径有输入队列去重，但 Codex 路径会再次提交；clientMessageId 只写入 UserPrompt 不等于去重。旧测试仅比对两次 ID。 | 本轮不再宣称远程写幂等；需 provider 无关的操作账本与提交边界测试。 |
| R3 | P1 | Hermes WeCom _standalone_send 在独立进程无 live adapter 时构造、connect、send、disconnect。源码说明每 bot 单 WebSocket；按通知启动 CLI 可能挤掉网关。 | 实际导入 Hermes sender，用 SDK fixture 复现分支。修订默认出站为网关连接复用契约；未有该契约前关闭实验 relay。 |
| R4 | P1 | Hermes Telegram 在 thread not found 时去掉 thread ID 后向根聊天重试，仍返回 success。客户端只检查 success 无法保证精确目标。 | 独立无网络函数探针复现；要求 Hermes strict-target 行为与有效目标回执，不能由 CCEM 自己新增 Telegram 发送器。 |
| R5 | P2 | stdout.length 按 UTF-16 字符计数，90026 字节回执被接受；非法 UTF-8 被替换后仍可判成功。 | 本轮改为 64 KiB 字节累计与 fatal UTF-8 解码，回归覆盖合法字符跨 chunk 分割。 |
| R6 | P2 | 旧 helper 只发 SIGTERM 并立即 reject，忽略 SIGTERM 的自有子进程继续运行，且可保留发送能力。 | 本轮等待 close，有界升级 SIGKILL，并限制残留管道等待；真实子进程回归证明已回收。 |
| R7 | P1 | 实际 Desktop 全量会话 RPC 声明 379691 字节，仅返回 327118 字节。macOS accept 继承非阻塞状态，write_all 返回 WouldBlock 后错误被丢弃；独立 TCP 复现吻合，8 MiB 慢读回归在旧语义下失败。 | 接收连接后明确切回 blocking，保留读写超时并报告配置/写入失败；重新验证大响应和真实 CLI 事件分页。 |

另外，实际 Hermes 插件注册与 Gateway 命令分发探针表明：回调只获得 raw_args，两个不同合成来源得到同样参数，没有发送者/聊天/原消息的可信上下文。
pre_gateway_dispatch 位于鉴权之前，不能拿它当已授权来源。这个缺口同时影响查询和写操作；不能仅关闭写入后宣称聊天查询已安全。

媒体部分成功可能有 success:true + warnings，但本轮 relay 会破坏 MEDIA 指令，尚未证明纯文本能触发该路径。保留为未来回执契约检查，不扩大为当前纯文本 bug。

## 外部调研与推荐

已查技术线、产品线和反面证据；对新 API 的取舍以本地固定源码动态探针为准。

1. 私有 Python/Hermes 预构建组件 + 独立插件（推荐）：适合按需下载与不改用户独立安装的要求。Hermes 官方建议第三方集成独立分发，并说明插件兼容性按具体行为保证；不能假设存在统一插件 API 版本号。风险是需要补齐通用可信上下文与网关发送契约。[Hermes 插件文档](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins/)
2. 独立 CLI 逐消息发送（仅保留为测试材料）：现有接口简单，但本地 WeCom 连接竞争和 Telegram 目标降级已否定其作为通用默认的适用前提。只增加回执 JSON 校验无法解决。应在 Hermes 侧做有能力声明的通用发送入口，不在 CCEM 复制平台 SDK。[Hermes 源码基线](https://github.com/NousResearch/hermes-agent/tree/bc1330eebc0aa8a443501b5f62586eb7361353a5)
3. 客户端现场 uv/pip 安装（排除）：uv 能准备托管 Python，但缺 wheel 时可能构建源码，不满足用户免开发环境和锁定分发的契约。uv 仅作为制品构建端候选，客户端接收已签名闭包。[uv Python](https://docs.astral.sh/uv/concepts/python-versions/)、[uv 解析规则](https://docs.astral.sh/uv/concepts/resolution/)

产品参考：Slack 对交互要求及时确认收件，后续结果独立回复，因此保留 accepted 与 completed 分离；这不表示 CCEM 应新增 Slack webhook。平台交互仍由 Hermes 负责。[Slack 交互指南](https://docs.slack.dev/interactivity/handling-user-interaction/)
反面证据使用真实 Hermes 出站/入站源码探针，较泛化行业故障案例更直接。Tauri 既有 browser/runtime 下已有签名清单、下载、暂存与激活设施；后续复用原语前要剥离 browser 专属语义，不另外复制一套安装器。

## Grilling Gate 决策

- 鉴权：本地 Bearer 只能证明控制面调用权限，不能证明聊天授权；插件只获受限令牌。令牌通过私有 IPC，不能通过聊天、模型参数或全局环境传递。
- 输入：受理前持久化 request/operation，重新提交未知操作前先核对；不能把任意后续 SessionCompleted 关联给该输入。重启后提交状态不明必须为 unknown。
- 出站：一次网关连接拥有者；使用不透明账号/目标引用，strict-target 失败不改投。优先验证通用网关发送方法，缺方法时在 Hermes 通用插件边界补齐。
- 单独的 payload.success 只表示发送方声明成功，不等于目标未变化、用户已读或全任务完成。
- 范围：本轮本地安全收口和可重复探针不依赖真实账号；渠道接入、签名制品与干净机器验收仍需要后续阶段证据。
- 退役：保留旧 SDK；14 天实际观察与删除窗口仍为 v3 提案，不创建自动化，也不按本轮测试时间开始计时。

## 实施阶段与停止条件

| 阶段 | 文件/模块与可观察结果 | 验证/停止条件 |
| --- | --- | --- |
| 0a 接手和安全收口（本轮） | 保留 event projection、本地 status/events；旧 remote send/relay 在 RPC 前明确拒绝；修复子进程回执与退出；scripts/hermes 提供动态契约报告 | 实际 CLI + 回环 HTTP + 真子进程回归；实际 Hermes 函数与 SDK fixture；Desktop 唯一 dev 实例检查事件读取和渲染。基线问题单独记录。 |
| 0b Hermes 通用契约 | 独立插件/上游通用扩展：鉴权后的命令上下文、原生确认事件、复用既有连接的 strict-target 发送、账号目标寻址和能力快照 | 锁定新 Hermes/插件版本，证明不调用模型也可查/确认；跨目标/用户/代次拒绝；重启撤销；无平台 SDK 新增到 CCEM。不可用能力继续禁用。 |
| 0c 制品及体验验证 | 复用 Tauri 安装原语，准备 Python/Hermes 渠道依赖闭包，签名清单、下载预检、私有 profile 生命周期、恢复原型 | 确认运营来源/信任根；干净机器、无系统 Python/Node、坏包、断网、空间/权限失败、取消/重启/回滚；实测下载与落盘预算。开发 venv 体积不能冒充发行包。 |
| 1 托管安装和可靠通知 | Remote Control 向导、runtime manager、持久订阅与出站账本 | 仅点击启用才下载；旧路径不自动切换；unknown 不重发；真实授权聊天有回执和任务通知。 |
| 2a/2b 查询和写确认 | 受限 bridge RPC、主体/工作区路由、challenge、持久幂等、输入轮次关联 | 真实聊天查询/选择任务/确认写入/异步结果；无确认和重复确认不多执行；所有 Provider 行为回归。 |
| 3 迁移和退役 | 账号归属代次、暂停结算、显式迁移/回退、逐平台删除 | 真实流量观察与全部退役门通过后单独提交删除，不在此次接手完成时自动触发。 |

高风险恢复：只回收本任务创建的 dev 实例；0a 可回退到保留的旧阶段提交进行对照，但不得据此开启聊天写通道。后续 schema 和配置迁移必须连同数据恢复验证，不能仅回滚可执行文件。
每次阶段通过后独立审查；同一 finding 两轮未修好就回到方案层。0b/0c 未通过，不把 0a 测试通过当成阶段 1 的放行。

## 验证记录与边界

本轮原始证据位于未跟踪的 `.artifacts/hermes-phase0/`，独立审查与合成复现位于 `independent-review.md` 和 `review-probes/`。
`compatibility.json` 记录固定源码提交、lock hash、主机与每个动态探针；它明确返回 stage0Passed:false、livePlatformVerified:false。

探针复审额外修复了导入副作用：Hermes 完整 gateway.run 会读取并可能重写源码目录 .env，因此仅替换进程内 runner 查找边界，不导入整套 runner。导入前启用文件/网络/进程审计护栏：外部数据文件不可读、临时目录以外不可写，相对 open 不能利用 dir_fd 绕过，未连接 datagram 也不能发送。4 条独立子进程回归只使用合成文件和 Unix socket；原 UTF-16 .env 字节保持不变。此护栏适用于审阅过的源码，不是恶意原生代码沙箱。

已跑基线：core build + 旧 remote-bridge 9 tests 通过；最新生产依赖审计 high=0、critical=0（low=2、moderate=14），因此 v3 中 xmldom 的旧阻塞在此基线已解除。
额外 CLI tsc --noEmit 发现既有 JSX 配置及 ui.ts PermissionModeName 错误；它不是仓库原生 CLI build 路径，不在本轮顺手修改。正式验证结果另记证据报告。

已在本任务唯一 Desktop dev 实例实际点击“应用导航 → 远程控制 → 企微 → Telegram”，检查渲染、已有配置展示与未启动状态；没有保存配置、启动机器人或切换账号归属。实际 CLI 对本需求历史 runtime 的 status 和 events 读取成功，首批 100 条记录具有稳定 event_id、nextCursor=100 和 hasMore=true；send/relay 在任何发送前返回 CAPABILITY_UNAVAILABLE。真实 RPC 记录单独保存在 desktop-rpc-smoke.json。保留的截图为导航状态，远控页以实际点击和 MCP DOM 观测为证；最终复拍因 MCP 连接关闭/执行超时失败，没有把它算作远控截图验收。

最终验证：CLI build + 337 tests、Desktop build + 前端 1239 tests（2 skipped）、Rust 1660 tests（2 ignored）、Python 隔离 4 tests 均通过。独立复审另有 19 项合成护栏检查通过。重启后的 Desktop 全量会话 RPC 在客户端延迟读取 100 ms 下完整收到 379696/379696 字节、解析 515 条会话；事件下一页 nextCursor=200，与第一页无重叠。没有保存会话正文，只保留数量、字节数和哈希。

桌面首次自测遇到缺少生成的 Node sidecar，以及 CEF 依赖重复下载等待；使用仓库原生 Desktop build 准备 sidecar，并经启动器支持的 CEF_PATH/CCEM_CEF_FRAMEWORK_PATH 指向本机已有同版本 150.0.10 缓存后完成。全程保留 Cargo --locked，未改依赖锁文件。开发机复用缓存不能替代干净机器安装验收。

截至初次 0a，真实平台发送、干净机器安装、跨平台发行签名、原聊天确认、持久队列与真实运行时幂等均未验收。后续真实试发已补齐企业微信收件正例及顺序重放证据，同时复现 Hermes 超时补发和队列并发清理的重复发送风险；其余阶段门不以该正例补齐。
