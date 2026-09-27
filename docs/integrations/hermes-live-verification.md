# Hermes 真实渠道验证：2026-09-10

结论：当前开发分支完成了一次真实 CCEM 任务 → Hermes 既有网关 → 企业微信本人私聊的通知验证；相同通知的顺序重放未重复发送，企业微信发入 Hermes 的只读 `/status` 也实际收到回复。完整 REQ-0007 阶段 0 仍未通过：这不是托管安装、CCEM 聊天查询或确认写入的交付。

用户在初次 review 后明确要求“直接验证，不用管现有的链接”。本次据此使用已有本人私聊直接验证，没有把旧连接保留作为停止条件。真实渠道样本为 macOS arm64 上的企业微信；未把飞书的已连接状态计为飞书验收。

## 版本和行为合同

- CCEM：`codex/hermes-integration-phase0`，运行代码 `90cce7706d0ee7c3ffd54cfcfdfdf1f45108b86c`，版本 2.83.0。
- Hermes：实际 checkout `bc1330eebc0aa8a443501b5f62586eb7361353a5`，Python 3.11.16；源码和现有账号配置未改写。
- 通过规范 `pnpm tauri:dev` 启动本任务独有的开发实例；MCP 57700，开发实例后台共享服务关闭，CLI 使用本任务的私有控制描述文件。
- 发件侧采用已安装的 `hermes-demand-executor/scripts/hermes_notify.py`，由 Hermes 既有网关消费 durable queue。该 helper 的配置和正文均由本地测试程序构造，不由聊天输入提供。
- 行为合同：新建一个只读 Codex 测试任务，取得精确回答和其后的 `turn_completed`；将唯一标记及完成事件发到本人聊天；在实际客户端核对消息；同 ID、同正文顺序重放后消息不增加；在同一聊天发送只读命令并核对原生回复。

## 真实执行结果

时间为 Asia/Taipei，2026-09-10。

| 验证 | 观测 | 结论 |
| --- | --- | --- |
| CCEM 实际执行 | 00:30:40 创建 `native-4be25cec0c829063e2590cc3ea6b60f3`；模型 `gpt-6-astra`、readonly；seq 7 回答 `CCEM_HERMES_LIVE_OK_6350518c3e2c`，seq 8 为 `turn_completed`，seq 11 为 `ready` | 通过；不是只看 ready 或创建成功 |
| 事件投影 | 读取全部 11 条事件，cursor 11，sourceAvailable=true，gapDetected=false；投影中标记及原事件身份相符 | 通过；本次只有一个输入，没有证明并发输入的 operation 关联 |
| CCEM 桌面 | 点击本测试任务后，实际 DOM 中的回答段落与标记完全一致且可见 | 通过；MCP 截图超时，不声称保留了桌面截图 |
| Hermes 入队与发送 | 通知 ID `ccem-hermes-live-6350518c3e2c`，00:35:13.763 入队，00:35:46.111 终态 delivered；网关处理 PID 62733 | 队列完成；单独此项不能证明平台收到 |
| 企业微信收到 | 原生客户端「黄金体验」本人私聊在 00:35 显示一条测试结果，标记和完成事件 `native-4be25cec0c829063e2590cc3ea6b60f3:8` 相符；同时核对 AX 和实际截图 | 真实收件通过；不等于对方已读或所有失败路径可靠 |
| 顺序重复通知 | 00:36:23 用同 ID 和完全相同 payload 再入队，返回原 delivered；执行 ID、owner、created_at、finished_at 和 error 都未变；聊天未新增第二条测试通知 | 本次顺序重放通过；不能推广为并发或崩溃下 exactly-once |
| 企业微信 → Hermes | 00:38 在相同私聊发送 `/status`，实际收到 `Hermes Gateway Status`，`Agent Running: No`，连接平台 feishu、wecom | 原生入站命令往返通过；这是 Hermes 状态命令，不是尚未实现的 CCEM 受限查询 |
| 错误目标与不存在的通知 | 已部署 helper 拒绝 deliver/origin 不一致的请求（invalid_request），查询该 ID 仍为 not_found；另一个从未入队的 ID 同样为 not_found | 请求在入队前拒绝；没有向错误目标试发 |

测试任务调用了真实 Codex 模型。`/status` 走 Hermes 的确定性原生命令处理器，本次未通过普通聊天额外启动模型任务。通知使用独立 job ID，并已回读当前 cron jobs 确认没有该 ID；当前 cron 投递包装仍在正文附带了“管理提醒”的文案，这是复用旧投递入口的体验缺口。

队列约 32 秒后处理与当前源码的默认 60 秒 housekeeping tick 相容。`chores` 中的 `1` 是每个 tick 执行，不是每秒执行；一次样本不构成延迟保证。

## 可靠性复测发现

下列是隔离环境中执行实际 Hermes 函数、临时 SQLite 和真实 asyncio Future 的合成故障测试。没有在本人聊天中制造 ACK 丢失、网关崩溃或重复消息。

