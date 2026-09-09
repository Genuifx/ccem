# Hermes 托管网关契约补丁

`0001-managed-gateway-contracts.patch` 仅适用于 Hermes 基线
`bc1330eebc0aa8a443501b5f62586eb7361353a5`。补丁 SHA-256：
`5eea41ed92d22eceb5a0dbf2687d178e750e6646d12745fc89aae84488b1446e`。
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
  `sent / not_sent / unknown`。不新建连接、不取 home chat、不拆分、不重试。
- `strict_send_supported(platform)` / `STRICT_SEND_PLATFORMS`：能力声明与账号在线状态分开。
  Telegram 限数值 chat/thread ID，线程拒绝不降级。WeCom 限私聊，直接选择唯一新
  req_id 的主动请求；不尝试 passive，群聊明确拒绝。ACK ID 与消息 ID 分开返回。
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
测试从隔离 Hermes worktree 的实际源码导入，使用临时 HERMES_HOME；新测试禁止联网，
只替换平台传输边界。新契约 15 项通过，包括真实插件发现/鉴权、两个主体与聊天、
身份篡改拒绝、内部事件、旧回调、None/空回调无自动第二条、ACK 丢失与线程拒绝，
以及真实 WeCom 入站缺消息 ID、仅请求 ID、连续命令及文本批处理的行为回归。

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
