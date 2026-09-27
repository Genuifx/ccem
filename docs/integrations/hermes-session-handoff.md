# Workspace 会话接管

本地实现日期：2026-09-27。继续既有 `codex/hermes-integration-phase0` 分支；未合入、推送或正式发行。

## 用户路径

Workspace composer 右下角「发送/继续 → 交给机器人」，选择已配对聊天以及已有 API 环境，开始接管。支持托管运行包中已接入的企业微信、飞书、Telegram、Discord、Slack，列表直接来自当前有效配对。输入框旁显示已关联机器人；点开可更新或解除，旧版企微任务卡在对话框次入口。

手动刷新和后台状态更新保留本次打开时尚未提交的机器人、模型选择；失效的配对或 API 环境会显示重新选择提示，不会自动换到新的配对代次。重新打开或切到另一个会话时从已保存状态开始。输入框标记和对话框共用异常状态：机器人离线、模型失败、环境失效、投递失败或送达不明均提示「接管需处理」，恢复后自动更新。同一 API 环境更换具体模型后，也可显式更新接管。

仅授权当前 native runtime，不需要 workspace；既有工作区权限保持独立。桌面仍能发送、查看和继续任务。一个机器人同时接管多个会话时，普通聊天不会猜目标，需用 `/ccem input <runtime> <text>` 指定；只有一个活跃接管会话时，直接回复即可生成输入预览，另一条 `/ccem confirm <challenge>` 才执行。Slack 使用 `!ccem`。

Hermes 用所选 API 环境的具体模型，判断本会话的进展是否值得通知，并生成简短摘要。环境需提供 Anthropic Messages 兼容接口；不读取或复制 Codex/Claude 的 OAuth 登录。通知判断失败会显示异常并稍后重试，不把错误记为静默。

## 行为与权限契约

- CCEM 仍负责执行、配对、授权、确认和投递。独立会话 grant 绑定 runtime、配对 route 和 generation，随机 grant ID 每次重绑更新，不改变 workspace route。
- 重绑、解除会撤销旧 pending challenge、判断和待发通知。发送前再次验证 grant；发送过程中撤销得到 unknown，不自动补发，不声称撤回已在途消息。
- 接管从当前事件游标开始。会话片段按 JSON 字节预算分批，当前输入上下文与游标一起持久化，完成页也能知道正在处理的任务。判断输入含当前会话活跃状态及上一条已送达通知，用于区别一轮输入结束、会话停止和重复通知。
- 通知判断与 native 输入账本使用独立游标。模型失败或重试不阻止确认输入的真实终态落账；完成凭据仍是 provider invocation 与 client message ID。
- 判断和 outbox 在同一事务落库；silent 也是可恢复终态。发送仍复用 Hermes 当前连接，保持严格目标和既有 sent/not_sent/unknown 语义。
- 网关保持 `integration_only`。通知模型在一次性的私有 HOME 中运行真实 Hermes AIAgent，不加载工具、MCP、记忆或用户上下文文件。凭据走 stdin，不进入模型配置文件；每次判断限一轮，不追加总结调用，30 秒进程超时，关闭或取消时回收该子进程。
- 同一会话在该 route 上的旧工作区自动投影被抑制，改由 Hermes 决定通知；其他工作区或其他 route 保留各自的既有授权。

## 构建与自动验证

运行包继续固定 Hermes `bc1330eebc0aa8a443501b5f62586eb7361353a5`，仅从原 `uv.lock` 增加 `anthropic` extra，新增私有通知 worker。使用 Python 3.11.16 与 uv 0.12.12 构建；本地签名测试包 `2026.9.27.1`、sequence 7，不是生产发行。

可重复验证命令：

```sh
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib hermes_bridge
node --test apps/desktop/test/workspace-hermes-handoff-dom.test.mjs apps/desktop/test/cron-hermes-notification-dom.test.mjs apps/desktop/test/hermes-panel-dom.test.mjs
(cd apps/desktop && pnpm exec tsc --noEmit && pnpm exec vite build)
# 使用构建后的私有 Python，PACKAGE 为运行包路径
$PACKAGE/python/bin/python3.11 -I -B scripts/hermes/test-session-advisor.py --package "$PACKAGE"
$PACKAGE/python/bin/python3.11 -I -B scripts/hermes/test-multichannel-contracts.py --source "$PACKAGE/source"
$PACKAGE/python/bin/python3.11 -I -B scripts/hermes/test-runtime-package.py --package "$PACKAGE"
```

本轮回归：Hermes Rust 77/77、Hermes/定时任务/接管 DOM 100/100（接管 12 项）、通知模型 4/4、多渠道 23/23、运行包 5/5、协议渲染 11/11、原生配对来源 4/4；TypeScript、Vite 构建与文件大小检查通过。

真实 AIAgent 与 Anthropic SDK 通过仅允许 loopback 的 HTTP/SSE fixture，验证 notify/silent、严格输出 schema、Bearer 认证、无 `x-api-key` 和工具、无额外模型或元数据请求、取消时回收 worker。多渠道 fixture 还验证普通文本重写后仍必须通过原生身份准入，不可触发未授权 RPC 或模型兜底。

