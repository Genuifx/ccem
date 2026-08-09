# Subagent 环境路由(CCEM Router)设计

日期:2026-08-09
状态:已评审(方案与标注确认),待实施
分支:`feat/subagent-env-router`

## 1. 背景与目标

当前 workspace 会话内只能用单一环境(`ANTHROPIC_BASE_URL` + token + model pins)。想换模型必须整会话切环境(软重启 SDK query),无法实现"主会话用官方 Claude、Explore 用 GLM、Plan 用 DeepSeek"这种单会话多供应商协作。

**目标:** 同一 Claude Code 会话内,不同 subagent / 不同用途的请求走不同的 CCEM 环境(不同 base URL + token + model),且:

1. 杂活(Explore 等 subagent、标题生成等小模型调用)可走便宜环境 —— 省钱提速
2. 按能力特长分工 —— 指定 subagent 类型绑定指定供应商
3. 分摊额度/限流 —— 不同供应商各自计费
4. 附带红利:会话内切主环境从"软重启 SDK query"变成"改路由表",即时生效;router 天然掌握按环境分账的用量数据

**非目标(YAGNI):**

- 不做 OpenAI↔Anthropic 格式转换(DeepSeek/GLM/Kimi 均有 Anthropic 原生兼容端点,只需改 base URL + 鉴权头 + model 名)
- 不做 CCR 式的"智能改写"/transformer 管线
- 裸 `ccem launch --env`(不经 desktop 控制桥)本期不接 router;经 desktop 桥的发起渠道(UI / ccem skill / bot / cron)全部支持,见 §5.5
- 不做非 Anthropic 兼容供应商的支持

## 2. 可行性依据(调研结论)

