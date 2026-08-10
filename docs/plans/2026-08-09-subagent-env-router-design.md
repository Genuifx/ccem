# Subagent 环境路由(CCEM Router)设计

日期:2026-08-09
状态:**v2.2 token-only 代码、自动化门禁与真实 Desktop 主路径行为验收已收口;official OAuth routed gate=false,待真实已登录会话 E2E**(2026-08-10;Spike B B1-B3、后端/CLI/helper/UI 已落地;requiresOAuth routed transport 保持构建期关闭)
分支:`feat/subagent-env-router`

> 修订记录:
> - v1 初版:bearer token 路由、SDK agents 注入、env 名别名
> - v2:评审一(3 阻断 + 2 高优)——①稳定逻辑键协议;②挂钩点改 PreToolUse `updatedInput`(Spike A 证实 agents 注入=完整替换);③official OAuth 走 URL path 会话键 + Authorization 透传;④权限硬化;⑤代理入口合并 + 渠道范围收缩
> - v2.1:评审二(5 阻断)——①hook 返回结构修正为 `hookSpecificOutput` 嵌套并与 plan guard 合并;②helper 一律注入原始身份标签,绑定解析全部收归 router(消灭双状态);③直连改为纯路由状态(单一传输,即时切换成立,消除别名语义自相矛盾);④目标 model 解析算法独立定义(禁用 `resolveClaudeRuntimeModel`);⑤OAuth 约束改全入口 fail-closed + 透传仅限可信官方源;同轮清理:标题生成表述、headless/tmux 移后续项、双标签优先级、session 状态字段、debug tap 语义、权限迁移 fail-closed
> - v2.2(实现基线):评审三(8 阻断 + 4 高优)——①main 跨环境同样做 source-tier→target-pin 映射;②请求 bounded JSON rewrite、响应 SSE 零缓冲;③OAuth classifier/NO_PROXY/禁 redirect/真实会话 feature gate;④持久路由能力与每 helper generation 启动事实分层;⑤UI、external control、lazy recovery 收归同一 native launch coordinator;⑥nonce 认证 marker + per-session allowed env;⑦动态关闭由 router 强制、删除手写逻辑键 override;⑧缺失环境 fail-closed;同轮冻结单 listener 兼容 legacy ProxyDebug、request-level 热更新语义、IPC DTO/revision/event、运行时故障状态

## 1. 背景与目标

当前 workspace 会话内只能用单一环境(`ANTHROPIC_BASE_URL` + token + model pins)。想换模型必须整会话切环境(软重启 SDK query),无法实现"主会话用官方 Claude、Explore 用 GLM、Plan 用 DeepSeek"这种单会话多供应商协作。

**目标:** 同一 Claude Code 会话内,不同 subagent / 不同用途的请求走不同的 CCEM 环境(不同 base URL + token + model),且:

1. 杂活(Explore 等 subagent、Claude Code 内部小模型 side-query)可走便宜环境 —— 省钱提速
2. 按能力特长分工 —— 指定 subagent 类型绑定指定供应商
3. 分摊额度/限流 —— 不同供应商各自计费
4. 附带红利:会话内切主环境即时生效(只改路由表);router 天然掌握按环境分账的用量数据

**非目标(YAGNI):**

- 不做 OpenAI↔Anthropic 格式转换(DeepSeek/GLM/Kimi 均有 Anthropic 原生兼容端点,只需改 base URL + 鉴权头 + model 名)
- 不做 CCR 式的"智能改写"/transformer 管线
- 裸 `ccem launch --env`(不经 desktop 控制桥)本期不接 router
- **bot(Telegram/Weixin/Wecom)/ cron 渠道本期不接**(评审修订:它们与 native workspace 不共用同一创建路径,"自动覆盖全部渠道"不成立;逐渠道接入列为后续项,见 §8)
- 不做非 Anthropic 兼容供应商的支持

## 2. 可行性依据(调研 + 评审实证)

