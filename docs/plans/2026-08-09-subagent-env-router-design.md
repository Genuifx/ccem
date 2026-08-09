# Subagent 环境路由(CCEM Router)设计

日期:2026-08-09
状态:**协议修订 / Spike 中**(2026-08-09 两轮评审,协议已修订至 v2.1;Spike B 抓包闭环前不放行实现)
分支:`feat/subagent-env-router`

> 修订记录:
> - v1 初版:bearer token 路由、SDK agents 注入、env 名别名
> - v2:评审一(3 阻断 + 2 高优)——①稳定逻辑键协议;②挂钩点改 PreToolUse `updatedInput`(Spike A 证实 agents 注入=完整替换);③official OAuth 走 URL path 会话键 + Authorization 透传;④权限硬化;⑤代理入口合并 + 渠道范围收缩
> - v2.1(当前):评审二(5 阻断)——①hook 返回结构修正为 `hookSpecificOutput` 嵌套并与 plan guard 合并;②helper 一律注入原始身份标签,绑定解析全部收归 router(消灭双状态);③直连改为纯路由状态(单一传输,即时切换成立,消除别名语义自相矛盾);④目标 model 解析算法独立定义(禁用 `resolveClaudeRuntimeModel`);⑤OAuth 约束改全入口 fail-closed + 透传仅限可信官方源;同轮清理:标题生成表述、headless/tmux 移后续项、双标签优先级、session 状态字段、debug tap 语义、权限迁移 fail-closed

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
- Subagent 的任务 prompt 是其首条 user message,应出现在该 subagent 后续每次 API 请求体中——router 可从中识别标签(**待 Spike B 抓包证实**,见 §5.3)
- Model 解析优先级:`CLAUDE_CODE_SUBAGENT_MODEL` 环境变量 > 调用时指定 > agent 定义 model > 主会话模型——CCEM 既有 `subagentModel` 支持(config.rs:631)与 per-type 绑定存在优先级冲突,本设计**不用**它做路由(见 §5.2)
- 按 model 字段/请求内容路由最稳(`x-claude-code-agent-id` 头只宜观测;CCR 的 system 块位置嗅探在版本升级后失效过,issue #1564);**动态标签实际进入 user message 而非 system 块**(评审实证),router 扫描首条 user message 的 text block 精确前缀

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
     首条 user message 含 <CCEM-ROUTE>subagent:Explore</CCEM-ROUTE> → 逻辑键 subagent:Explore
     model == "ccem-route:background"                             → 逻辑键 background
     model 以 ccem: 开头(显式环境别名,用户自写)                  → 直接指定环境
     以上均无(main 会话请求)                                     → 逻辑键 main
  3. 用路由表把逻辑键**实时**解析为当前环境(env 名不出现在请求里,
     改绑定即时生效 —— v2 协议的核心修正)
  4. 鉴权:目标环境有 token → 重写 Authorization/x-api-key;
     目标环境是 OAuth 型(official)→ **原样透传**客户端 Authorization(见 §3.5)
  5. 标签精确剥除;其余全部字节级透传(anthropic-beta 头、计费头、SSE 流)
        ▼
官方 Anthropic(OAuth 透传)/ GLM / DeepSeek / Kimi ...(全部 Anthropic 兼容端点)
```

### 3.1 端口策略(用户已确认)

- **固定端口**,默认 `17820`;启动时被占用则向后嗅探空闲端口(17821…17920),UI 提示实际端口
- 设置页可改端口;**改端口需重启 app 生效**(运行中 session 的 env vars 存的是实际绑定端口,不受影响)
- 仅绑定 `127.0.0.1`

### 3.2 会话键与重启持久化(用户已确认;v2 修订)

- 每 session 创建时生成随机 `sessionKey`(opaque,仅作路由表 key),**存进 session record**;router 内存路由表在 app 启动时从 session store 重建,session 恢复时惰性重新注册——**无独立 router-state.json**
- session 恢复(respawn helper)时注入**当前**实际端口 + record 中的 sessionKey 重新注册;env vars 是 spawn 时设置的,无陈旧端口问题
- tmux/外挂 session 在 app 重启后:进程持有旧 env;固定端口不变时无缝续上;端口已变时旧进程断流 → UI 判死后走恢复(§3.4)
- session 结束注销;app 启动重建时跳过已终结 session
- **权限硬化(v2 新增,评审高优项;v2.1 fail-closed)**:sessionKey 存于 session record,而现场 `~/.ccem` 为 0755、`runtime-state.json`/`native-runtime-state.json` 为 0644(已核实)——本机其他账号可读键并盗用路由。要求:`~/.ccem` 目录 0700;含键/密文件 0600(含既有文件迁移);原子写入不得放宽权限;补权限回归测试(§7)。**迁移 fail-closed:必须在 router 重建路由表之前完成;迁移失败则 router 不启动**(session 按启动失败回退直连,§6.2)

### 3.3 与现有切环境路径的关系

- `update_native_session_settings` 改主环境 → 只更新路由表中 `main` 逻辑键的解析目标,**不再软重启 SDK query**(v2 协议下这真正成立:请求里只有逻辑键,解析在 router 实时完成)
- 旧路径(router 未启用/启动失败)保持现有软重启逻辑不变

### 3.4 老会话/死会话恢复(用户已确认)

场景:app 隔夜关闭后 helper 与 router 均已死,用户点开老会话。原则:**router 不引入新的会话生命周期状态,完全复用现有恢复路径**(`RuntimeRecoveryCandidate` / `--resume`)。

1. 点击老会话 → 现有 respawn 路径 → 与新会话完全相同的注入:当前端口 + record 内 sessionKey 重新注册 + bindings 快照生效。无陈旧状态
2. **router 前创建的旧 record 迁移**:恢复时分配 sessionKey、从全局默认 bindings 拷贝快照;router 未启用则保持直连旧行为
3. claude 侧 transcript 丢失等失败场景:维持现有恢复错误处理

### 3.5 official(OAuth)环境的鉴权通道(v2 新增;v2.1 全入口 fail-closed)

问题:official 环境无 API token,靠 Claude Code 自己的 OAuth 登录;v1 把路由 token 写进 `ANTHROPIC_AUTH_TOKEN` 会**覆盖 OAuth 通道**。v2.1 方案:

- 会话标识走 URL path(`/s/<sessionKey>`),**不写 `ANTHROPIC_AUTH_TOKEN`** 做路由键
- **session 启动时持久化不可变 `authKind`(oauth|token)到 session record**(§4.4)——OAuth 主环境的 session 以 OAuth 模式启动(helper 不设 token 占位);token 主环境的 session 设占位 token(防 SDK 回落 OAuth 交互,router 转发时重写)
- **OAuth 透传仅允许指向可信官方源**:目标环境必须是 official(`OFFICIAL_ENV_NAME`,config.rs:103)且 base URL 为官方 Anthropic origin——`Authorization` 绝不透传给任何第三方 base URL(防 OAuth bearer 泄露)
- **fail-closed 统一强制(不止 UI)**:token 启动的 session 把任何逻辑键路由到 official 都是错误——在 **router(请求时)、IPC、CLI、profile 应用、动态标签**五处统一拦截,返回/提示明确错误(401 避免不了,不如 403 前置)。覆盖路径包括 `subagent:Explore=official`、`background=official`、显式 `ccem:official`、动态改派标签
- 注意区分:"环境无 token"≠OAuth 型(可能配置缺失);只有 official(可信源)才走透传分支,其他无 token 环境按配置错误处理

## 4. 路由规则与配置模型

### 4.1 路由表(每 session 一份快照,存于 session record)

```jsonc
{
  "default_env": "official",         // 逻辑键 main 的解析目标
  "bindings": {
    "subagent:Explore": "glm",        // 内置 subagent 类型 → 环境
    "subagent:Plan": "deepseek",
    "subagent:*": "glm",              // 兜底:所有未单列的内置 subagent 类型
    "background": "glm"               // 小模型杂活(Claude Code 内部 side-query,如会话摘要;不含 CCEM App 自身的标题生成——那是独立行为,见评审二清理项)
  }
}
```

### 4.2 协议:稳定逻辑键(v2 核心修订;v2.1 修正直连语义与双标签优先级)

请求携带的是**逻辑身份**,不是环境名;router 用 session 路由表在**请求时**解析:

| 请求携带 | 逻辑键 | 解析 |
|---|---|---|
| 首条 user message 含 `<CCEM-ROUTE>subagent:Explore</CCEM-ROUTE>` | `subagent:Explore` | 查 bindings;未命中查 `subagent:*`;再未命中 → default_env |
| `model == "ccem-route:background"` | `background` | 查 bindings;未命中 → default_env |
| `<CCEM-ROUTE>ccem:glm</CCEM-ROUTE>` 或 `model` 以 `ccem:` 开头(显式环境别名) | —(直接指定) | 直接使用该环境,**router 模式下永远生效**(用户自写的显式意图) |
| 以上均无 | `main` | default_env |

- **双标签优先级(v2.1 新增)**:自动 hook 在 Task prompt 最前面插入类型标签,主模型动态改派的显式环境标签紧随其后——router 扫描首条 user message 的**全部** CCEM-ROUTE 标签,**显式 `ccem:<env>` 标签优先于逻辑键标签**,同类取第一个。hook 侧加码:prompt 已以显式环境标签开头时跳过注入
- **单一传输 + 直连的新语义(v2.1 修正,消除"即时开关 vs 进程级 base URL"矛盾)**:router 全局启用时,**所有 session 一律经 router 传输**;「直连」只是一种 bindings 为空的**路由状态**(所有逻辑键 → default_env),三处 UI 切换 = 改路由表,即时生效,**不需要重建 query**。显式 `ccem:` 别名在直连状态下依然生效(传输仍过 router)——"别名永远生效"与"直连"不再冲突
- **真正绕过 router 的直连传输只发生在两处启动时刻**:router 全局关闭;router 启动失败回退。此类 session 在 record 标记 `directLaunched: true`(不可变),运行中不能改走 router(那才需要重建 query,不做)
- 别名/逻辑键命中后 model 按 §4.6 算法重写;`background` 逻辑键载体:helper 将 `ANTHROPIC_SMALL_FAST_MODEL` 设为字面量 `ccem-route:background`
- 未知 `ccem:` 环境名 → 400 明确错误;未知逻辑键按上表兜底规则解析,不报错

### 4.3 绑定键命名规范与自定义 agent

**`subagent:` 后写 agent 名字本身**——Task 工具 `subagent_type` / agent 列表中的名字,原样字符串匹配。例:`subagent:Explore`、`subagent:superpowers:code-reviewer`(带命名空间,按**第一个冒号**切分)、`subagent:my-reviewer`(用户 `.claude/agents/my-reviewer.md`)。

- **内置花名册**:`packages/core` 常量列表(`Explore` / `Plan` / `general-purpose` / `statusline-setup` 等,Spike 时确认权威清单),用于 UI 下拉与 `subagent:*` 展开;花名册外名字不报错(向前兼容),无对应 agent 时绑定静默不生效
- **自定义 agent 两通道**:(a) 按名字绑定——v2 挂钩点是 PreToolUse 钩子按 `subagent_type` 匹配,**任意名字都可绑**(不再受 SDK agents 注入的完整替换限制);(b) frontmatter 自写 `model: ccem:<env>` 显式别名——永远可用
- **生效优先级**:显式 `ccem:` 别名 > `subagent:<精确名>` > `subagent:*` > `default_env`
- **匹配发生在注入层**(helper 的 PreToolUse 钩子),router 只解析逻辑键/别名、不知 agent 名字——免疫 Claude Code 版本摆动

### 4.4 配置分层与 session 状态(v2.1 补状态字段)

- 全局默认 bindings:`~/.ccem/config.json` 的 `router` 节(`enabled`、`port`、`bindings`、`profiles`、`dynamic_routing`)
- 新 session 创建时拷贝快照进 session record;改全局默认**不影响**运行中 session
- session 设置/L1 入口改 bindings → 只改路由表,即时生效(v2.1 单一传输下真正即时)
- **session record 的 `router` 子对象(v2.1 新增,三处 UI 稳定显示的事实源)**:

```jsonc
{
  "sessionKey": "opaque",
  "bindings": { /* 快照 */ },
  "sourceProfileId": "budget",      // 来源方案(null=自定义),profile 定义后续变更不回溯
  "profileRevision": 3,             // 应用时的方案修订号,供 UI 显示"已偏离方案"之类状态
  "dynamicRouting": true,
  "directLaunched": false,          // 不可变:启动时 router 不可用而直连
  "authKind": "oauth"               // 不可变:启动时鉴权形态(oauth|token),§3.5 强制检查的事实源
}
```

### 4.5 UI 与交互(plan mode 式动态开关,用户已确认)

交互完全对齐 plan mode 现有模式(`WorkspaceSessionComposer.tsx`):主界面只放最快的开关,完整控制渐进展开。

**L1 即时层——三处入口,同一状态(用户已确认)**

a. **状态条路由 chip**:`WorkspaceStatusStrip` 现有 env chip 旁,Route 图标 + 当前 profile 名(或「直连」),点击弹方案 Popover(profile 单选列表 + 绑定摘要 +「动态改派」开关 +「自定义绑定…」跳 L2)。切换 = `update_session_bindings` IPC 改路由表,即时生效;toast 轻提示。红利:router 模式下 env chip 切换也变即时生效(§3.3)

b. **Composer 状态识别**:路由生效(非直连)时 composer shell 顶部显示路由 pill——与 plan pill 同行并列、同款样式 token(`bg-primary/[0.06] text-primary/70` 小胶囊 + Route 图标 + 方案名),**不引入第二种边框色**。点击 pill 打开同一方案 Popover;直连时 pill 消失

c. **+ 快捷菜单**:新增「模型路由」行(紧跟 plan 行,同款 Switch 行样式):行尾显示当前方案名,点击行在**同一 Popover 内嵌展开**方案单选列表,顶部总开关(开 = 最近方案,关 = 直连)

**L2 Session 设置「模型路由」区(完整控制)**
- per-type 绑定行(内置花名册下拉 + `subagent:*` + `background`),env 下拉
- 动态路由开关;「存为我的默认」写全局默认 bindings

**L3 默认规则归属:环境管理页(用户已确认)**
- 默认路由规则本质是"环境之间的关系":环境管理页新增「默认路由规则」卡片(默认 bindings 编辑 + 自定义 profile 管理)
- 删除环境时同页提示哪些默认绑定/profile 引用了它(呼应 §6.2 回退策略)
- 全局设置 Router 区只留基础设施:总开关、端口(改动提示需重启)

**Profile(方案)模型**
- 内置:`直连` / `省钱杂活`(`subagent:*` + `background` → 便宜环境)/ `特长分工`(推荐矩阵)
- 用户自定义存 `config.json router.profiles[]`:`{ id, name, bindings }`
- profile 是 bindings 的**命名快照**:切换时展开写入 session 路由表;后续改 profile 定义不影响运行中 session

**空态/降级**
- 全局关闭 router → 三处入口灰显「直连」,tooltip 指路设置页
- router 启动失败 → chip 警示态 + 已回退直连说明
- i18n 全走 `t()`(zh/en 双 locale);shadcn/ui(Popover/RadioGroup/Switch/Toast);色板走 design token

### 4.6 目标 model 解析算法(v2.1 新增,评审阻断项)

**禁止复用 `resolveClaudeRuntimeModel`**——它优先返回 `ANTHROPIC_MODEL`,而第三方环境的该值常是 tier 占位符(如 GLM 配置 `ANTHROPIC_MODEL=opus` + `ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.2`),直接重写会把请求 model 改成裸 `opus` 打废上游。

规则:

1. **default_env(main)请求:永不重写 model**——进程级 env pins 已由 Claude Code 解析好(如 `glm-5.2`),原样透传
2. **路由到非默认环境 E 的请求**(逻辑键/显式别名命中),按逻辑身份 × 原始 tier × E 的 pins 组合:

| 场景 | 目标 model |
|---|---|
| `background` 逻辑键 | E 的小模型 pin(`small_fast_model` ?? `default_haiku_model`)?? E 主 pin ?? 非占位 runtime_model ?? 原样透传 |
| 请求 model 含 tier 关键词(opus/sonnet/haiku,如 agent 定义 `model: 'haiku'` 或 `claude-sonnet-4-6`)且 E 有对应 tier pin | E 的该 tier pin |
| 其余(含显式别名,请求 model 是别名本身无 tier 信息) | E 主 pin(`default_sonnet_model` ?? `default_opus_model` ?? `default_haiku_model`)?? 非占位 runtime_model ?? 原样透传 |
| E 无任何可用 pin(如 official 无 pins) | **原样透传**,不重写 |

- "非占位"判定:值小写后 ∈ {opus, sonnet, haiku} 或为空 → 视为占位/不可用,跳过
- 算法以表格为准写成 router 单测的 fixture 矩阵;字段名以 `config.rs` 的 `EnvConfig`(default_opus_model 等,:15-100)实际定义为准

## 5. Helper 注入机制与兜底(v2 重写)

### 5.1 挂钩点:PreToolUse `updatedInput`(替代 SDK agents 注入;v2.1 修正)

helper 在 `buildClaudeQueryOptions`(:1481,当前 hooks 在 :1518)注册。**两个硬约束(评审实证)**:

- 返回结构必须走 `hookSpecificOutput` 嵌套(`sdk.d.ts:2255` 定义、`SyncHookJSONOutput` :6839 外层;仓库正确范例 `claudePlanGuard.ts:82`)——`hookEventName`/`updatedInput` 放顶层无效
- **与现有 plan-mode hook 合并,不能覆盖**:`buildClaudePlanModeHooks` 已占用 `PreToolUse`,新 hook 追加 matcher 条目

**职责划分(v2.1 核心修正):helper 只贴身份,不做任何绑定解析**——router 模式下**每次 Task 调用一律注入原始身份标签** `subagent:<实际类型>`;exact → wildcard → default 的解析**只发生在 router**。如此:无 helper/router 双份 binding 状态与热同步问题;后加的绑定对既有 session 同样即时生效;wildcard 不丢失真实类型。

```ts
// 伪代码(结构已按评审修正)
const routeHook = async (input) => {
  if (input.tool_name !== TASK_TOOL_NAME) return { continue: true };  // matcher 之外的保险
  const ti = asRecord(input.tool_input);
  const type = ti?.subagent_type;
  if (typeof type !== 'string' || !type) return { continue: true };
  if (typeof ti.prompt === 'string' && ti.prompt.startsWith('<CCEM-ROUTE>ccem:')) {
    return { continue: true };  // 主模型已写显式环境标签(动态改派),不再注入(§4.2 双标签规则)
  }
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...ti, prompt: `<CCEM-ROUTE>subagent:${type}</CCEM-ROUTE>\n${ti.prompt ?? ''}` },
    },
  };
};