独立只读复审未发现剩余阻断项；提出的 UI 轮询乱序和「首读失败 → 轮询恢复 → 手选 → 刷新」覆盖草稿问题均已修复并补行为测试。

## 本轮桌面与平台证据

规范 launcher 的实例为 `com.ccem.desktop.dev.idedbe6da`，MCP 57700，launcher PID 88534。使用原有隔离 Hermes 状态，没有修改生产运行包、其他开发实例或用户独立 Hermes。

已通过真实开发 App 点击更新运行包、打开 composer 接管对话框、选择已配对企微与 `3891` 环境、开始接管。独立测试目录 `.artifacts/hermes-navigation/session-workspace` 不在原 route 的 workspace 列表中。接管后同一 native runtime 从桌面继续计算任务，原有 route generation 和 workspace 权限没有扩张。

首次真实模型观测：2 次 silent、1 次 notify；接管提示和结果摘要均得到企微 `aibot_send_msg` ACK，outbox 为 sent。这证明模型判断和平台出站回执，不代表客户端可见或用户已读。证据保存在 `.artifacts/hermes-navigation/handoff-live-proof.json` 与相关测试日志。

第二轮真实验证使用最终上下文实现：持久化当前任务「18+25」，模型在完成后推送明确的「18+25=43」摘要，取得企微 ACK；后续完成尾部被判为 silent，没有重复推送。解除接管后同一 runtime 再执行一次测试，原授权的判断数量维持 3、outbox 数量维持 2，没有新通知；重新接管产生新 grant ID，route generation 仍为 3、原 workspace 列表保持不变。最终证据为 `handoff-live-proof-final.json`。

后续交互优化复验使用同 worktree 的新 launcher PID 22933（原 PID 已退出），自动共享后台服务保持关闭。新建独立 Safe 测试会话，只回复测试标记；通过 Tauri 实际点击打开接管、选择模型、刷新，确认加载完成后选择保留且离线机器人不能接管；关闭后重开恢复保存状态。旧版企微入口实际打开「发送到企微」并显示原目标选择器，仅取消，未发送任务卡。证据为 `handoff-ui-recovery-proof.json`。

收尾确认：两轮测试 runtime 的接管记录均为 0；后续 Safe 测试会话已停止并显示 `closed_idle / isActive=false`；仅本任务新启的 launcher 与 MCP 连接被停止。未操作其他开发实例或已安装 App。

Mac 锁屏导致 Computer Use 无法操作企业微信，已请求解锁。真实企微普通回复 → 预览 → 独立确认 → 同一 runtime 继续，以及解锁后的原生画面验收仍待完成；当前不能声称该反向链路已实测通过。其他四个渠道为实际适配器的隔离契约测试，本轮未进行真实账号收发。

## 手机确认消息修复与连接恢复（2026-09-27）

用户手机截图和桥接数据库证明：原生企微消息已进入预览，但复制「两分钟内发送：」和确认指令后，旧 host 将其重写为新聊天输入，产生第二条确认。两条请求均未提交执行；恢复会话时撤销旧 grant，过期确认不会重新执行。

`ccem_gateway_host.py` 现在只对整条确认/取消消息归一化：接受对应提示行、确认码中的空白换行、48 位十六进制确认码；整张预览、多条命令、附加正文、提示与动作冲突均返回格式提示，不生成新任务，也不选择其中一条执行。显式 `input`/`chat` 的任务原文保持不变。过期/失效确认、原会话不可用、已处理的取消分别返回明确反馈。

所有平台的内部重写统一使用网关 `/ccem`，修正 Slack 普通文本的内部调度；Slack 用户可见指令仍使用 `!ccem`。来源鉴权、原生消息 ID、独立二次确认、route/generation/runtime 校验和持久化单次提交继续由原有网关与 Rust 桥接执行。本次为既有协议的解析修复，未引入新的状态机或第三方接口。

聚焦验证：协议/渲染 14 项、真实企微适配器包解析及 host handler 6 项、多渠道契约 23 项、Rust 桥接 77 项、私有运行包 5 项通过。未授权回归实际接入 `hermes_cli.lifecycle.invoke_hook`，断言放在网关异常捕获范围之外；独立审查发现的 Slack 内部前缀和测试接线问题均已修正。新的本地签名运行包为 `2026.9.27.2`、sequence 8。

锁屏恢复使用已有授权的 Codex 执行上下文启动规范 `pnpm tauri:dev`，并将 stdin、输出及进程会话与临时工具命令分离；没有修改 macOS 权限。原 provider 会话成功恢复并真实回复「企微验收会话已恢复，上一轮结果是 43」。新的接管提示已取得企微 ACK。验收实例保留运行，不设置登录/重启自动启动，不将此结果表述为正式版本已发布。

修复后的真实手机「输入 → 复制确认 → 执行 → 通知」仍需实际手机消息完成验证；适配器夹具和出站 ACK 不代替这项证明。