- Subagent(Task 工具)共享主会话进程,`ANTHROPIC_*` 是进程级——**单进程无法按 subagent 分环境**,唯一通用解法是本地路由代理
- **Spike A 实证(评审完成)**:SDK `AgentDefinition`(`sdk.d.ts:38`)的 `description`/`prompt` 为**必填**,同名注入 = 完整替换内置 agent(本地 Claude 2.1.220 mock 复现),且 `agents` 仅在 query 初始化时下发、运行中无 `setAgents`——**SDK agents 注入不能作为挂钩点**
- **替代挂钩点(类型层已验证)**:SDK `hooks` 选项(`sdk.d.ts:1521`)支持 in-process `PreToolUse`;`PreToolUseHookInput` 携带 `tool_name` + `tool_input`(`sdk.d.ts:2248`);`PreToolUseHookSpecificOutput.updatedInput`(`sdk.d.ts:2255`,外层 `SyncHookJSONOutput` :6839)可改写工具入参——helper 可在 Task 调用前按 `subagent_type` 向 `prompt` 前置路由标签(返回结构范例 `claudePlanGuard.ts:82`)
- Spike B 实证:PreToolUse 改写后的 Task prompt 成为 subagent 请求中独立的 user text block,其前面可能有 Claude Code 注入的 `<system-reminder>` user message;该带标签 block 会在 subagent 后续请求中保留。router 必须扫描 user text blocks 中**第一个精确前缀匹配项**,不能假设它是字面第一条 user message(见 §5.3)
- Model 解析优先级:`CLAUDE_CODE_SUBAGENT_MODEL` 环境变量 > 调用时指定 > agent 定义 model > 主会话模型——CCEM 既有 `subagentModel` 支持(config.rs:631)与 per-type 绑定存在优先级冲突,本设计**不用**它做路由(见 §5.2)
- 按 model 字段/请求内容路由最稳(`x-claude-code-agent-id` 头只宜观测;CCR 的 system 块位置嗅探在版本升级后失效过,issue #1564);**动态标签实际进入 user message 而非 system 块**(评审实证),router 扫描所有 user text blocks 并只接受第一个带正确 nonce 的精确前缀 marker

### CCEM 现状关键落点(实施时直接参考)

- 环境注册表与密钥:`apps/desktop/src-tauri/src/config.rs`(`EnvConfig` :15、`build_claude_env_vars` :609、`resolve_claude_env` :644、`MANAGED_CLAUDE_ENV_KEYS` :311、`clear_managed_claude_env` :637;`CLAUDE_CODE_SUBAGENT_MODEL` :42/:72/:318/:631)
- 会话启动:native workspace 走 `main.rs:1220 create_native_session` → `native_runtime.rs:643 create_session` → helper 进程(`packages/native-runtime-helper`);headless 走 `runtime.rs:1129 build_claude_command`;tmux/terminal 走 `terminal.rs:916` / `tmux.rs:1529`
- helper 侧 env 组装:`claudeEnv.ts buildClaudeQueryEnv` :23;模型解析 `index.ts resolveClaudeRuntimeModel` :548;SDK query 选项 `index.ts buildClaudeQueryOptions` :1481
- 会话内切环境:`main.rs:1417 update_native_session_settings` → helper `applySettingsCommand` :1413
- **既有代理 `ProxyDebug`(main.rs:72)也设置 `ANTHROPIC_BASE_URL`**——与 router 的先后/鉴权/生命周期必须合并,见 §6.4
- 前端:`store/index.ts Environment` :17、`currentEnv` :190;`useTauriCommands.ts`;`WorkspaceNativeSessionView.tsx handleEnvChange` :2415;composer plan mode 三件套 `WorkspaceSessionComposer.tsx`(plan pill :1524、+ 菜单 Switch 行 :562)

## 3. 总体架构

新增 **CCEM Router**:内嵌 Tauri 后端(Rust)的本地 HTTP 代理,随 app 启动。

```
Claude Code SDK query (helper 进程)
  ANTHROPIC_BASE_URL = http://127.0.0.1:<port>/s/<sessionKey>   ← v2:会话键走 URL path
  (不再用 ANTHROPIC_AUTH_TOKEN 做路由键 —— 避免覆盖 official 的 OAuth)
        │ 所有 API 请求(主会话 / subagent / 小模型 side-query)
        ▼
CCEM Router
  1. 按 URL path 的 sessionKey 识别 session → 该 session 的路由表
  2. 解析请求携带的**稳定逻辑键**(v2):
     某个 user text block 以带 session nonce 的内部 marker 开头 → 逻辑键 subagent:Explore
     model == "ccem-route:background"                             → 逻辑键 background
     model 以 ccem: 开头或已认证 marker 携带 ccem:override        → 直接指定 allowed env
     以上均无(main 会话请求)                                     → 逻辑键 main
  3. 用路由表把逻辑键**实时**解析为当前环境(env 名不出现在请求里,
     改绑定即时生效 —— v2 协议的核心修正)
  4. 鉴权:目标环境有 token → 先删除 Authorization/x-api-key/Cookie,再写目标凭证;
     目标环境是 OAuth 型(official)→ **原样透传**客户端 Authorization(见 §3.5)
  5. 请求 bounded collect + JSON 精确重写;响应 header/SSE chunk 流式透传
        ▼
官方 Anthropic(OAuth 透传)/ GLM / DeepSeek / Kimi ...(全部 Anthropic 兼容端点)
```

### 3.1 端口策略(用户已确认)

- **固定端口**,默认 `17820`;启动时被占用则向后嗅探空闲端口(17821…17920),UI 提示实际端口
- 设置页可改端口;**改端口需重启 app 生效**(运行中 session 的 env vars 存的是实际绑定端口,不受影响)
- 仅绑定 `127.0.0.1`

### 3.2 会话键与重启持久化(用户已确认;v2 修订)

- 每 session 创建时生成随机 `sessionKey`(URL bearer)与独立 `routeTagNonce`(body marker 认证),**只存进受保护的 session record**;router 内存路由表在 app 启动时从 session store 重建,session 恢复时惰性重新注册——**无独立 router-state.json**。任何 IPC/CLI/summary/event 都不得返回这两个秘密
- session 恢复(respawn helper)时注入**当前**实际端口 + record 中的 sessionKey/routeTagNonce 重新注册;env vars 是 spawn 时设置的,无陈旧端口问题
- tmux/外挂 session 在 app 重启后:进程持有旧 env;固定端口不变时无缝续上;端口已变时旧进程断流 → UI 判死后走恢复(§3.4)
- route registration 绑定 **helper generation**,不是 turn/session UI 状态:`ready`、`turn_completed`、可恢复 `interrupted` 与 `is_active=false` 都不得注销。仅在 helper 子进程真实退出、handoff、record 删除或 generation 被替换时注销旧 generation;新 generation 必须先注册后 spawn/切换。app 启动重建只跳过不可恢复终态,并补“stop 事件但 helper 尚活”回归
- **权限硬化(v2 新增,评审高优项;v2.2 启动顺序修正)**:sessionKey/nonce 存于 session record,而现场 `~/.ccem` 为 0755、`runtime-state.json`/`native-runtime-state.json` 为 0644(已核实)。要求:`~/.ccem` 目录 0700;明确列出的含键/密文件 0600(不递归破坏可执行文件/目录);原子写临时文件创建时即 0600;CLI `ensureCcemDir()` 同步遵守。启动顺序必须是 **权限迁移 → state load(错误可见,禁 unwrap_or_default)→ router ready → 开放 external control/IPC**。迁移失败则 router 不启动

### 3.3 与现有切环境路径的关系

- `update_native_session_settings` 改主环境 → routed generation 只更新路由表中 `main` 逻辑键目标并按 §4.6 重写 model,**不软重启 SDK query**;direct generation 保留旧软重启路径
- 旧路径(router 未启用/启动失败)保持现有软重启逻辑不变

### 3.4 老会话/死会话恢复(用户已确认)

场景:app 隔夜关闭后 helper 与 router 均已死,用户点开老会话。原则:复用现有 `RuntimeRecoveryCandidate` / `--resume` 生命周期,但所有 respawn 必须先经过统一 coordinator 的 transport/auth/readiness gate。

1. 点击老会话 → 统一 `ClaudeNativeLaunchCoordinator` → 与新会话相同地先做 router readiness/auth gate,再写入本 generation 的 `launchTransport`/`launchAuthKind`/`launchDefaultEnv`,注入当前端口 + record 内 sessionKey/nonce并注册 bindings。不得继续由 UI、external control、lazy recovery 各自组装 env
2. **router 前创建的旧 record 迁移**:恢复时分配 sessionKey、从全局默认 bindings 拷贝快照;router 未启用则保持直连旧行为
3. routed record 恢复时 router 不可用:新 session 可选择 direct fallback;既有 routed record 默认返回 `ROUTER_UNAVAILABLE` 并保持可恢复,不静默改变传输/费用边界。用户显式选择「重启为直连」后才生成 direct helper
4. claude 侧 transcript 丢失等失败场景:维持现有恢复错误处理

### 3.5 official(OAuth)环境的鉴权通道(v2 新增;v2.1 全入口 fail-closed)

问题:official 环境无 API token,靠 Claude Code 自己的 OAuth 登录;v1 把路由 token 写进 `ANTHROPIC_AUTH_TOKEN` 会**覆盖 OAuth 通道**。v2.1 方案:

- 会话标识走 URL path(`/s/<sessionKey>`),**不写 `ANTHROPIC_AUTH_TOKEN`** 做路由键
- 鉴权分两层:持久 `routerAuthCapability` 表示 routed session 能否回到 OAuth(`oauth|token`);每次 helper spawn 重新计算 `launchAuthKind` 与 `launchTransport`。OAuth routed helper 不设 token 占位;token routed helper 只设随机非秘密占位(防 SDK 回落 OAuth 交互,router 转发时重写)
- 唯一 auth classifier:`trim(token) != empty` → token;仅 `name == official` + exact `https://api.anthropic.com` origin + token empty → requiresOAuth;其他空 token → invalid。official 名下配置 API token 时按 token 环境处理,不误判为 OAuth
- **OAuth 透传仅允许指向 requiresOAuth 可信官方源**;禁 redirect,`Authorization` 绝不透传给任何第三方 base URL。真实已登录 dev app 尚未证明 localhost base URL 会携带 OAuth 头,因此该 probe 通过前 requiresOAuth session 保持 direct transport并返回明确 feature-gate warning,不能进入 routed transport。gate 是**后端构建能力常量**,不属于 `RouterConfig`,不接受 config/IPC/CLI 写入;只有真实 E2E 证据评审后才能由代码/发布决策置真
- **fail-closed 统一强制(不止 UI)**:`routerAuthCapability=token` 访问 requiresOAuth 目标是错误——在 **router(请求时)、IPC、CLI、profile 应用、动态 override**五处统一拦截。覆盖 `subagent:*`、`background`、model alias 与动态 override
- helper routed env 必须把 `127.0.0.1,localhost,::1` 合并进 `NO_PROXY`/`no_proxy`,防本地 path key/OAuth 头经过企业代理
- 注意区分:"环境无 token"≠OAuth 型(可能配置缺失);只有 official(可信源)才走透传分支,其他无 token 环境按配置错误处理
- `official` 是 auth classifier 的保留身份:Desktop、CLI、导入、external control 统一禁止 rename/delete;它可配置 API token,但名字与可信 origin 不变量不可被任一写入口破坏

## 4. 路由规则与配置模型

### 4.1 路由表(每 session 一份快照,存于 session record)

```jsonc
{
  "default_env": "official",         // 逻辑键 main 的解析目标
  "allowed_envs": ["official", "glm", "deepseek"], // 该 session 可使用的目标集合
  "bindings": {
    "subagent:Explore": "glm",        // 内置 subagent 类型 → 环境
    "subagent:Plan": "deepseek",
    "subagent:*": "glm",              // 兜底:所有未单列的内置 subagent 类型
    "background": "glm"               // 小模型杂活(Claude Code 内部 side-query,如会话摘要;不含 CCEM App 自身的标题生成——那是独立行为,见评审二清理项)
  }
}
```

### 4.2 协议:稳定逻辑键 + 认证 marker(v2.2)

请求携带的是**逻辑身份**,不是环境名;router 用 session 路由表在**请求时**解析:

| 请求携带 | 逻辑键 | 解析 |
|---|---|---|
| 第一个精确前缀匹配的 user text block 含 `<CCEM-ROUTE nonce="session-nonce">subagent:Explore</CCEM-ROUTE>` | `subagent:Explore` | nonce 必须匹配;查 bindings;未命中查 `subagent:*`;再未命中 → default_env |
| `model == "ccem-route:background"` | `background` | 查 bindings;未命中 → default_env |
| 已认证 marker 携带 `ccem:glm` 或 `model` 以 `ccem:` 开头 | —(直接指定) | `dynamicRouting=true` 且目标 ∈ `allowed_envs` 才使用,否则 403 |
| 以上均无 | `main` | default_env |

- **认证边界**:普通正文中的 raw `<CCEM-ROUTE>` 永远不可信。helper 的 `Agent` hook 用未暴露给模型的 `routeTagNonce` 把 raw `ccem:<env>` override 转成内部 marker;无 override 时注入带 nonce 的 `subagent:<实际类型>`。`subagent_type` 必须拒绝换行、控制字符与 closing-tag 注入
- **动态 alias grammar**:只有名字满足 1..64 ASCII `[A-Za-z0-9._-]` 的环境可作为 `ccem:<env>` model/marker alias;既有不合法名字仍可作为 default/binding 目标,但动态 override 稳定返回 `ROUTER_ENV_ALIAS_INVALID`,UI 不展示 alias且建议用户重命名。禁止百分号解码或大小写折叠
- **删除手写逻辑键 override**:主模型不得手写 `subagent:Explore` 覆盖自动身份;动态改派只保留显式环境 override,消除“自动标签在前导致手写逻辑标签永不生效”的冲突
- **仅默认规则**:router 全局启用时 eligible native session 一律经 router;bindings 为空表示所有逻辑键走 default_env,UI 名称用「仅默认规则」而非「直连」。若 `dynamicRouting=true`,显式 override 仍可在 allowed 集合内生效
- **真正直连传输**只由本 helper generation 的 `launchTransport=direct` 表示:全局关闭、新 session 启动时 router 失败、或用户显式「重启为直连」。运行中不热切换 transport
- 别名/逻辑键命中后 model 按 §4.6 算法重写;`background` 逻辑键载体:helper 将 `ANTHROPIC_SMALL_FAST_MODEL` 设为字面量 `ccem-route:background`
- 未知/未授权 `ccem:` 目标 → 403;binding 指向缺失环境/default_env 缺失 → 502,**禁止静默 fallback**;只有“逻辑键没有 binding”可正常落 default_env

### 4.3 绑定键命名规范与自定义 agent

**`subagent:` 后写 agent 名字本身**——Task 工具 `subagent_type` / agent 列表中的名字,原样字符串匹配。例:`subagent:Explore`、`subagent:superpowers:code-reviewer`(带命名空间,按**第一个冒号**切分)、`subagent:my-reviewer`(用户 `.claude/agents/my-reviewer.md`)。

- **内置花名册**:`packages/core` 常量列表(`Explore` / `Plan` / `general-purpose` / `statusline-setup` 等,Spike 时确认权威清单),用于 UI 下拉与 `subagent:*` 展开;花名册外名字不报错(向前兼容),无对应 agent 时绑定静默不生效
- **自定义 agent 两通道**:(a) 按名字绑定——PreToolUse 钩子按 `subagent_type` 贴身份,**任意合法名字都可绑**;(b) frontmatter 自写 `model: ccem:<env>` 显式别名——仅在 dynamic 开启且目标已获 session 授权时可用
- **生效优先级**:显式 `ccem:` 别名 > `subagent:<精确名>` > `subagent:*` > `default_env`
- **身份采集发生在 helper,匹配发生在 router**:helper 只贴实际 agent 名;exact/wildcard/default 只在 Rust 路由表解析

### 4.4 配置分层、session 状态与外部 DTO(v2.2)

- 全局默认 bindings:`~/.ccem/config.json` 的 `router` 节(`enabled`、`port`、`bindings`、`profiles`、`dynamic_routing`)
- 新 session 创建时拷贝快照进 session record;改全局默认**不影响**运行中 session
- session 设置/L1 入口用 CAS `revision` 改 bindings/allowed/default/dynamic → 下一次 HTTP 请求生效;这也可能让正在运行的 subagent 后续轮切换供应商,UI 必须明确提示
- **session record 的 `router` 子对象(v2.2;秘密字段永不序列化到外部 DTO)**:

```jsonc
{
  "sessionKey": "opaque",
  "routeTagNonce": "opaque",
  "defaultEnv": "official",
  "bindings": { /* 快照 */ },
  "allowedEnvs": ["official", "glm", "deepseek"],
  "sourceProfileId": "budget",      // 来源方案(null=自定义),profile 定义后续变更不回溯
  "profileRevision": 3,             // 应用时的方案修订号,供 UI 显示"已偏离方案"之类状态
  "dynamicRouting": true,
  "revision": 7,
  "routerAuthCapability": "oauth", // 持久能力:oauth|token
  "launchTransport": "routed",     // 每 helper generation 覆盖:routed|direct
  "launchAuthKind": "oauth",       // 每 helper generation 覆盖:oauth|token
  "launchDefaultEnv": "official",  // 本 generation model 来源环境
  "launchModelPins": { /* 本 generation 启动环境的 tier pins 快照,供跨环境推断 */ }
}
```

**冻结的 IPC / external-control DTO**(Rust serde 与 TypeScript 共享 camelCase JSON 形状):

```ts
type RouterStatus = {
  state: 'disabled' | 'starting' | 'ready' | 'degraded' | 'failed';
  requestedPort: number;
  actualPort: number | null;
  error: string | null;
  oauthRoutingEnabled: boolean;
};

type SessionRouterState = {
  launchTransport: 'routed' | 'direct';
  defaultEnv: string;
  bindings: Record<string, string>;
  allowedEnvs: string[];
  sourceProfileId: string | null;
  profileRevision: number | null;
  dynamicRouting: boolean;
  revision: number;
  warnings: string[];
};

type UpdateSessionRouterRequest = {
  runtimeId: string;
  expectedRevision: number;
  patch: Partial<Pick<SessionRouterState,
    'defaultEnv' | 'bindings' | 'allowedEnvs' | 'sourceProfileId' |
    'profileRevision' | 'dynamicRouting'>>;
};
```

- `sessionKey` / `routeTagNonce` 永不出现在 DTO、日志、event 或错误体;`routerAuthCapability` 只在受保护 record 内
- IPC 固定为 `get_router_settings`、`update_router_settings`、`router_status`、`get_session_router`、`update_session_router`，并提供只读 `get_environment_router_references` 给删除前引用预检;external control 复用同一 DTO、引用查询与校验服务
- `update_session_router` 是 CAS:revision 不符返回稳定错误码 `ROUTER_REVISION_CONFLICT` 并带当前**公开** state。patch 必须先应用到副本,再由共享 validator 原子检查 `defaultEnv ∈ allowedEnvs`、每个 binding target 存在且 ∈ allowedEnvs、目标 auth 与 session capability/backend OAuth gate 相容、binding/alias grammar 合法;任一失败不改原 record、不加 revision、不发 event。UI/CLI/profile/main-env 切换全部调用这一服务
- 唯一事件 `native-session-router-updated`:`{ runtimeId, router: SessionRouterState, reason }`;所有入口写成功后都发,前端不得自行拼状态
- 环境 rename/delete 先扫描全局默认、profiles 与 active/recoverable session snapshots:除保留的 `official` 外,rename 原子级联这些引用;delete 若仍被引用则拒绝并返回引用清单。外部手改配置导致引用缺失时,router 请求仍按 502 fail-closed

### 4.5 UI 与交互(plan mode 式动态开关,用户已确认)

交互完全对齐 plan mode 现有模式(`WorkspaceSessionComposer.tsx`):主界面只放最快的开关,完整控制渐进展开。

**L1 即时层——三处入口,同一状态(用户已确认)**

a. **状态条路由 chip**:`WorkspaceStatusStrip` 现有 env chip 旁,Route 图标 + 当前 profile 名(或「仅默认规则」),点击弹方案 Popover(profile 单选列表 + 绑定摘要 + allowed env +「动态改派」开关 +「自定义绑定…」跳 L2)。切换 = CAS `update_session_router` IPC 改路由表;toast 明示“下一次请求生效,活跃 agent 后续轮也可能切换”。红利:router 模式下 env chip 切换也不重启 query(§3.3)

b. **Composer 状态识别**:非「仅默认规则」时 composer shell 顶部显示路由 pill——与 plan pill 同行并列、同款样式 token(`bg-primary/[0.06] text-primary/70` 小胶囊 + Route 图标 + 方案名),**不引入第二种边框色**。点击 pill 打开同一方案 Popover

c. **+ 快捷菜单**:新增「模型路由」行(紧跟 plan 行,同款 Switch 行样式):行尾显示当前方案名,点击行在**同一 Popover 内嵌展开**方案单选列表,顶部规则开关(开 = 最近方案,关 = 仅默认规则;不等于绕过 router)

**L2 Session 设置「模型路由」区(完整控制)**
- per-type 绑定行(内置花名册下拉 + `subagent:*` + `background`),env 下拉;绑定目标自动进入 session allowed env 集合
- 动态路由开关;「存为我的默认」写全局默认 bindings

**L3 默认规则归属:环境管理页(用户已确认)**
- 默认路由规则本质是"环境之间的关系":环境管理页新增「默认路由规则」卡片(默认 bindings 编辑 + 自定义 profile 管理)
- 删除/重命名环境时同页列出全局默认、profile 与 active/recoverable session 引用;删除确认框先查询后端权威引用清单,有引用时禁用最终删除并引导先解除绑定;重命名走后端原子级联(§4.4)
- 全局设置 Router 区只留基础设施:总开关、端口(改动提示需重启)

**Profile(方案)模型**
- 内置只有不依赖用户环境名的「仅默认规则」;「省钱杂活」「特长分工」是参数化模板,首次应用必须由用户选择目标环境后才生成 profile
- 用户自定义存 `config.json router.profiles[]`:`{ id, name, revision, bindings, allowedEnvs }`
- profile 是 bindings 的**命名快照**:切换时展开写入 session 路由表;后续改 profile 定义不影响运行中 session

**空态/降级**
- 全局关闭 router 只影响后续新建/恢复 generation;当前 `launchTransport=routed` 的会话继续显示并使用既有路由,直到用户显式「重启为直连」。当前 `launchTransport=direct` 或尚无 session router state 的入口灰显「直连传输」,tooltip 指路设置页
- router 启动失败 → 新 session chip 警示态 + 已回退直连说明;既有 routed session 显示 blocked 与「重启为直连」显式动作
- i18n 全走 `t()`(zh/en 双 locale);shadcn/ui(Popover/RadioGroup/Switch/Toast);色板走 design token

### 4.6 目标 model 解析算法(v2.2:跨环境 main 同样映射)

**禁止复用 `resolveClaudeRuntimeModel`**——它优先返回 `ANTHROPIC_MODEL`,而第三方环境的该值常是 tier 占位符(如 GLM 配置 `ANTHROPIC_MODEL=opus` + `ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.2`),直接重写会把请求 model 改成裸 `opus` 打废上游。

每个 routed helper generation 持久化 `launchDefaultEnv` 及其完整 model pins。router 对每个请求先从原始 model 推断 source tier,再决定是否映射:

1. `model == ccem-route:background` → tier=`background`
2. 原始 model 与 launch env 某个**非占位** tier pin 相等 → 对应 `opus|sonnet|haiku`(多个相同 pin 时优先请求文本中的 tier 关键词,再按 sonnet→opus→haiku)
3. 否则从原始 model 的独立词段识别 `opus|sonnet|haiku`;识别不到 → `unknown`

| 场景 | 目标 model |
|---|---|
| `background` | E 的 `default_haiku_model` → E 主 pin;均无则 502 `ROUTER_MODEL_UNRESOLVED` |
| target E == `launchDefaultEnv` 且非 background | 原样透传(它是本 generation 已由 Claude Code 解析出的真实 model) |
| target E != `launchDefaultEnv`,tier 已知且 E 有对应**非占位** tier pin | E 的该 tier pin |
| target E != `launchDefaultEnv`,tier unknown | E 主 pin(`default_sonnet_model` → `default_opus_model` → `default_haiku_model` → 非占位 `model`) |
| 跨环境且 E 无兼容 pin | 502 `ROUTER_MODEL_UNRESOLVED`,绝不把 A 的供应商 model 发给 B |

- “非占位”判定:trim 后为空,或小写值严格等于 `opus|sonnet|haiku|default` 时不可作为上游 model;`small_fast_model` 不存在于正式 `EnvConfig`,只使用 `default_haiku_model`
- `official→glm→official` 能成立:launch official 的原始 Claude model 在去 GLM 时映射,切回 launch env 时恢复原样。`glm→official` 只有 official 环境配置了兼容 tier pin 才放行,否则明确 502
- 算法以表格为准写成 router fixture 矩阵,至少覆盖 official→glm、glm→deepseek、glm→official(fail-closed/有 pin 两支)、background、unknown tier 与相同 pins

## 5. Helper 注入机制与兜底(v2 重写)

### 5.1 挂钩点:PreToolUse `updatedInput`(替代 SDK agents 注入;v2.1 修正)

helper 在 `buildClaudeQueryOptions`(:1481,当前 hooks 在 :1518)注册。**两个硬约束(评审实证)**:

- 返回结构必须走 `hookSpecificOutput` 嵌套(`sdk.d.ts:2255` 定义、`SyncHookJSONOutput` :6839 外层;仓库正确范例 `claudePlanGuard.ts:82`)——`hookEventName`/`updatedInput` 放顶层无效
- **与现有 plan-mode hook 合并,不能覆盖**:`buildClaudePlanModeHooks` 已占用 `PreToolUse`,新 hook 追加 matcher 条目

**职责划分(v2.2):helper 只签发身份 marker,不做任何绑定/allowed 解析**——router 模式下每次 `Agent` 调用把 raw 显式 env override 转成 nonce marker,否则注入 `subagent:<实际类型>` marker;exact → wildcard → default、dynamic 开关与授权校验**只发生在 router**。`routeTagNonce` 通过 helper init command 的私有 `router` 字段进入 Node 内存,不得放进 SDK query env,避免 Bash/tool 子进程继承。

```ts
// 伪代码(结构已按评审修正)
const routeHook = async (input) => {
  if (input.tool_name !== 'Agent') return { continue: true };  // matcher 之外的保险
  const ti = asRecord(input.tool_input);
  const type = ti?.subagent_type;
  if (!isSafeRouteSegment(type)) return { continue: true };
  const prompt = typeof ti.prompt === 'string' ? ti.prompt : '';
  const override = takeExactRawEnvOverride(prompt); // 只接受首字符起始的单个完整 tag
  const identity = override?.env ? `ccem:${override.env}` : `subagent:${type}`;
  const rest = override?.rest ?? prompt;             // raw tag 被替换,不会转发上游
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: {
        ...ti,
        prompt: `<CCEM-ROUTE nonce="${routeTagNonce}">${identity}</CCEM-ROUTE>\n${rest}`,
      },
    },
  };
};

hooks: {
  PreToolUse: [
    ...buildClaudePlanModeHooks(isPlanMode).PreToolUse,   // 现有 plan guard,保留
    { matcher: 'Agent', hooks: [routeHook] },              // Spike B 已确认
  ],
}
```

- marker 进入 subagent 独立 user text block(前面可有 system-reminder)→ 该 subagent 后续请求保留。router 扫描 user text blocks,仅接受 nonce 精确匹配的第一个前缀 marker并在转发前剥除;普通 raw tag 留在正文但不参与路由
- helper **不持有** bindings;路由表快照只存于 session record(§4.4)与 router 内存;helper 仅需知道自己处于 router 模式
- `isSafeRouteSegment` 只接受 1..128 个 ASCII 字母、数字、`.`、`_`、`-`、`:`;拒绝换行、控制符、XML closing tag 等注入。匹配内置/插件/自定义 agent,不触碰内置定义
- CCEM 环境配置中的 `subagentModel` 字段(config.rs:631,下发 `CLAUDE_CODE_SUBAGENT_MODEL`)与 router 模式**互斥**:router 模式 session 不下发该 env 键(在 `build_claude_env_vars` 调用侧按模式裁剪),避免最高优先级覆盖一切路由信号

### 5.2 关键决策:不用 `CLAUDE_CODE_SUBAGENT_MODEL` 做路由

该变量优先级最高,会压掉 per-type 绑定与 frontmatter 别名。v2 仅保留一处 model 载体:`background` 逻辑键借 `ANTHROPIC_SMALL_FAST_MODEL=ccem-route:background` 传递(该变量只影响小模型杂活,无冲突)。

### 5.3 实施前置 Spike(核心门已闭环;OAuth 真实透传待 E2E)

- **Spike A(评审已完成 ✅)**:SDK agents 同名注入 = 完整替换内置 agent(`description`/`prompt` 必填,本地 mock 复现)——该挂钩点废弃
- **Spike B(2026-08-10 核心通过)**——harness:`packages/native-runtime-helper/scripts/spike-b.mjs`(本地捕获服务器 + 编排好的假 SSE 上游驱动 Agent/Task 调用,含 plan guard 合并样例和 subagent 二轮工具调用;`node scripts/spike-b.mjs` 运行,产出 `spike-b-report.json`):
  1. **PASS**:PreToolUse `updatedInput` 改写的 `prompt` 原样成为 subagent 的独立 user text block,且强制 subagent 二轮请求后仍保留(2/2 请求命中);Claude Code 可在它前面插入 system-reminder
  2. **PASS**:当前版本 hook 实际 `tool_name=Agent`,输入字段 `subagent_type=Explore`;实现 matcher 使用 `Agent`
  3. **PASS**:`ANTHROPIC_SMALL_FAST_MODEL=ccem-route:background` 原样进入请求 model 字段
  4. **PARTIAL**:dummy token 模式 Authorization 存在;清空 token env 后本机 Claude CLI 在发请求前报 `Not logged in`,未产生 Authorization。真实 official OAuth 透传继续作为 §7 E2E 硬门,不得以本地 harness 代替
- Spike 产出写入"实施记录"节;B1-B3 已放行完整 per-type 协议;B4 只控制 requiresOAuth routed transport feature gate,不阻塞 token-only router 主干

### 5.4 运行时覆盖(v2.1 收缩:native-only)

- **本期仅 native workspace session**(完整支持:PreToolUse 钩子 + background 载体 + 显式别名)
- headless(`build_claude_command`)/ tmux / terminal:**整体移入后续项**(§8 step 11;评审意见:与"native-only"口径一致,不在本期文档内保留半成品承诺)

### 5.5 外部发起渠道(v2 收缩,评审高优项)

ccem skill 发起会话走 `ccem desktop create` → desktop 控制桥。**本期范围:native workspace session(UI 与 `ccem desktop create` 同路径)**;bot(Telegram/Weixin/Wecom)、cron 渠道**不在本期**——它们不共用同一创建路径,需逐渠道接入与验收,列为后续项(§8)。

- `ccem desktop create` 新增可重复参数 `--route "<key>=<env>"` 与 `--routes-json <json>`,种子化 bindings 快照;缺省拷全局默认。`<key>`:`subagent:<名字>` / `subagent:*` / `background`。示例:

  ```bash
  # 主会话走 official;Explore 走 glm;小模型 side-query 走 deepseek
  ccem desktop create --provider claude --cwd /path/to/repo --prompt "开始" \
    --env official --route "subagent:Explore=glm" \
    --route "background=deepseek" --json
  ```

- `ccem desktop routes <runtimeId> --json` 查看;`--set "<key>=<env>"` 运行时改绑定(即时生效);响应 JSON 增加 `routes` 字段
- **边界:** Codex provider 非 Anthropic 协议,`--provider codex` 时忽略 route 参数并提示

### 5.6 主会话可见性与动态路由(v2 修订)

1. **类型枚举是 Claude Code 内建的**(Task 工具描述自动枚举),无需 CCEM 干预
2. ~~description 标注路由信息~~(v2 删除:依赖已废弃的 agents 注入)——路由可见性全部由路由菜单承担
3. **路由菜单 + 动态改派**:Rust 启动协调器按本 generation 的 `allowedEnvs` 生成不含密钥的菜单字符串,通过 helper init command 传入并追加到 SDK query system prompt。只公开显式 env override 语法:`Agent` prompt 首字符可写 `<CCEM-ROUTE>ccem:glm</CCEM-ROUTE>`;不公开/不接受手写 `subagent:*`。`router.dynamic_routing` 默认开,关闭时 helper 不展示菜单且 router 强制拒绝 marker/model alias
4. 菜单是 helper generation 快照:bindings/default 的变更仍在下一 HTTP 请求生效;allowed 集合或 dynamic 开关的收紧立即由 router 强制,扩容后的新 alias 要到下一次 helper restart 才会出现在模型菜单。UI 对这类扩容显示“规则已生效,模型菜单将在重启会话后刷新”

## 6. 错误处理、健壮性与可观测性

### 6.1 请求改写与 SSE 透传健壮性(用户要求"非常健壮",一级目标)

- **请求端必须 bounded collect**:Anthropic JSON endpoint(`/v1/messages`、`/v1/messages/count_tokens`)最多 32 MiB,只接受缺省/`identity` Content-Encoding;超限 413,压缩 body 415,非法 JSON 400。解析、剥 marker、改 model 后重新序列化,因此不承诺请求字节一致
- router 入口只接受 `POST /v1/messages` 与 `POST /v1/messages/count_tokens`(允许 trailing slash);其他 method 返回 405 `ROUTER_METHOD_NOT_ALLOWED`,其他 path 返回 404 `ROUTER_ENDPOINT_NOT_ALLOWED`,且必须在读取/改写 JSON、解析环境或生成目标鉴权头前 fail-closed。禁止把 session URL 变成可代签任意上游 endpoint 的通用代理
- 上游 URL 用结构化 URL join:先移除 `/s/<sessionKey>` 前缀,再把余下 path 追加到环境 base URL 的既有 base path,例如 `/api/anthropic` + `/v1/messages` → `/api/anthropic/v1/messages`;禁止 `..` 穿越,query 原样保留
- **响应转发零缓冲**:收到 upstream chunk 即写 downstream;可选 debug tap 只能旁路采样/有界缓存,关闭 recording 时不得缓存响应正文
- 双向 abort 传播:client 断开 → drop/cancel upstream;upstream 断开 → 终止 downstream;**流中段绝不重试**,首字节前连接失败也不跨 provider自动重试
- Header:移除 hop-by-hop、`Host`、原 `Content-Length`;token 目标先删 `Authorization`/`Proxy-Authorization`/`x-api-key`/`anthropic-api-key`/`Cookie`,再只写 `Authorization: Bearer <token>`;OAuth 目标只向 exact official origin 保留客户端 Authorization。客户端禁自动 redirect,上游 3xx 原样返回
- 连接超时默认 10s;响应流无总超时,60s idle timeout 可配。路由决策采用 user messages 中第一个**nonce 精确匹配且位于 text block 首字符**的 marker;发送上游前必须剥除全部同 nonce 的认证 marker,若后续 marker 指向不同目标则 400 `ROUTER_INVALID_MARKER`;绝不扫描 system/assistant 或正文中间标签

### 6.2 降级与错误语义

- router 启动失败(端口区间全被占等):尚未创建的新 session 可按当前 default env 直连并写 generation facts + UI 警告;既有 routed record 恢复返回 `ROUTER_UNAVAILABLE`,不得静默换传输
- binding/default/显式 override 指向缺失环境或目标 model 无法解析 → 502 稳定错误体 + session warning;未绑定逻辑键才允许落 default
- 目标环境 token 解密失败/为空 → 502;token capability 访问 requiresOAuth → 403;requiresOAuth 在 feature gate 未开或客户端 Authorization 缺失 → 503/401 明确错误
- listener/task 运行中崩溃由 supervisor 优先在**同一端口**重启;失败则 `RouterStatus=degraded`,已有 routed session blocked并提供显式「重启为直连」,不得在活跃 helper 下偷偷改 base URL
- 上游响应(含 3xx/4xx/5xx)状态码、headers 与 body在 hop-by-hop 清理后原样流式透传

### 6.3 可观测性与安全

- 每请求记录:session(脱敏 sessionKey)、命中逻辑键与环境、状态码、耗时;SSE `usage` 事件只读嗅探提取 token 用量(按环境分账的数据基础)
- 本地 `/health` 只返回版本/ready/实际端口,不返回 session 数或键;路由详情只走受控 IPC/external-control DTO,不提供可被 sessionKey 调用的 HTTP `/routes`
- 日志不落密钥;**权限硬化(§3.2):~/.ccem 0700、敏感文件 0600、原子写不放宽、迁移既有文件、回归测试**;仅绑 127.0.0.1

### 6.4 与既有 ProxyDebug 的关系(v2 新增,评审高优项)

本期采用明确的兼容迁移,不再把架构选择留到实现中:

- 单一 listener 同时服务 native `/s/<sessionKey>/...` 与既有 `/proxy/<client>/<routeId>/...`;现有 external terminal/tmux/Codex legacy caller 继续使用返回的 `/proxy` URL,禁止两个 listener 或串联
- `ProxyDebugManager` 的 traffic 类型、脱敏、reduced SSE、分页/留存与 IPC 保留为 recording tap/facade;转发 listener 的生命周期归 `RouterManager`
- listener 在 `router.enabled || debug.enabled || legacy routes 非空` 时运行。关闭 debug 只停止新 recording,不清 native route table,也不切断仍依赖 legacy route 的会话;route 释放后且 router/debug 都关才停 listener
- native routed traffic 在 debug 开时进入同一 tap,关时不写 body/log;RouterStatus 与 ProxyDebugState 分开,但共享 actualPort

## 7. 测试策略

- **Rust 单测**:exact/wildcard/default、nonce spoof、dynamic off、allowed env、missing default/target、session secret 不进 DTO、CAS revision、auth classifier/头清理、URL base-path join、model 映射矩阵、配置迁移、rename/delete 引用、**0600/0700 与 secure atomic write**
- **集成测试**(mock upstream):请求 JSON 改写与 marker 剥除、32 MiB 边界/413、压缩请求/415、query/base path、禁 redirect、SSE chunk 即时透传、慢 chunk、client cancel/upstream RST、多 session 隔离、旧鉴权/Cookie 不泄漏、legacy `/proxy` 回归、debug off 后 native route 仍通
- **恢复矩阵**:prior routed/direct × router ready/fail × oauth/token;UI create 与 external-control create 产出同一 public DTO;lazy `sendInput` 恢复不能绕过 coordinator
- **混沌专项**:用可复现 seed 覆盖随机 chunk 大小 + bounded 随机延迟、中途 RST、并发流与不伪造正常终止;作为显式 ignored 慢测试。30min+/100 流 soak 属发布前稳定性观测,不作为本期 feature merge gate,也不得由 bounded 用例冒充
- **helper 测试**:`Agent` matcher、合法/恶意 `subagent_type`、raw env override→nonce marker、普通正文 raw tag 不签名、plan guard 合并、NO_PROXY 合并、background alias;helper 不测试路由表热更新
- **Spike B 验证脚本**:真实 SDK 抓包核心三项通过;OAuth 真实透传在 Desktop E2E 单独确认(§5.3),结果写入实施记录
- **E2E 自测**:`cd apps/desktop && pnpm tauri:dev`(只目标 `com.ccem.desktop.dev`),建 token session 绑 mock/GLM 环境,触发 Explore 两轮并抓包;改 binding 后下一次 HTTP 请求切换且 helper PID/query generation 不变;真实已登录 official OAuth 会话单独证明 Authorization 到 localhost 并打开 feature gate
- 全量门禁:`pnpm verify`

## 8. 实施步骤(跟做顺序)

0. **Spike B(已完成)**:B1-B3 通过并写实施记录;B4 留真实 OAuth E2E feature gate
1. `packages/core` + Rust 冻结 §4.4 契约:`RouterConfig` / `RouterProfile` / `SessionRouterRecord` / public DTO / error code / 内置 Agent 花名册;built-in profile 只保留「仅默认规则」
2. `config.rs`/CLI 目录工具:router 配置保真归一化、auth classifier、环境引用 rename/delete、secure permissions + atomic writer;先迁移/显式 load state,后开放控制面
3. `router/`(每个新文件 <1000 行):纯路由/marker/model/auth/URL 单测 + `RouterManager`;把现有 ProxyDebug transport 迁为单 listener并兼容 `/proxy` 与 `/s`,禁 redirect,响应流式、debug tap 解耦
4. 抽 `ClaudeNativeLaunchCoordinator`:UI create、external control create、lazy recovery共用;生成 secrets/allowed snapshot/generation facts,router register 先于 spawn,terminal env 与 helper routed env 分离;切主环境 routed 热更新、direct 软重启
5. helper:私有 router init payload、`Agent` route hook、plan guard 合并、background alias、subagent model 裁剪、NO_PROXY、generation 菜单
6. IPC/external control:冻结的 get/update/status DTO、CAS/event、稳定错误码;所有写入口共用 Rust service
7. CLI:`desktop create --route/--routes-json` 与 `desktop routes`;补齐示例现有必填 `--provider/--cwd/--prompt`,JSON stdout 不混 warning
8. DTO 稳定并有 backend contract tests 后,通过 CCEM 创建 **GLM 环境** frontend-only session实现 §4.5,主线程 review/返修/集成
9. focused tests → 独立 backend/frontend review → token-only Desktop 主路径行为验收(已完成)→ `pnpm verify`/`cargo test --locked`;OAuth 真探针通过才打开 requiresOAuth routed gate
10. **后续项(不在本期验收)**:headless / tmux / terminal 新增 native-style per-session router 规则;bot(Telegram/Weixin/Wecom)/cron 逐渠道接入(legacy `/proxy`兼容不等于这些渠道已支持 subagent routing)

## 9. 验收标准

- 单 session 内:主会话走环境 A,Explore subagent 两轮走环境 B(上游抓包证实);改 bindings 后**下一 HTTP 请求**生效且 helper generation 不变
- raw tag 伪造、dynamic off、allowed-env 越权在 router 被拒;sessionKey/nonce 不进入 public DTO/log;token session 不能访问 requiresOAuth
- official(OAuth)主会话 + 第三方 subagent 只有在真实 Desktop OAuth header probe 通过并开启 feature gate 后才算验收;此前 direct official 旧路径仍可用但不得宣称 routed OAuth 完成
- app 重启后运行中 session 路由不丢;端口被占自动嗅探并提示
- 死会话恢复:隔夜点开 routed 记录时 secrets/bindings 自动重建;router 不可用则 blocked而非静默直连;旧 record 透明迁移
- UI 与 `ccem desktop create --route ...` 走同一 coordinator;`ccem desktop routes` 可查/CAS 改且 external DTO 永不含秘密
- `~/.ccem` 0700、含键文件 0600,权限回归测试通过
- router 关闭时新 session 保留直连/软重启旧行为;运行中 router 崩溃显式 degraded并可同端口恢复
- JSON/request 限制、base path、redirect、abort、SSE 流式集成测试通过;debug 关闭不影响 native route;legacy `/proxy` 回归通过

## 实施记录

- 2026-08-09 设计评审:发现 3 阻断(逻辑键协议/agents 注入挂钩点/official OAuth)+ 2 高优(文件权限/代理与渠道范围),文档 v1 → v2 修订
- 2026-08-09 Spike A(评审代做):SDK agents 同名注入 = 完整替换(`sdk.d.ts:38` 必填 description+prompt;本地 Claude 2.1.220 mock 复现)→ 挂钩点废弃,改 PreToolUse `updatedInput`(`sdk.d.ts:1521/2116/2248` 类型层可行)
- 2026-08-09 复核:`~/.ccem` 0755、`runtime-state.json` 等 0644 属实;PreToolUse hooks 类型签名核实
- 2026-08-09 评审二(5 阻断 + 6 清理)→ v2.1:hook 返回结构改 `hookSpecificOutput` 嵌套(对照 `claudePlanGuard.ts:82`)、与 plan guard 合并(index.ts:1518);helper 一律注入原始身份标签、解析收归 router;直连改纯路由状态(单一传输);新增 §4.6 目标 model 算法(禁用 `resolveClaudeRuntimeModel`);OAuth 五入口 fail-closed + 透传限可信官方源;session record `router` 子对象七字段;双标签优先级;debug tap 语义;权限迁移 fail-closed;"标题生成"表述清理(CCEM App 自身行为,不属于 Claude side-query);headless/tmux 移后续项
- 2026-08-10 Spike B 核心放行:修正 harness 将 SDK 自动标题请求误当主请求的编排缺陷;`SPIKE_TOOL_NAME=Agent SPIKE_AUTH_MODE=dummy node scripts/spike-b.mjs` 得到 B1 标签进入 PASS、subagent 二轮保留 2/2、B2 `Agent` + `subagent_type` PASS、B3 background alias PASS、session error=null。额外无 token 探针在本机因 `Not logged in` 未发请求,故 B4 official OAuth 透传不冒充已验证,保留真实会话 E2E 门
- 2026-08-10 评审三 → v2.2:关闭 main model 热切换、request buffering、auth/generation、统一启动入口、marker/allowed-env、dynamic off、环境引用、ProxyDebug 单入口八个阻断;冻结 request-level 热更新、CAS DTO/event、运行中故障、secure startup order。requiresOAuth routed transport 继续由真实已登录 Desktop probe feature-gate,token-only 后端可先实现
- 2026-08-10 token-only 代码实现闭环:
  - Core/config:落地 `RouterConfig` / Profile、配置归一化与迁移、环境引用查询、rename 原子级联、delete 引用拒绝;Desktop 环境 mutation 统一进入进程级协调器与 `config.lock` 事务;敏感状态使用 0700/0600 与安全原子写
  - Router/transport:单 listener 同时承载 `/s/<sessionKey>` 与 legacy `/proxy`;仅放行 `POST /v1/messages`、`POST /v1/messages/count_tokens`,并在读取声明 body 前拒绝错误 method/path/encoding/framing;实现 32 MiB bounded JSON、marker 剥离、allowed/dynamic 校验、跨环境 model pin 映射、目标鉴权重写、禁 redirect、SSE 流式转发、断连取消、端口向后嗅探与 listener supervisor
  - Native runtime/control:新建、external-control create 与 lazy recovery 共用启动协调路径;持久化 capability 与 generation facts;route registration generation-safe;session router 使用 revision CAS 与统一事件;routed 主环境切换即时更新,支持显式重启为直连;helper generation 使用随机 128-bit id,Unix 独立进程组/Windows Job Object 收拢后代,stop/exit/handoff/恢复均按 exact generation 线性化并 finally-style 回收
  - CLI:`ccem desktop create --route/--routes-json`、`ccem desktop routes` 与环境 rename/delete 引用处理已接入 Desktop 权威服务;Desktop 不可达且存在 native state 时 fail-closed;Codex provider 显式 route 参数只给出 stderr warning、不得解析或进入 RPC payload
  - Helper:`Agent` PreToolUse 签发 nonce marker,与 plan guard 合并;支持 background alias、NO_PROXY 合并、router 模式裁剪 `CLAUDE_CODE_SUBAGENT_MODEL`;bindings/allowed 解析只存在于 Rust router
  - Frontend:设置页 Router 基础设施、环境页默认规则/Profile 与引用预检、Workspace route chip/popover/pill/+ 菜单/session 路由编辑已接入;支持把会话草稿存为全局默认、参数化生成「省钱杂活」/「特长分工」Profile;全局配置提交与同 runtime 三条 CAS 入口分别串行化;使用 shadcn RadioGroup/Switch/Dialog、zh/en i18n,并按真实 `launchTransport` 区分 routed/direct/degraded
- 2026-08-11 自动化验证:`pnpm check:all && pnpm verify` 通过;Core 124/124、CLI 207/207、Desktop 454/454、native helper 100/100、Rust 688 passed/3 ignored;helper build、Desktop/Core/CLI build、i18n、文件大小、production audit 与 diff-check 全绿。真实 loopback socket 回归覆盖 `/s` token 鉴权/model/header 重写、SSE 首块实时到达、双 session 隔离、debug-off、legacy `/proxy`、302 不跟随、端口占用后 actualPort 一致、并发 ensure/legacy route 只复用一个受管 listener,以及已注册 session 在 body 前拒绝错误 method/path/encoding/framing;恢复决策矩阵覆盖 new/prior direct/prior routed × router ready/fail × token/OAuth gate。两个显式 ignored bounded chaos 用例覆盖随机 chunk/短延迟、6 路并发及中途 RST,不冒充长时流稳定性验证。测试专用环境 resolver 仅在 test cfg 导出,release 构建不含该 seam。Unix 进程树有真实 descendant/sibling 行为回归;Windows Job Object 有 MSVC target 编译证据,真实 Windows 行为仍由 Windows CI 验收。独立 backend/frontend bar-raiser 最终无 Blocker/High
- 2026-08-10 未关闭硬门:`OAUTH_ROUTING_VERIFIED=false`;requiresOAuth 会话不得进入 routed transport,继续保留 direct/fail-closed 行为。真实 official OAuth Authorization 到 localhost 的 Desktop probe 通过前,不得宣称 OAuth routed 完成或打开构建期 gate
- 2026-08-10 token-only Desktop 主路径行为验收完成:
  - 目标为 `com.ccem.desktop.dev` 的真实 Dev App;Settings「模型路由」显示 `就绪 · 127.0.0.1:17820`
  - 通过 Environments UI 配置默认环境 A、`Explore`→B、allowed A+B、动态路由开启,并从参数化「省钱杂活」模板选择 B 后成功生成方案
  - 通过 Workspace UI 新建 token routed session 后,真实 `/v1/messages` 抓包依次证明 main→A、`Explore` 首轮→B、`Explore` tool-result 后续轮→B;目标 model 分别为 `fixture-a-opus` / `fixture-b-opus`,均存在 `Authorization`,且 `x-api-key` / `Cookie` 不存在
  - 通过会话路由 UI 将 `Explore` 热切到 A 并应用后,下一轮 main 与 `Explore` 均走 A、model 为 `fixture-a-opus`;helper PID 在热切前后均为 `45025`,证明 binding 更新未替换 helper generation
  - nonce 认证 marker 在所有 provider-bound 请求中均未泄漏。主会话请求仍可能包含系统提示公开的 raw `<CCEM-ROUTE>ccem:ENV</CCEM-ROUTE>` 菜单语法,这是预期的模型可见用法说明,不冒充“所有 raw `CCEM-ROUTE` 文本均不存在”
  - 2026-08-11 现场清理完成:测试会话为 `stopped` / `is_active=false`;全局环境恢复为 `kimi-K3`;Router 恢复为 disabled、空 bindings/profiles/allowed;`zz-router-a`/`zz-router-b` 无引用后经真实确认对话删除;Dev App、mock upstream 与测试 helper 均退出,已安装正式版保持运行且未被操作。行为验收与现场清理分别留证