hooks: {
  PreToolUse: [
    ...buildClaudePlanModeHooks(isPlanMode).PreToolUse,   // 现有 plan guard,保留
    { matcher: TASK_TOOL_NAME, hooks: [routeHook] },       // 新增;TASK_TOOL_NAME 由 Spike B 确认('Task'/'Agent')
  ],
}
```

- 标签进入 subagent 首条 user message → 该 subagent 后续每次 API 请求都携带 → router 精确前缀识别 + 剥除
- helper **不持有** bindings;路由表快照只存于 session record(§4.4)与 router 内存;helper 仅需知道自己处于 router 模式
- 匹配任意 `subagent_type`(内置/插件/自定义),不触碰内置 agent 定义,无 prompt fork 风险
- CCEM 环境配置中的 `subagentModel` 字段(config.rs:631,下发 `CLAUDE_CODE_SUBAGENT_MODEL`)与 router 模式**互斥**:router 模式 session 不下发该 env 键(在 `build_claude_env_vars` 调用侧按模式裁剪),避免最高优先级覆盖一切路由信号

### 5.2 关键决策:不用 `CLAUDE_CODE_SUBAGENT_MODEL` 做路由

该变量优先级最高,会压掉 per-type 绑定与 frontmatter 别名。v2 仅保留一处 model 载体:`background` 逻辑键借 `ANTHROPIC_SMALL_FAST_MODEL=ccem-route:background` 传递(该变量只影响小模型杂活,无冲突)。

### 5.3 实施前置 Spike(未闭环,阻断放行)

- **Spike A(评审已完成 ✅)**:SDK agents 同名注入 = 完整替换内置 agent(`description`/`prompt` 必填,本地 mock 复现)——该挂钩点废弃
- **Spike B(待做,核心)**——harness 已提交:`packages/native-runtime-helper/scripts/spike-b.mjs`(本地捕获服务器 + 编排好的假 SSE 上游驱动 Task 调用,含 plan guard 合并样例;`node scripts/spike-b.mjs` 运行,产出 `spike-b-report.json`):
  1. PreToolUse `updatedInput` 改写的 `prompt` 是否原样成为 subagent 首条 user message 并出现在其 API 请求体(含多轮后仍在)
  2. 当前版本 Task 工具的 `tool_name`/`subagent_type` 字段名(matcher 写法;harness 对 Task/Agent 双名自动重试)
  3. `ANTHROPIC_SMALL_FAST_MODEL` 接受任意字符串并进入请求 model 字段(background 载体;短编排会话可能不触发 side-query,允许 INCONCLUSIVE 并补人工验证)
  4. official OAuth 模式下不设 `ANTHROPIC_AUTH_TOKEN` 时请求 Authorization 形态(harness 只记录有无,真实透传需 official 账号人工验证)
- Spike 产出写入"实施记录"节;B 关键项否证 → 回退方案:仅 `background` + 显式 `ccem:` 别名可用(per-type 绑定砍掉),UI 明示

### 5.4 运行时覆盖(v2.1 收缩:native-only)

- **本期仅 native workspace session**(完整支持:PreToolUse 钩子 + background 载体 + 显式别名)
- headless(`build_claude_command`)/ tmux / terminal:**整体移入后续项**(§8 step 11;评审意见:与"native-only"口径一致,不在本期文档内保留半成品承诺)

### 5.5 外部发起渠道(v2 收缩,评审高优项)

ccem skill 发起会话走 `ccem desktop create` → desktop 控制桥。**本期范围:native workspace session(UI 与 `ccem desktop create` 同路径)**;bot(Telegram/Weixin/Wecom)、cron 渠道**不在本期**——它们不共用同一创建路径,需逐渠道接入与验收,列为后续项(§8)。

- `ccem desktop create` 新增可重复参数 `--route "<key>=<env>"` 与 `--routes-json <json>`,种子化 bindings 快照;缺省拷全局默认。`<key>`:`subagent:<名字>` / `subagent:*` / `background`。示例:

  ```bash
  # 主会话走 official;Explore 走 glm;小模型 side-query 走 deepseek
  ccem desktop create --env official \
    --route "subagent:Explore=glm" --route "background=deepseek" --json
  ```

- `ccem desktop routes <runtimeId> --json` 查看;`--set "<key>=<env>"` 运行时改绑定(即时生效);响应 JSON 增加 `routes` 字段
- **边界:** Codex provider 非 Anthropic 协议,`--provider codex` 时忽略 route 参数并提示

### 5.6 主会话可见性与动态路由(v2 修订)

1. **类型枚举是 Claude Code 内建的**(Task 工具描述自动枚举),无需 CCEM 干预
2. ~~description 标注路由信息~~(v2 删除:依赖已废弃的 agents 注入)——路由可见性全部由路由菜单承担
3. **路由菜单 + 动态改派**:helper 向 SDK query system prompt 追加「可用模型路由」段:可用环境别名 + 各自特长 + 标签语法(主模型可在 Task prompt 开头自写 `<CCEM-ROUTE>subagent:Explore</CCEM-ROUTE>` 或显式 `<CCEM-ROUTE>ccem:glm</CCEM-ROUTE>` 一次性改派;菜单内容常量,不破坏 prompt cache)。Task 的 `model` 参数是固定枚举塞不进别名,动态选择只能走标签。`router.dynamic_routing` 可关(默认开)

## 6. 错误处理、健壮性与可观测性

### 6.1 SSE 透传健壮性(用户要求"非常健壮",一级目标)

- hyper/axum 流式 body 端到端 chunk 透传,**应用层零缓冲**(不 collect)
- 双向 abort 传播:client 断开 → cancel upstream;upstream 断开 → 终止 downstream;半开连接依赖 tokio drop 传播清理
- **流中段绝不重试**;首字节前连接失败也不跨 provider 自动重试,原样返回错误
- Header:默认全透传;仅按目标环境重写鉴权头(§3.5);`Host`/`Content-Length` 由 hyper 重算;不解压、不动 `Content-Encoding`
- 连接超时(默认 10s 可配);流式读不设总超时,可选 idle timeout
- 标签剥除仅限**首条 user message** text block 精确前缀,绝不误伤正文(评审实证:动态标签在 user message 而非 system 块)

### 6.2 降级与错误语义

- router 启动失败(端口全被占等)→ session 回退直连 + UI 警告;旧行为完全保留
- 绑定指向已删除环境 → 回退 `default_env` + UI 警告 + 日志
- 目标环境 token 解密失败 → 502 + 明确错误体;OAuth 型目标收到占位/缺失 Authorization → 502 明确提示该 session 未以 OAuth 启动
- 上游错误:状态码与错误体原样透传

### 6.3 可观测性与安全

- 每请求记录:session(脱敏 sessionKey)、命中逻辑键与环境、状态码、耗时;SSE `usage` 事件只读嗅探提取 token 用量(按环境分账的数据基础)
- 本地端点 `/health`、`/routes`(sessionKey 鉴权)
- 日志不落密钥;**权限硬化(§3.2):~/.ccem 0700、敏感文件 0600、原子写不放宽、迁移既有文件、回归测试**;仅绑 127.0.0.1

### 6.4 与既有 ProxyDebug 的关系(v2 新增,评审高优项)

`ProxyDebug`(main.rs:72)同样设置 `ANTHROPIC_BASE_URL`,两者不能各自为政。原则:**单一代理入口**——router 吸收 ProxyDebug 的流量抓取能力作为可选观测 tap(记录请求/响应元数据);**关闭 debug 只停止 recording tap,绝不停止 router 或清空路由表**(v2.1 明确);实现 step 2 时先盘点 ProxyDebug 现有功能清单,明确迁移映射与删除边界,不允许两个代理串联

## 7. 测试策略

- **Rust 单测**:逻辑键解析(精确名/兜底/未绑定回退/default_env)、显式别名直达与未知别名 400、鉴权重写与 OAuth 透传分支、sessionKey→session 解析、标签精确剥除(user message 场景)、配置迁移、**文件权限回归(0600/0700、原子写)**
- **集成测试**(mock upstream):SSE 字节逐段一致、慢/乱序 chunk、双向断开传播、大 body、并发多 session 隔离、鉴权头重写正确且不漏旧 token
- **混沌专项**:随机 chunk 大小 + 随机延迟、中途 RST、30min+ 长流、并发 100 流
- **helper 测试**:PreToolUse 钩子按 `subagent_type` 正确注入/不注入、标签格式、路由表快照热更新
- **Spike B 验证脚本**:真实 SDK 抓包四项确认(§5.3),结果写入实施记录
- **E2E 自测**:`cd apps/desktop && pnpm tauri:dev`(目标 `com.ccem.desktop.dev`),建 session 绑便宜环境,触发 Explore,断言请求落目标上游;改 bindings 后**下一次派工**即走新环境(v2 即时性);official OAuth session 全流程
- 全量门禁:`pnpm verify`

## 8. 实施步骤(跟做顺序)

0. **Spike B**:运行 `node packages/native-runtime-helper/scripts/spike-b.mjs`(§5.3 四项),产出写入实施记录;关键项否证 → 按回退方案缩范围
1. `packages/core`:`RouterConfig` / `SessionRouteTable` / `SubagentBinding` / `RouterProfile` 类型 + 内置花名册 + 内置 profile 常量 + session record `router` 子对象(§4.4 七字段)
2. **代理入口合并**(§6.4):盘点 ProxyDebug 功能 → `src-tauri/src/router.rs`(或 `router/` 目录,<1000 行/文件):代理服务、内存路由表(从 session store 重建)、逻辑键解析、**目标 model 解析算法(§4.6 表格即 fixture 矩阵)**、双标签优先级、OAuth 分支(§3.5 可信源判定)、`/health`、`/routes`、debug tap(关闭仅停 tap)
3. `config.rs`:`router` 配置节 + 端口嗅探;**权限硬化 fail-closed(~/.ccem 0700、敏感文件 0600、既有文件迁移,迁移必须先于路由重建,失败不启动 router)**;router 模式裁剪 `CLAUDE_CODE_SUBAGENT_MODEL` 下发
4. 启动路径接入:`create_native_session`(main.rs:1220,URL path 会话键 + `authKind` 判定与持久化);恢复路径同一注入(§3.4);headless/tmux 本期不接(移 step 11)
5. helper:PreToolUse 路由 hook(§5.1:一律注入原始身份、`hookSpecificOutput` 结构、与 plan guard 合并)、`buildClaudeQueryEnv` 指向 router(URL path 形态)、`ANTHROPIC_SMALL_FAST_MODEL=ccem-route:background` 载体、路由菜单 system prompt 追加
6. IPC:`get_router_settings` / `update_router_settings` / `update_session_bindings` / `router_status`——全部经 §3.5 fail-closed 校验
7. CLI wrapper:`ccem desktop create --route/--routes-json`、`ccem desktop routes`(§5.5,同样过 fail-closed)
8. UI(§4.5):状态条 chip + 方案 Popover、composer 路由 pill、+ 菜单「模型路由」行、session 设置「模型路由」区、环境管理页「默认路由规则」卡片、全局设置 Router 基础设施区、降级空态(shadcn/ui + Hugeicons + `t()` 双 locale + design token)
9. 切主环境路径改为改路由表(§3.3;token→official 切换走 fail-closed 拦截),保留 `directLaunched` session 与 router 关闭时的旧软重启
10. 测试(§7)+ `pnpm verify`
11. **后续项(不在本期验收)**:headless / tmux / terminal 的 router 支持;bot(Telegram/Weixin/Wecom)/ cron 渠道逐渠道接入 + 验收

## 9. 验收标准

- 单 session 内:主会话走环境 A,Explore subagent 走环境 B(上游抓包/日志证实);**改 bindings 后下一次派工即生效,不重启 query**(v2 即时性)
- official(OAuth)主会话 + 第三方 subagent 环境并发可用;token 主会话切 official 被 UI 约束拦截
- app 重启后运行中 session 路由不丢;端口被占自动嗅探并提示
- 死会话恢复:隔夜后点开老会话,路由(sessionKey + bindings)自动重建;旧 record 透明迁移
- `ccem desktop create --route ...` 绑定生效;`ccem desktop routes` 可查可改
- `~/.ccem` 0700、含键文件 0600,权限回归测试通过
- router 关闭/启动失败时所有旧行为不变(直连、软重启切环境)
- 流式转发通过混沌专项;密钥不出现在日志;ProxyDebug 能力合并为单一代理入口

## 实施记录

- 2026-08-09 设计评审:发现 3 阻断(逻辑键协议/agents 注入挂钩点/official OAuth)+ 2 高优(文件权限/代理与渠道范围),文档 v1 → v2 修订
- 2026-08-09 Spike A(评审代做):SDK agents 同名注入 = 完整替换(`sdk.d.ts:38` 必填 description+prompt;本地 Claude 2.1.220 mock 复现)→ 挂钩点废弃,改 PreToolUse `updatedInput`(`sdk.d.ts:1521/2116/2248` 类型层可行)
- 2026-08-09 复核:`~/.ccem` 0755、`runtime-state.json` 等 0644 属实;PreToolUse hooks 类型签名核实
- 2026-08-09 评审二(5 阻断 + 6 清理)→ v2.1:hook 返回结构改 `hookSpecificOutput` 嵌套(对照 `claudePlanGuard.ts:82`)、与 plan guard 合并(index.ts:1518);helper 一律注入原始身份标签、解析收归 router;直连改纯路由状态(单一传输);新增 §4.6 目标 model 算法(禁用 `resolveClaudeRuntimeModel`);OAuth 五入口 fail-closed + 透传限可信官方源;session record `router` 子对象七字段;双标签优先级;debug tap 语义;权限迁移 fail-closed;"标题生成"表述清理(CCEM App 自身行为,不属于 Claude side-query);headless/tmux 移后续项
- Spike B:待做(§5.3;harness `packages/native-runtime-helper/scripts/spike-b.mjs` 已提交)
