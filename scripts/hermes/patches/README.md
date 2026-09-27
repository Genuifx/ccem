# Hermes 托管网关契约补丁

`0001-managed-gateway-contracts.patch` 仅适用于 Hermes 基线
`bc1330eebc0aa8a443501b5f62586eb7361353a5`。补丁 SHA-256：
`0caa8b78df6b95a7109ccefa6f00d9018c3f70ac24cb2ee1c76de7af3035cc88`。
在打包源码树中应用；不要对用户正在运行的 Hermes checkout 原地打补丁。

```sh
git apply --check /path/to/0001-managed-gateway-contracts.patch
git apply /path/to/0001-managed-gateway-contracts.patch
```

补丁提供通用 Hermes 接口，没有嵌入 CCEM 业务或新增平台 receiver：

- `PluginContext.register_command(..., with_context=True)`：回调为
  `handler(raw_args, context)`。旧的单参数回调保持兼容。来源在 pre hook
  前保存，实际鉴权后才生成 frozen `TrustedCommandContext`；内部事件不能获得它。
- `gateway.managed_contracts.send_strict(runner, StrictTarget(...), text, timeout=30.0)`：
  使用显式 transport profile 的现有 adapter，单次发送；返回
  `sent / not_sent / unknown`。不另起平台 receiver、不取 home chat、不拆分、不重试。
- `strict_send_supported(platform)` / `STRICT_SEND_PLATFORMS`：能力声明与账号在线状态分开。
  Telegram 限数值 chat/thread ID，线程拒绝不降级。WeCom 限私聊，直接选择唯一新
  req_id 的主动请求；不尝试 passive，群聊明确拒绝。ACK ID 与消息 ID 分开返回。
- Feishu、Discord、Slack 增加私聊顶层消息出口，线程目标在发送前拒绝。三者绕过 SDK
  重试、拆消息和回复降级，使用固定官方 HTTPS 地址、验证 TLS、禁止重定向、10 秒超时、
  64 KiB 回包上限的一次消息 POST；回包必须同时确认原生聊天 ID 和消息 ID。
  Feishu 的 tenant token 只缓存于当前 adapter 内存；Slack 限一个 workspace/token，
  不读独立发送器的多工作区 token 文件。Discord/Slack 沿用已连接 adapter 的显式代理。
- 五个 adapter 的 `await strict_delivery_ready()` 检查实际 SDK 传输，后台任务
  启动不等于在线。Telegram 轮询降级与企微 socket 关闭时也保持未就绪，恢复后才开放配对。Slack、Discord 的 integration-only 原生真人私聊可进入 Desktop nonce
  配对 hook；后续命令仍经过 Gateway 鉴权。群私聊、群聊和合成 interaction 不能配对。
  Slack 使用 `!ccem`，由原有插件命令注册表转换为网关命令。
- `gateway.integration_only=true`：保留鉴权、配对、插件命令和原生诊断命令，禁用模型、
  exec quick commands、cron、自动恢复/重投、后台 agent、MCP 发现及模型预热。

`TrustedCommandContext` 字段为 `platform / profile / transport_profile / user_id /
chat_id / thread_id / source_message_id / chat_type`。`profile` 是路由/鉴权 profile，
发送使用 `transport_profile`。`source_message_id` 可缺失，由消费者拒绝依赖该 ID 的写操作。
`native_source_message_id(event)` 提供相同的来源 ID 提取；WeCom 缺原生 `body.msgid`
时标记 `message_id_is_synthetic=True`，请求 ID 和内部 UUID 不用于配对或写入。
integration-only 入站逐条执行，不经过聊天文本合并，连续命令保留独立内容与 ID。
回执包含 `status / message_id / receipt_id / requested_target / target / error_code`；
未确认实际目标时 `target=None`。WeCom ACK 不含消息 ID 时保持 `message_id=None`，
不会伪造 UUID。`unknown` 必须留待核对，不能自动重发。