- Claude Code 的 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` 是进程级,subagent(Task 工具)共享主会话进程,**单进程无法按 subagent 分环境**——唯一通用解法是本地路由代理
- Subagent 定义的 `model` 字段(frontmatter / SDK `agents` 选项)接受任意字符串并进入 API 请求体的 `model` 字段——这是路由挂钩点(claude-code-router 生态依赖同一机制)
- Model 解析优先级:`CLAUDE_CODE_SUBAGENT_MODEL` 环境变量 > 调用时指定 > agent 定义 model > 主会话模型
- 网上没有可靠的"subagent 名字"结构化元数据(`x-claude-code-agent-id` 头存在但只宜观测不宜路由);CCR 依赖 system 块位置嗅探的做法在版本升级后失效过(issue #1564),**按 model 字段路由最稳**
- CCR 的兜底机制:在 agent prompt 开头放 `<CCR-SUBAGENT-MODEL>` 标签,代理识别后剥除并路由——本设计借鉴为双信号兜底

### CCEM 现状关键落点(实施时直接参考)

- 环境注册表与密钥:`apps/desktop/src-tauri/src/config.rs`(`EnvConfig` :15、`build_claude_env_vars` :609、`resolve_claude_env` :644、`MANAGED_CLAUDE_ENV_KEYS` :311、`clear_managed_claude_env` :637)
- 会话启动:native workspace 走 `main.rs:1220 create_native_session` → `native_runtime.rs:643 create_session` → helper 进程(`packages/native-runtime-helper`);headless 走 `runtime.rs:1129 build_claude_command`;tmux/terminal 走 `terminal.rs:916` / `tmux.rs:1529`
- helper 侧 env 组装:`packages/native-runtime-helper/src/claudeEnv.ts buildClaudeQueryEnv` :23;模型解析 `index.ts resolveClaudeRuntimeModel` :548;SDK query 选项 `index.ts buildClaudeQueryOptions` :1481
- 会话内切环境:`main.rs:1417 update_native_session_settings` → helper `applySettingsCommand` :1413(空闲时软重启 query)
- CCEM 已有 `CLAUDE_CODE_SUBAGENT_MODEL` 支持(单模型、同供应商),不写 `.claude/agents/*.md`
- 前端:`store/index.ts Environment` :17、`currentEnv` :190;`useTauriCommands.ts`;`WorkspaceNativeSessionView.tsx handleEnvChange` :2415

## 3. 总体架构

新增 **CCEM Router**:内嵌 Tauri 后端(Rust)的本地 HTTP 代理,随 app 启动。

```
Claude Code SDK query (helper 进程)
  ANTHROPIC_BASE_URL = http://127.0.0.1:<port>
  ANTHROPIC_AUTH_TOKEN = <每 session 随机 token>
        │ 所有 API 请求(主会话 / subagent / 标题生成)
        ▼
CCEM Router
  1. 按 token 识别 session → 该 session 的路由表
  2. 按请求体 model 字段匹配:
     "ccem:<envName>" → 转发到对应环境
     其他             → 默认路由(session 主环境),model 原样不动
  3. 重写:Host/base URL、鉴权头、(仅别名命中时)model 字段
  4. 其余全部字节级透传(anthropic-beta 头、计费头、SSE 流)
        ▼
官方 Anthropic / GLM / DeepSeek / Kimi ...(全部 Anthropic 兼容端点)
```

### 3.1 端口策略(用户已确认)

- **固定端口**,默认 `17820`;启动时被占用则向后嗅探空闲端口(17821…17920),UI 提示实际端口
- 设置页可改端口;**改端口需重启 app 生效**(运行中 session 的 env vars 存的是实际绑定端口,不受影响)
- 仅绑定 `127.0.0.1`

### 3.2 Token 与重启持久化(用户已确认;2026-08-09 修订)

- 每 session 创建时生成随机 token,**既是鉴权也是路由表 key**,多 session 并发互不串台
- **token 与 bindings 快照直接存进 session record**(native record / runtime state entry);router 不单独持有会话状态——**不设 router-state.json**,内存路由表在 app 启动时从 session store 重建,session 恢复时惰性重新注册
- session 恢复(respawn helper)时:注入**当前**实际端口 + record 中的 token 重新注册。env vars 是 spawn 时设置的,不存在陈旧端口问题
- tmux/外挂 session 在 app 重启后:进程持有的是旧 env;固定端口不变时无缝续上;若端口已变(被占嗅探/用户改设置),旧进程下次 API 调用失败 → UI 判死后走恢复流程(同窗口 respawn + `--resume`),见 §3.4
- session 结束时从路由表注销 token;app 启动重建时跳过已终结 session 的 record

### 3.3 与现有切环境路径的关系

- `update_native_session_settings` 改主环境 → 改为只更新 router 路由表的 `default_env`,**不再软重启 SDK query**(model pins 变化由 router 转发层保证;env vars 中的 pin 仅影响请求 model 名,router 默认路由原样转发,行为兼容)
- 旧路径(router 未启用/启动失败)保持现有软重启逻辑不变

### 3.4 老会话/死会话恢复(用户已确认)

场景:app 隔夜关闭后 helper 进程与 router 均已死,用户在 workspace 点开老会话。设计原则:**router 不引入新的会话生命周期状态,完全复用现有恢复路径**(`RuntimeRecoveryCandidate` / RecoveryCandidatesPanel / `--resume`)。

1. 点击老会话 → 走现有 respawn 路径(重拉 helper + `--resume <claude_session_id>`)→ **与新会话完全相同的注入逻辑**:当前端口 + record 内 token 重新注册 + bindings 快照生效。无任何陈旧状态
2. **router 前创建的旧 record 迁移**(无 token/bindings 字段):恢复时透明迁移——分配 token、从全局默认 bindings 拷贝快照、按 router 模式注入;router 未启用则保持直连旧行为
3. 端口已变导致外挂 tmux 进程断流:UI 判死后提示恢复,respawn 即愈合
4. claude 侧 transcript/jsonl 已丢失等失败场景:维持现有恢复错误处理,router 不改变其语义

## 4. 路由规则与配置模型

### 4.1 路由表(每 session 一份快照,存于 session record)

```jsonc
{
  "default_env": "official",         // 复用现有 envName 语义
  "bindings": {
    "subagent:Explore": "glm",        // 内置 subagent 类型 → 环境
    "subagent:Plan": "deepseek",
    "subagent:*": "glm",              // 兜底:所有未单列的内置 subagent 类型
    "background": "glm"               // 小模型杂活(标题生成/压缩等)
  }
}
```

### 4.2 Router 匹配逻辑(刻意简单)

1. 请求 `model` 以 `ccem:` 开头 → 按别名查环境注册表 → 转发到该环境,model 重写为目标环境的 resolved runtime model(复用 `resolveClaudeRuntimeModel` 优先级:runtimeModel → opus pin → sonnet pin → haiku pin)
2. 其他所有 model → 走 `default_env`,**model 原样不动**(环境的 model pins 已在请求里解析好,router 不重新发明 tier 映射)
3. 未知 `ccem:` 别名 → 400 明确错误(不静默走默认)

### 4.3 自定义 agent 免配置

用户在自己项目的 `.claude/agents/*.md` frontmatter 手写 `model: ccem:<envName>` 即刻生效;router 认所有 `ccem:<envName>` 模式,不限于 UI 配置行。

### 4.4 配置分层

- 全局默认 bindings:`~/.ccem/config.json` 新增 `router` 节(`enabled`、`port`、`bindings`)
- 新 session 创建时拷贝快照进 session record;改全局默认**不影响**运行中 session
- session 设置面板改 bindings → 只改路由表,即时生效,不碰 SDK query

### 4.5 UI

- session 设置新增「模型路由」区:每个内置 subagent 类型一行 env 下拉 + `subagent:*` 兜底行 + background 行
- 全局设置页新增「Router」区:开关、端口、全局默认 bindings
- workspace 状态条加 router 存活徽标(含实际端口)
- i18n:全部走 `t()`,zh 默认;图标 Hugeicons;组件 shadcn/ui

## 5. Helper 注入机制与兜底

### 5.1 绑定生效机制

`buildClaudeQueryOptions`(`packages/native-runtime-helper/src/index.ts:1481`)新增 SDK `agents` 选项注入:对路由表每个绑定注入同名 agent 定义并带 `model: "ccem:<env>"`。**双信号常驻**:同时在被注入 agent 的 prompt 开头加 `<CCEM-ROUTE><envName></CCEM-ROUTE>` 标签(router 识别后精确剥除该前缀标签再转发)。

### 5.2 关键决策:不用 `CLAUDE_CODE_SUBAGENT_MODEL` 环境变量

该环境变量优先级最高,会压掉所有 per-type 绑定。因此统一走 agents 注入;`subagent:*` 兜底 = 展开为"所有未单独绑定的已知内置类型"(Explore / Plan / general-purpose 等花名册,定义为常量列表)。代价:用户自建 agent 不被兜底覆盖(可自写 `ccem:` 别名),语义干净可预测。

### 5.3 实施前置 Spike(写正式代码前第一件事,结果决定注入策略)

1. SDK `agents` 选项能否**同名覆盖**内置 agent(Explore 等)?
2. 覆盖是**只改 model 其余继承**,还是必须完整重定义 prompt?若必须完整重定义(内置 prompt 无法复刻)→ 降级:per-type 绑定退化为仅 catch-all + 自定义 agent 别名,UI 明示
3. 任意字符串 model 是否原样进入 API 请求体(方案地基)?若不透传 → 走标签路由(已内置双信号,无额外成本)

Spike 产出写入本文件"实施记录"节。

### 5.4 运行时覆盖

- native workspace session:完整注入(agents + 标签)
- headless(`build_claude_command`):经 `--agents` 参数注入同等定义
- tmux/terminal 交互式:无法注入,仅支持自定义 agent 自写别名;UI 标注该限制

### 5.5 外部发起渠道(ccem skill / bot / cron,用户已确认)

ccem skill 发起会话走 `ccem desktop create` → desktop 控制桥 → **与 UI 创建完全相同的 desktop 后端路径**,因此 router 模式自动继承,覆盖全部 `ManagedSessionSource`(Desktop / Telegram / Weixin / Wecom / Cron)。需要新增的只是创建参数透传:

- `ccem desktop create` 新增可重复参数 `--route "<key>=<env>"`(如 `--route "subagent:Explore=glm" --route "background=deepseek"`)与 `--routes-json <json>`,种子化该 session 的 bindings 快照;缺省拷全局默认
- `ccem desktop routes <runtimeId> --json` 查看;`ccem desktop routes <runtimeId> --set "<key>=<env>"` 运行时改绑定(走"只改路由表"路径,即时生效)
- 响应 JSON 增加 `routes` 字段,便于 skill 回报状态

**边界:** Codex provider 非 Anthropic 协议,router 不适用,`--provider codex` 时忽略 route 参数并提示;裸 `ccem launch --env`(不经 desktop 桥)本期不接 router(该路径无常驻进程托管 router,且 skill 不使用它),文档注明。

## 6. 错误处理、健壮性与可观测性

### 6.1 SSE 透传健壮性(用户要求"非常健壮",一级目标)

- hyper/axum 流式 body 端到端 chunk 透传,**应用层零缓冲**(不 collect)
- 双向 abort 传播:client 断开 → cancel upstream;upstream 断开 → 终止 downstream;半开连接依赖 tokio drop 传播清理
- **流中段绝不重试**;首字节前的连接失败也不跨 provider 自动重试(避免语义错乱),原样返回错误
- Header 策略:默认全透传;仅重写 auth 头(目标 env token);`Host`/`Content-Length` 由 hyper 重算;不解压、不动 `Content-Encoding`
- 连接超时(默认 10s,可配);流式读不设总超时,可选 idle timeout
- 标签剥除仅限 system 块文本的精确前缀匹配,绝不误伤正文

### 6.2 降级与错误语义

- router 启动失败(端口全被占等)→ session 启动回退直连环境(不经过 router)+ UI 警告;旧行为完全保留
- 绑定指向已删除环境 → 回退 `default_env` + UI 警告 + 日志
- 目标环境 token 解密失败 → 502 + 明确错误体
- 上游错误:状态码与错误体原样透传

### 6.3 可观测性与安全

- 每请求记录:session(脱敏 token)、命中环境、model 原值/改写值、状态码、耗时;SSE `usage` 事件只读嗅探提取 token 用量(不改写字节),作为按环境分账的数据基础
- 本地端点 `/health`、`/routes`(token 鉴权)
- 日志不落密钥;token 仅存于 session record(与现有敏感字段同等保护);仅绑 127.0.0.1

## 7. 测试策略

- **Rust 单测**:路由匹配(别名/默认/未知别名/删除环境回退)、model 重写优先级、token→session 解析、标签精确剥除、配置迁移(无 router 节旧配置)
- **集成测试**(mock upstream):SSE 字节逐段一致、慢 chunk/乱序 chunk、client 中途断开传播、upstream 中途断开、大 body、并发多 session 路由隔离、auth 头重写正确且不漏旧 token
- **混沌专项**(对应"非常健壮"):随机 chunk 大小 + 随机延迟、中途 RST、30min+ 长流(心跳)、并发 100 流
- **helper 测试**:agents 注入内容正确(双信号齐全)、env 组装指向 router、`resolveClaudeRuntimeModel` 复用一致
- **E2E 自测**:`cd apps/desktop && pnpm tauri:dev`(遵守 Desktop Self-Test Lockfile Rule,目标 `com.ccem.desktop.dev`),建 session 绑定便宜环境,触发 Explore subagent,断言请求落到目标上游;验证改 bindings 即时生效不重启 query
- 全量门禁:`pnpm verify`(test + build + cargo test)

## 8. 实施步骤(跟做顺序)

0. **Spike 三问**(§5.3),产出写入下方实施记录
1. `packages/core`:`RouterConfig` / `SessionRouteTable` / `SubagentBinding` 类型 + 内置 subagent 花名册常量
2. `src-tauri/src/router.rs`(新模块,<1000 行;超出则拆 `router/` 目录):代理服务、内存路由表(从 session store 重建 + 注册/注销 API)、`/health`、`/routes`
3. `config.rs`:`router` 配置节(开关/端口/全局默认 bindings)+ 端口嗅探;session record 增加 `router_token` + `bindings` 快照字段(旧 record 缺省即 legacy,恢复时迁移,见 §3.4)
4. 启动路径接入:`create_native_session`(main.rs:1220)、`build_claude_command`(runtime.rs:1129)、tmux/terminal(仅 router URL + token,无注入);恢复路径走同一注入(§3.4)
5. helper:`buildClaudeQueryOptions` 注入 agents(双信号)、`buildClaudeQueryEnv` 指向 router
6. IPC:`get_router_settings` / `update_router_settings` / `update_session_bindings` / `router_status`
7. CLI wrapper:`ccem desktop create --route/--routes-json`、`ccem desktop routes`(§5.5)
8. UI:设置页 Router 区、session 设置「模型路由」区、状态条徽标(shadcn/ui + Hugeicons + `t()`)
9. 切主环境路径改为改路由表(§3.3),保留 router 关闭时的旧软重启
10. 测试(§7)+ `pnpm verify`

## 9. 验收标准

- 单 session 内:主会话走环境 A,Explore subagent 走环境 B(上游抓包/日志证实),改 bindings 即时生效
- app 重启后运行中 session 路由不丢;端口被占自动嗅探并提示
- **死会话恢复**:app 隔夜关闭后在 workspace 点开老会话,恢复后路由(bindings + token)自动重建生效;router 前创建的旧 record 恢复时透明迁移
- **外部发起**:`ccem desktop create --route "subagent:Explore=<env>"` 创建的 session 绑定生效;`ccem desktop routes` 可查可改
- router 关闭/启动失败时所有旧行为不变(直连、软重启切环境)
- 流式转发通过混沌专项;密钥不出现在任何日志与配置文件明文外泄面

## 实施记录

(实施时填写:spike 结论、偏差决策、验证证据)