| ID | 严重性 | 复现及影响 | 后续契约要求 |
| --- | --- | --- | --- |
| L1 | P1 | `cron/scheduler_delivery.py::_live_send_text` 超时后以 Future.cancel() 判定未 dispatch。实际 coroutine 已进入发送，cancel 仍可返回 true；一次 queue claim 中 live 与 standalone 各调用一次，最终仍 delivered。 | 失去确认返回 unknown；不能以 cancel 成功证明尚未发送，也不能自动换发送路径。 |
| L2 | P1 | `WeComAdapter._send_inner` 在被动发送 ACK 超时后改为主动发送；模拟丢失 ACK 后观察到 passive → proactive，仍 success。 | strict 模式必须保留不确定结果，禁止可能重复的补发。仅去掉 scheduler fallback 还不够。 |
| L3 | P2 | `delivery_queue.enqueue` 的 tombstone SELECT 与后续 INSERT 之间没有覆盖整个判断的写事务。另一独立锁的队列实例恰在两者之间把终态 row 转成 tombstone；原 enqueue 又插入 pending，同 ID 最终回调两次，tombstone 仍存在。 | 将 tombstone 检查和插入放在同一原子事务内，保留并发清理回归；不能仅依靠 execution_id 主键。 |
| L4 | P2 | 通用通知被包装成 `Cronjob Response`，还提示用户管理并不存在的同名提醒。 | 独立的通知入口或明确的非 cron 包装选项，复用网关连接而不泄漏内部调度语义。 |

另已复现：`enqueue_and_wait` 在 pending 超时也可返回 None；终态擦除 payload 后，拿旧 ID 配新正文会得到旧 delivered；failed 只说明发送回调报错，不能证明消息未发。测试程序因此先冻结 payload、记录尝试，再按同一 ID 查询；不对 unknown/failed 自动换 ID 重试。

已有的安全修复继续有效：实验 `remote send`/`remote relay` 仍在 RPC 或启动子进程之前返回 `CAPABILITY_UNAVAILABLE`。本次试发通过受控测试程序接入现有通知队列，并未把该队列直接接成生产桥。

## 可复现材料和下一阶段

原始证据保存在本 worktree 未跟踪目录 `.artifacts/hermes-live/`：

- `state.json`：创建回执、实际任务状态、原事件、投影；`smoke.mjs`：按唯一目录复用测试任务，避免盲目重复创建。
- `notification.mjs`、`notification.json`：冻结的本人目标与正文、发送尝试、状态变化和原生客户端观测。
- `queue-before-duplicate.json`、`queue-after-duplicate.json`：顺序重复前后的持久记录比较。
- `desktop-task-dom.json`、`wecom-ui-observation.json`：实际客户端观测，明确截图可用性。
- `live-negative-cases.json`：错误目标未入队、不存在的通知返回 not_found、未注册同名 cron 的验证。
- `independent-queue-review.md`、`queue-contract-probe.py`、`queue-contract-results.json`：独立源码复审与合成故障复现。
- `reproducible-queue-contract.json`：由仓库的 `scripts/hermes/probe-delivery-queue.py` 生成，包含所执行源码哈希和各项观测。
- `probe-isolation-negative.json`：合成外部 `.env` 导入被拒绝、环境凭据未继承、缺失/重复 AST 定义拒绝及临时目录清理的验证。
- `cleanup.json`：只停止本任务 launcher 70346 及其开发进程，确认均退出、私有控制描述文件删除、现有 Hermes 网关仍运行。测试任务历史保留。

可用明确指定的 Hermes checkout 和已审阅的通知 helper 重跑隔离探针：

```sh
<absolute-python> -I scripts/hermes/probe-delivery-queue.py \
  --source <absolute-hermes-checkout> \
  --notify-bridge <absolute-hermes_notify.py> \
  --output .artifacts/hermes-live/reproducible-queue-contract.json
```

该命令不连接账号、不发送消息。退出码 2 表示投递契约仍存在缺口，不能当作平台收件失败。真实发送依赖本次已经获得的本人聊天测试授权；复现材料不会自动启用发送。

最终隔离探针 exit 2，完整输出七组行为观测和六项契约缺口；合成外部 `.env` 读取以 exit 1 / PermissionError 拒绝且标记未改，缺失/重复 AST 定义同样拒绝。原有 4 项 Python 隔离回归重跑通过。脚本只执行经过快照和哈希核对的源码；真实 Hermes 代码仅在清空凭据环境的 `-I` 子进程、临时 profile 和既有 ProbeIOGuard 内运行，父进程负责退出后的清理。该护栏不作为恶意原生代码沙箱。

下一阶段的主要问题已从“现有连接是否能用”收敛到接口与可靠性：Hermes 需要鉴权后的插件命令上下文、可信确认和 strict 发送回执；CCEM 需要受限令牌、持久操作幂等和输入轮次关联；托管运行时与签名制品仍按原阶段门验证。真实收发通过不解除这些要求，旧入口也未因此自动迁移或删除。