完整接口说明随补丁进入 Hermes 的
`website/docs/developer-guide/managed-gateway-contracts.md`。

## 本地验证

已验证补丁可应用到精确基线的独立 Git index，也通过当前源码树的反向 apply check。
测试从隔离 Hermes worktree 的实际源码导入，使用临时 HERMES_HOME。原契约禁止联网，
只替换平台传输边界，本轮重新执行 15 项通过，包括真实插件发现/鉴权、两个主体与聊天、
身份篡改拒绝、内部事件、旧回调、None/空回调无自动第二条、ACK 丢失与线程拒绝，
以及真实 WeCom 入站缺消息 ID、仅请求 ID、连续命令及文本批处理的行为回归。

`scripts/hermes/test-multichannel-contracts.py` 使用私有包的真实 SDK 和 aiohttp，
仅放行测试进程的 loopback HTTP fixture，本轮 22 项全部通过。覆盖单次成功、500、429、
收包前断线、超时取消、重定向拒绝、错误目标/线程/消息 ID、畸形或过大回包、凭据脱敏、
不拆消息、不切 profile、传输 readiness、显式代理、Slack 单账号限制，以及实际 Discord
Message / Slack `!ccem` / Feishu DM 的原生身份与未授权命令拒绝。

```sh
/path/to/private/python/bin/python3.11 -I -B scripts/hermes/test-multichannel-contracts.py \
  --source /path/to/patched/hermes
```

以下是原契约建立时的其他聚焦回归命令；本轮的实际重复执行范围是上述 15 + 22 项。

```sh
scripts/run_tests.sh tests/gateway/test_managed_contracts.py
scripts/run_tests.sh tests/hermes_cli/test_plugins.py tests/gateway/test_slash_access_dispatch.py
scripts/run_tests.sh tests/gateway/test_config.py tests/gateway/test_config_driven_access_policy.py \
  tests/gateway/test_multiplex_profile_authz.py tests/gateway/test_cron_delivery_housekeeping.py
scripts/run_tests.sh tests/gateway/test_pre_gateway_dispatch.py tests/gateway/test_unknown_command.py \
  tests/gateway/test_telegram_send_path_health.py tests/gateway/test_telegram_send_reconnect_wait.py
scripts/run_tests.sh tests/gateway/test_wecom.py -k TestSend
```

上述聚焦回归通过；WeCom 发送测试另有 3 项依赖相关 skip。运行整个 `test_wecom.py`
时，`TestMediaUpload::test_download_remote_bytes_blocks_connect_time_rebind` 在 macOS
系统代理介入后得到 `httpx.ConnectError`，未达到该测试预期的 SSRF 拒绝类型；测试的
`connect_tcp` 替身在联网前终止。该媒体路径未改动，不计为全量测试通过。

这些是本地代码与传输边界证据，不能代替打包、安装、真实账号发收或跨重启幂等验收。
接口也不提供持久 outbox 或 exactly-once 保证。任意已安装的 Python 插件仍是可信代码，
integration-only 模式不是针对恶意插件的系统沙箱。

## 原生对话扩展

`0002-native-managed-conversations.patch` 顺序应用在第一份补丁之后。构建器将两份补丁一起校验和记录。托管 conversation runner 设置 `managed_transport=true`，允许原生 Agent 对话，同时保持平台身份、逐条原生消息、禁用自动恢复/后台服务和严格配送边界。企微与飞书的文本批处理均在进入对话前跳过；同一授权范围的对话由 host 串行处理，确认命令可独立到达。可信消息入口和严格发送回执使用同一网关的单调时钟，短确认必须晚于已送达的冻结预览；同一原生消息的排队或重复投递不会刷新其最早接收时间。Rust 保留拒绝与成功选择的幂等记录。

`test-conversation.py --package <runtime>` 使用私有 Python、真实 Gateway/AIAgent/SDK、仅 loopback 模型服务，覆盖原生对话、工具选择、重启历史和记忆、范围隔离及企微忙时确认。它不代表真实账号收发验收。
