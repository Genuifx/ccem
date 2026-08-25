# DSH：CLI 模型环境接入与 Desktop History / Analytics 首期计划

状态：已完成 `kiro-rs` 审查并修订

日期：2026-08-24

审查记录：通过 CCEM Desktop 启动 `kiro-rs` / `yolo` 独立审查；8 项 findings 已逐项落入本文第 10 节。

## 1. 目标

完成一条首尾相接的产品链路：CLI 把 CCEM 中已配置的其他模型环境安全投影给 DSH headless；DSH 产生的本地会话作为第四种只读来源进入 CCEM Desktop 的现有 `History` 与 `Analytics` 页面。

首期用户结果：

1. 用户可用 `ccem dsh run` 选择当前或指定 CCEM 模型环境，在 DSH headless 中执行一次任务；不是只有 DeepSeek 官方环境才能使用。
2. `ccem dsh inspect` 只预览脱敏后的 provider/model 投影，`ccem dsh doctor` 提供二进制、版本、配置与运行条件诊断。
3. 用户打开 History，可以用 `DSH` 来源筛选查看本机 DSH 会话。
4. 选择一条 DSH 会话后，可以查看用户消息、助手回复、工具调用/结果及模型信息。
5. DSH 会话是只读的，不显示或触发 Resume、Fork、Composer 等运行时动作。
6. 用户打开 Analytics，可以筛选 `DSH`，查看 token、模型、时间趋势及环境/Provider 分布。
7. `All` 继续汇总 Claude、Codex、OpenCode 与 DSH，单个 DSH 来源故障不得拖垮其他来源。

Desktop 首期只解决“现有 History 与 Analytics 能读取 DSH”。它不是 CCEM 自有的长期归档：DSH 源文件被删除后，记录仍会消失。原始证据归档、审计规则、附件闭包和删除 tombstone 留到后续阶段；本期不新增独立 Audit 页面。

## 2. 行为合同

### 必须发生

- CLI 将所选 CCEM 环境的 Anthropic-compatible endpoint、模型与凭证投影成 DSH `llm-pi-ai` 的临时 `anthropic-messages` route；不把不同厂商的订阅入口擅自改写成原生 OpenAI/DeepSeek endpoint。
- `ccem dsh run` 使用参数数组和 `shell:false` 启动 `dsh --profile headless`，准确透传 stdout、stderr、退出码和 signal。
- 临时 Cordis patch 不含 secret；secret 只以专用子进程环境变量提供，临时文件权限为 `0600` 并在成功、失败、signal 后清理。
- CLI 运行产生的 session 必须保存在 Desktop 同样解析的 active DSH root（显式 `DSH_HOME`，否则 `~/.dsh`）；隔离用户 settings 不能以丢失会话历史为代价。
- `inspect` 只输出脱敏后的投影与诊断事实，不读取会话历史；`doctor` 对 DSH/Node 版本、必需字段与最终配置 fail closed。
- 默认从后端解析的 DSH home 读取历史；renderer 不传入任意文件路径。
- DSH 不存在或没有会话时，History/Analytics 显示 DSH 空状态，其他来源照常工作。
- DSH 文件损坏、格式不受支持或 helper 失败时：
  - `source=dsh` 返回可理解的来源错误；
  - `source=all` 只对新增的 DSH 分支做 soft-fail，保留其他来源结果并记录诊断；Claude/Codex/OpenCode 沿用现有 fail-fast 语义，本期不顺手重构。
- History 的 DSH 列表项正确显示项目目录、时间、标题、模型/Provider；标题无可靠来源时使用首条用户消息的安全摘要。
- Detail 只使用 DSH 官方逻辑事件/投影生成消息，不能把压缩 chunk 当成多条回复，也不能重复显示 replay/seed 前缀。
- Analytics 只统计已提交的用量事实；同一 step 的累计/最终 usage 以最终值为准。
- 子会话继承的 `seq < seedLength` 不重复计入父子合计。
- 未知模型价格显示“未定价”，不能冒充 `$0`。
- History 列表、全局搜索或来源筛选得到的任何 DSH 条目，都必须根据 `selectedSession.source` 进入只读详情；不能根据当前 filter 决定是否允许 Resume。

### 绝不能发生

- 不复用当前 `ccem run` 的 `shell:true` 启动器，不让 prompt 中的 shell 元字符被二次解释。
- 不把 token 写入 argv、patch、日志、错误或 `inspect/doctor --json` 输出，也不静默回退到 ambient provider credential。
- 不把 CCEM 六档 permission mode 宣称为 DSH sandbox/approval 的等价映射；首期只接受明确的 DSH 原生权限选项或保守、显式标注的近似值。
- Claude 官方 OAuth-only 环境、缺 URL/token/model 的环境必须拒绝运行，不能猜测或降级到其他环境。
- 不调用可能修复或写回 DSH session 的 `load` 路径。
- Desktop 历史读取不启动 DSH agent、TUI 或 Web Host；CLI 的显式 `dsh run` 是独立、用户发起的 headless 执行路径。
- 不在 Rust 中把 `.jsonl.zstd` 当普通 JSONL 猜格式。
- 不把 DSH 条目归一化成 Claude，也不进入 Claude/Codex/OpenCode 的 Resume 路径。
- 不只依赖“隐藏按钮”：前端 Resume handler 必须用可运行来源 guard，后端继续拒绝 `dsh` 作为 interactive client。
- 不让 DSH 会话进入 Workspace 会话树；本期产品表面只有 History 与 Analytics。
- 不修改、迁移、压缩、删除或加锁 DSH 的源文件。
- 不读取或输出 `$DSH_HOME/.credentials.yaml`、`.env` 或其他凭证文件。

## 3. 当前实现边界

- Rust History 只识别 `claude/codex/opencode`，列表、搜索、Workspace overview 与详情共用 `history.rs`。
- `get_workspace_overview_snapshot()` 也调用通用 `load_history_sessions()`；如果直接把 DSH 加进该函数，Workspace 会把未知来源按 Claude 处理并暴露错误的运行入口。
- 前端 `HistorySource` 只有三种来源，未知值会回退为 `claude`。
- `HistoryDetail` 无来源能力判断，固定展示 Resume。
- `History.tsx` 当前把 `HistorySource` 直接传给只接受 `LaunchClient` 的 launcher；一旦加入 `dsh`，必须拆出 resumable/read-only 能力，而不能用宽泛 union 强转。
- Analytics 通过 `usage-cache.json` 保存可重建统计缓存；它不是归档，刷新时只保留仍被发现的来源。
- Analytics 当前把没有价格表的模型成本计算为 `0.0`，接入大量 DSH 模型前必须补充“未定价”语义。
- DSH rc.2 默认 session artifact 是 Zstandard frame + packed rows；当前 format 仍是 prerelease v0，没有通用迁移保证。

## 4. 推荐架构

```text
后端发现的 DSH_HOME/sessions
             │
             ▼
版本锁定、短生命周期、只读 Node helper entry
  list / detail / usage（JSON stdin → JSON stdout）
             │
             ▼
Rust dsh_history adapter
  超时、大小上限、schema 校验、来源隔离
       ┌─────┴──────────┐
       ▼                ▼
History DTO       usage-cache 派生条目
       │                │
       ▼                ▼
History 页面      Analytics 页面
```

### 4.1 为什么使用独立 one-shot helper entry

使用 DSH 官方 persistence/session projection 包处理压缩、packed rows、format version 与逻辑事件。源码与构建工具复用现有 `@ccem/native-runtime-helper` workspace 包，但生成独立的 `dsh-history/lib/dsh-history-helper.mjs` entry，并连同 bundle 内 `@deepseek-ai/dsh-llm` 读取版本所需的 package metadata 一起 staged；它由单独短生命周期 `ccem-node` 子进程执行，不进入现有 interactive helper 的 initialize/prompt 循环。历史读取失败或超时因此不会影响正在运行的 Claude/Codex session，也不需要再造一个 workspace package。

DSH JSONL adapter 仅在 Windows 的写入/materialize 路径懒加载 `koffi`；本期 `list/detail/usage` 全部使用只读 `inspect/readFrom` seam，不进入该路径。Phase 0 已用不含 `koffi` 的 detached staged resource 验证三种操作可执行，因此首期刻意不把 `koffi` 与 `.node` native addon 放入 app Resources，避免引入未被 Tauri 默认签名的 Mach-O 资产。bundle 中若意外进入写路径，缺失模块必须使 helper fail closed；禁止用补齐 native addon 的方式扩大本期运行面。

首选依赖只包含读取所需的 DSH session/persistence/projection 包及其必要 peer closure，全部精确锁定在同一 DSH tag；禁止 caret、`latest` 或混用 dist-tag，不把完整 DSH agent runtime 嵌入 Desktop。只使用发布 tarball 的 package-root public exports，不依赖可能未随包发布的 `./src/*`。

### 4.2 Helper 协议

请求：

```ts
type DshHistoryRequest =
  | { op: 'list'; roots: string[]; limit?: number }
  | { op: 'detail'; sourceInstanceId: string; sessionId: string }
  | { op: 'usage'; roots: string[] };
```

响应 envelope：

```ts
type DshHistoryResponse<T> =
  | { ok: true; schemaVersion: 1; dshVersion: string; data: T; warnings: string[] }
  | { ok: false; schemaVersion: 1; code: string; message: string };
```

约束：

- stdout 只输出一个 JSON envelope；日志只进 stderr。
- Rust 端限制运行时间、stdout/stderr 大小和 session 数量。
- `sourceInstanceId = sha256(UTF8(canonicalize(root)))[0..16]`；同一路径的 symlink/realpath 归一后必须得到同一值。详情请求只能命中后端本轮已发现的 root，不能反解或注入路径。
- helper 输出经过版本化 schema 校验；DSH event shape 不直接穿透到 React。
- canonical root 迁移会形成新的 instance id；旧 virtual cache key 是可丢弃 orphan，并在下一次完整 refresh 时被清除，不承诺跨 home 迁移保持缓存命中。

### 4.3 History 投影

| DSH 事实 | CCEM History 字段 |
|---|---|
| `(root fingerprint, session header id)` | 稳定、跨 root 不冲突的 session key |
| header cwd | `project` / `projectName` |
| 官方 `foldSessionTitle`，无结果时取首条 committed user message | 默认 `display` |
| 最后一个 committed event 时间 | `timestamp` |
| provider/model selection | `envName` / message `model` |
| `isAppendSurfaceEvent` 的原始 user/assistant/tool-result 消息 | 人类可见 transcript；保留已看过的对话 |
| tool call/result view | `tool_use` / `tool_result` content block |
| compaction/summarization event | 首期不投影，`segments=[]` |

不把原始 chunk、replacement copy 或 crash-repair suggestion 直接映射成普通聊天消息。DSH 官方明确区分“人类 transcript”与“模型当前 surface”：History 使用 append-origin 消息，保留用户已经看过、但后来被 compaction replacement 遮蔽的原始对话；replacement 只用于模型上下文，不能反向抹掉历史。无法可靠投影的事件保留 warning，不伪造内容。DSH 会话继续复用现有 `(source, id)` 标题覆盖和标签标注；源消失后的 orphan annotation 与其他来源现状一致，本期不额外清理。

### 4.4 Analytics 投影

每个 DSH session 在现有 cache 中使用虚拟 key：

```text
dsh://<source-instance-id>/<session-id>
```

`CacheFileEntry` 增加可选 `sourceRevision`（opaque）；DSH session 未变化时复用既有派生结果，变化时由 helper 重新生成该 session 的 usage facts。`usage-cache.json` 仍是可丢弃缓存，不承担持久归档职责。

用量规则：

- 身份至少包含 session、turn/step、provider、model 与最终 event seq。
- 同一 step 优先采用最后一条 `assistant/chunk { type: 'usage' }`；完全没有 usage chunk 时才回退到 `assistant/message.data.usage`，不累加快照。
- 子会话默认排除 `seq < seedLength` 的继承前缀。
- DSH/pi-ai 没有独立、可信的 reasoning token 字段时，将其保持在 provider-reported output 中，不自行拆分。
- per-entry 记录 `unpricedTokens`，聚合 DTO 同时提供 `unpricedTokens` 与 `costIncomplete`；已知价格照常汇总，未知部分不进入已知成本。
- 成本卡规则固定为“已知成本 + N tokens 未定价”；全部已定价时 `unpricedTokens=0`、`costIncomplete=false`，现有 UI 不变。不能把已知小计标成“总成本”。

## 5. 分阶段实施

### Phase 0 — 只读与打包 Spike（阻塞 Gate）

目标：先证明推荐 seam 在当前 rc.2 与 Desktop 发布矩阵上成立。

工作：

1. 在临时 `DSH_HOME` 中使用合成/官方脱敏 fixture；自动化不得扫描或复制真实 `~/.dsh`，也不读取 credentials。
2. 用精确版本的官方 persistence/session projection 包执行 `inspect/readFrom/readRaw`；禁止调用 `load`。
3. 覆盖 compressed、packed rows、子会话 seed、未完成 turn、损坏尾部和未知 format。
4. 读取前后比较 fixture 的 SHA-256、大小与 mtime，证明 helper 没有写源文件。
5. DSH helper 复用 Desktop bundled `ccem-node`：先记录实际 Node 版本，再对完整依赖 closure 的 `engines` 取最大下限；如任一所选包要求 Node `>=22.19` 而 bundled Node 不满足，必须先升级 sidecar，不能退回系统 Node。
6. 对发布 tarball 做 operation-scoped closure/export integrity smoke：全套 DSH 包版本一致，只使用 package-root export；验证 `list/detail/usage` 所需的 package metadata 与 Zstd 能力完整，并证明三种只读操作不会解析仅供写入路径使用的 `koffi`/`.node`。
7. 用实际 packaged resource 路径证明 macOS arm64、macOS x64 和 Windows x64 都能执行 built helper，而不只是在源码目录跑 esbuild。
8. 输出最小 `list/detail/usage` JSON fixture，固定 schema v1。

停止条件：

- 官方读取包无法脱离完整 runtime 使用；
- 只读调用仍会创建、修复或改写来源；
- Zstd 或其他只读路径的必要依赖无法进入现有三平台发布包；
- 精确版本 tarball 的 root export/peer closure 不完整，或只能依赖未发布的 `./src/*`。

任一成立时停止实施并重新比较“受控 Web Host export”与“格式版本锁定的自有 decoder”，不能静默改方案。

### Phase 1 — DSH helper 与 Rust source adapter

预计新增：

- `packages/native-runtime-helper/src/dshHistory.ts`
- `packages/native-runtime-helper/test/dsh-history.test.mjs`
- `apps/desktop/src-tauri/src/dsh_history.rs`
- `apps/desktop/src-tauri/resources/dsh-history/lib/dsh-history-helper.mjs`
- `apps/desktop/src-tauri/resources/dsh-history/package.json`

预计修改：

- `packages/native-runtime-helper/package.json`、`pnpm-lock.yaml`
- `apps/desktop/scripts/prepare-native-runtime-sidecar.mjs`（构建并准备两个独立 entry；必要时重命名）
- `apps/desktop/src-tauri/tauri.conf.json`
- `apps/desktop/src-tauri/src/native_helper_resource.rs` 或新增独立 resource resolver
- `apps/desktop/src-tauri/src/main.rs`

实现：

1. 首期只解析一个 active root：后端读取 inherited `DSH_HOME`，未设置时回退到 `~/.dsh`，helper 实际读取 `<home>/sessions`。显式非空 `DSH_HOME` 无效时直接报该来源不可用，绝不能静默回退并读取 `~/.dsh`；只有真正未设置时才使用默认目录。多 root/多 profile 延后。
2. 不接收 renderer 提供的 root；后续 CCEM-managed roots 通过后端 registry 增加。
3. Rust 通过现有 bundled `ccem-node + dsh-history/lib/dsh-history-helper.mjs` one-shot 进程提供 list/detail/usage，并校验 schema、版本、超时和输出大小；stdin 写失败、超时或输出超限都必须立即终止并 reap 该精确子进程。
4. DSH 单源错误分级为 absent、unsupported-format、busy/corrupt、helper-unavailable。
5. 在 test-only 路径注入临时 root/helper executable，不在生产 IPC 暴露任意路径。
6. 不新增 Tauri command；History/Analytics 只在既有命令内部调用 adapter，因此不扩张 renderer 的文件路径能力或 pet/tray capability。

阶段验证：helper 源码单测、built `.mjs` contract smoke、Rust adapter contract test、源文件不变证明、三平台 packaged-resource smoke。

### Phase 2 — History 页面接入

Rust：

1. `history.rs` 增加 `SOURCE_DSH` 与 DSH list/detail 映射。
2. 不直接扩展 Workspace 共用的无 scope 聚合路径：为 History/Search 显式 opt-in DSH，Workspace overview 明确走不含 DSH 的 loader，并审计其 Claude fallback。
3. History 全局搜索包含 DSH；搜索结果进入详情后仍按该 session 的 source 做能力判断。
4. `source=all` 时仅捕获 DSH helper 错误并保留其他结果；现有三来源继续 fail-fast。`source=dsh` 时返回结构化错误。
5. DSH detail 不调用 subagent、resume 或 source mutation 路径。

前端：

1. `HistorySource` 增加 `dsh`，unknown source 不再静默回退为 Claude。
2. History filter、列表 icon/badge、空状态和中英文文案增加 DSH。
3. 增加 exhaustive `isResumableHistorySource(source): source is LaunchClient`；`HistoryDetail` 根据 `selectedSession.source` 隐藏 Resume，`handleResume` 再做运行时 guard，禁止用类型断言绕过。
4. 保留现有“导出投影 JSON”，但不把它标为原始证据导出。
5. DSH helper 错误显示在 DSH 空状态；All 仍展示其他来源。
6. 保留后端 `create_interactive_session` 的 allowlist，并新增 `client=dsh` fail-closed 回归测试，形成 UI、handler、backend 三层防线。

阶段行为验证：

- History → DSH filter → 选择会话 → transcript/tool call 可读。
- DSH filter 与 All/搜索结果中的 DSH detail 都没有 Resume；直接调用 handler/IPC 也不能把 DSH 交给 launcher，键盘导航与导出仍工作。
- Workspace 会话树中没有 DSH，不能通过任何 fallback 进入 Claude launcher。
- 删除/移走 fixture root 后刷新变为空，明确证明首期不是归档。

### Phase 3 — Analytics 页面接入

Rust：

1. `analytics.rs` 增加 `SOURCE_DSH`、virtual cache key 和 DSH cache loader。
2. `CacheFileEntry` 增加可选 `sourceRevision` 并 bump `USAGE_CACHE_VERSION`，旧 cache 自动重建。
3. 以 helper revision 判定 unchanged/changed；失败时不把旧 DSH 结果伪装成最新。
4. 落实 final-usage 去重、seedLength 排重、provider/model/environment 映射。
5. 扩展 entry 与 aggregate 的 `unpricedTokens/costIncomplete`；未知价格不再显示为零成本，已知部分只能称“已知成本小计”。
6. 同步 bump `usage-summary` 持久摘要版本；Tray/Workspace 等后台消费者不能继续读取旧版“未知模型按 `$0`”的摘要。

前端：

1. `Analytics.tsx`、`AnalyticsInsights.tsx`、Analytics TS DTO 与 Tauri IPC 类型增加 DSH/coverage 字段。
2. `All` 与 `DSH` 的 totals、trend、model、environment 使用同一份聚合事实。
3. 成本卡展示“已知成本 + N tokens 未定价”；全量已定价时保持现状，不改动 token 图表结构。
4. DSH 数据源不可用时显示来源状态，不影响 Claude/Codex/OpenCode cache。
5. 页面筛选结果保留在 Analytics 本地 `viewStats`；只有 `source=all` 的完整汇总可以写入全局 usage store。切换到 DSH/Claude 子集绝不能让 Workspace、Tray、streak 或海报误用页面筛选后的局部数据。

阶段行为验证：

- 同 fixture 在 DSH filter 与 All 的差额完全一致。
- 同一 final usage 不重复计数；父子 session 不重复统计 seed。
- 未知模型显示“未定价”，而不是 `$0`。
- session append 后 refresh 只更新对应 virtual cache entry；rewrite/truncate 触发完整重算。

### Phase 4 — CLI provider 投影与 headless 执行

实现：

1. 新增 `ccem dsh run <task>`、`ccem dsh inspect`、`ccem dsh doctor`；支持 `--env`、tier/model 选择、cwd 与明确的 DSH 原生权限参数。
2. v1 不修改 `EnvConfig` 持久化 schema；运行时从现有 `ANTHROPIC_BASE_URL`、token 与 tier model 派生临时 `anthropic-messages` route，模型去空、去重并支持显式覆盖。
3. 只解密被选中的环境，使用固定 credential reference；patch、argv、诊断与错误均保持脱敏。
4. 在 one-shot patch 中禁用 DSH `settings` row，避免用户保存的 provider/default-model 覆盖 CCEM 选择；不改 `session-persistence-jsonl` row，让官方 base 的 `dshHomePath('sessions')` 继续写入 active DSH root。该 Cordis patch 语义必须先用当前锁定的 DSH rc.2 `--dump-config` 与冲突 settings fixture 实证。
5. CLI 本身继续兼容当前 Node target；只有进入 `ccem dsh` 子命令时才检查实际 DSH 与其 Node engine 条件，不影响其他命令。
6. `inspect` 是脱敏投影预览，不是第二套 History reader；Desktop helper 仍是唯一的 DSH 历史读取实现。

阶段验证：

- fake `dsh` 捕获 argv/env/cwd，证明 `shell:false`、元字符不执行、secret 不在 argv/patch/output、退出码/signal/ENOENT 精确、临时文件总能清理。
- 冲突 settings fixture 证明最终 provider/model 仍是所选 CCEM 环境；active DSH root 中保留 headless session。
- official OAuth-only、缺 token/URL/model、版本不满足与不存在的 binary 全部 fail closed，并给出可操作诊断。
- 允许真实 provider smoke 时，只执行一次无副作用任务；配置可表示与真实 endpoint/tool/thinking 兼容性分开报告。

### Phase 5 — 全链路验证与审查

自动化：

```bash
pnpm --filter @ccem/native-runtime-helper test
pnpm --filter @ccem/native-runtime-helper build
pnpm --filter @ccem/desktop test:run
pnpm --filter @ccem/desktop build
cd apps/desktop/src-tauri && cargo test --locked
pnpm verify
```

发布构建还必须在 CI 中从最终 app bundle 调用 `ccem-node + dsh-history/lib/dsh-history-helper.mjs`，覆盖 package metadata、Zstd 与无 `koffi` operation-scoped closure；仅 helper 源码测试、esbuild 成功或开发机 smoke 都不能关闭 Phase 0 gate。最低 Node 版本按实际 Zstd API 锁定为 `>=22.15.0`，并在 macOS arm64、macOS x64、Windows x64 的最终 staged resource 上分别执行 list/detail/usage smoke；三者都必须在不存在 repo `node_modules` fallback 的隔离环境中成功。

真实 Desktop：

1. 用当前 worktree 的 canonical `pnpm tauri:dev` 启动独立实例。
2. 读取 `.artifacts/tauri-dev/` manifest，用其准确 `identifier`/`mcpPort` 连接。
3. 使用临时 `DSH_HOME`：先由真实 `ccem dsh run` 产生至少一条会话，再补充普通对话、工具调用、子会话和 usage fixture；不指向真实用户 `~/.dsh`。
4. 分别验证 History 的 All/DSH/搜索/详情/无 Resume/刷新，以及 Analytics 的 All/DSH/模型/时间趋势/未定价状态。
5. 证明 CLI 产生的 session 无需导入即可出现在 Desktop History/Analytics，且两端解析的是同一个 active root。
6. 验证源目录 hash/stat 在 Desktop 读取前后未变化；保存截图和行为记录到 `.artifacts/`。

## 6. 测试矩阵

### Helper / 格式

- 空 root、单 session、多 project；首期单 active root，另测 canonical symlink/realpath 的 instance id 稳定性。
- raw JSONL、Zstd、packed rows、损坏尾部、未知 format version。
- live/open turn 不产生半条 assistant 消息或半份 usage。
- tool call/result、失败 tool、模型切换、compaction、父子 session seed。
- 路径包含空格/非 ASCII；恶意 session id/Markdown 不越权或注入。

### History

- `all/claude/codex/opencode/dsh` filter 校验与错误文案。
- unknown source 不再回退为 Claude。
- DSH title/project/time/model 映射。
- DSH detail 的 message/tool 映射及去重。
- DSH 无 Resume、无 Fork、无 Workspace/Composer 入口；覆盖 DSH filter、All、搜索结果、直接 handler 和后端 `client=dsh`。
- DSH 失败时其他来源仍返回。
- Claude/Codex/OpenCode 的既有错误传播语义不因 DSH 接入改变。
- 1000 条上限、搜索结果和缓存刷新不回归。

### Analytics

- DSH source detection 与 virtual key 稳定。
- first/unchanged/append/rewrite/truncate/removed。
- final usage last-wins、失败 step、缺失 usage、seedLength 排重。
- DSH 与 All 汇总守恒。
- known、unknown、mixed pricing 的 entry/aggregate coverage；mixed 状态展示已知小计与未定价 token，不展示误导性的总成本。
- cache schema 升级与损坏 cache 重建。

### 安全与 IPC

- renderer 无法指定任意 DSH_HOME 或 helper 路径。
- helper argv/stdout/stderr 不出现 credential 内容。
- helper 超时、输出过大、非 JSON、退出码非零均 fail closed。
- 读取前后 session artifact 的 SHA-256、size、mtime 一致。
- 现有 IPC isolation 测试保持通过；不新增给 pet/tray 的宽文件读取能力。
- 所有自动化使用临时 `DSH_HOME`；没有测试读取真实 `~/.dsh`、`~/.ccem` 或用户 credential。
- 安装 tarball 不含所需 root export、DSH closure 版本混用、bundled Node engine 不满足，或只读路径必要资产缺失时均 fail closed；测试同时证明缺少 `koffi` 不影响三种只读 operation。

### CLI provider 投影

- current/named env、tier 去重、显式 model override 与稳定 route id。
- generic Anthropic-compatible projection 保留 endpoint/model 原值；不自动切换厂商原生协议。
- official OAuth-only、缺 token/URL/model 与不满足 Node/DSH 版本 gate。
- fake binary 覆盖 stdout/stderr、0/非 0/signal/ENOENT、cwd、shell 元字符与 patch cleanup。
- conflicting DSH settings 不覆盖所选 provider/model；session 仍落到 active DSH root。
- `inspect/doctor` 全部脱敏，任何输出与错误都不包含 token。

## 7. 预计触碰文件

新文件：

- `apps/cli/src/dsh.ts`
- `apps/cli/src/__tests__/dsh.test.ts`
- `packages/native-runtime-helper/src/dshHistory.ts`
- `packages/native-runtime-helper/test/dsh-history.test.mjs`
- `apps/desktop/src-tauri/src/dsh_history.rs`
- DSH fixture 与 contract tests

现有文件：

- `apps/cli/src/index.ts`
- `apps/cli/package.json`（仅在测试或命令注册确有需要时）
- `packages/native-runtime-helper/package.json`、`pnpm-lock.yaml`
- `apps/desktop/scripts/prepare-native-runtime-sidecar.mjs`
- `apps/desktop/src-tauri/tauri.conf.json`
- `apps/desktop/src-tauri/src/main.rs`
- `apps/desktop/src-tauri/src/history.rs`
- `apps/desktop/src-tauri/src/analytics.rs`
- `apps/desktop/src-tauri/src/ipc_isolation_tests.rs`
- `apps/desktop/src/features/conversations/types.ts`
- `apps/desktop/src/features/conversations/historyData.ts`
- `apps/desktop/src/pages/History.tsx`
- `apps/desktop/src/components/history/HistoryList.tsx`
- `apps/desktop/src/components/history/HistoryDetail.tsx`
- `apps/desktop/src/pages/Analytics.tsx`
- `apps/desktop/src/components/analytics/AnalyticsInsights.tsx`
- `apps/desktop/src/types/analytics.ts`
- `apps/desktop/src/lib/tauri-ipc.ts`
- `apps/desktop/src/pages/Workspace.tsx` 及 workspace source mapping（优先只审计；仅在排除 DSH 需要时修改）
- `apps/desktop/src/locales/zh.json`
- `apps/desktop/src/locales/en.json`
- 聚焦的 Desktop source/behavior tests

## 8. 非目标与后续接口

本期不做：

- CLI 的 DSH 交互式 TUI、resume、fork、会话管理或历史读取；`inspect` 只看脱敏投影，不看 session。
- DSH 实时会话、prompt、cancel、resume、fork。
- Workspace、Dashboard 或 Sessions 页面中的 DSH runtime。
- CCEM 自有 raw object store、archive SQLite、自动 watcher、retention、tombstone。
- 独立 Audit 页面、AI 分析、证据 ZIP、附件闭包。
- 多 `DSH_HOME`、多 profile、远程 DSH host。
- 修改或删除 DSH 源数据。

但 helper schema 保留 `sourceInstanceId`、upstream session id、format/parser version、revision 与 event seq，后续归档可以复用这些稳定事实，不需要重写 History/Analytics 投影。

## 9. 外部依据

- DSH 通用 session persistence seam：<https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/session/session-persistence/README.md>
- JSONL/Zstd physical format 与读取边界：<https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/session/session-persistence-jsonl/README.md>
- Session query 的 list/read/filter 接口：<https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/session-query/session-query/README.md>
- Web session history/export 作为逻辑投影与证据导出的参照：<https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/host/apiproxy/README.md>
- 官方组件 dist-tag 可能暂时错位，必须使用同一精确版本 closure：<https://github.com/deepseek-ai/deepseek-harness/discussions/4222>
- 发布 tarball 的 export/source 完整性风险，禁止依赖 `./src/*`：<https://github.com/deepseek-ai/deepseek-harness/discussions/4288>

## 10. `kiro-rs` 审查修订记录

1. **Resume 类型安全（高）**：已把“隐藏 DSH 按钮”升级为 `selectedSession.source` 能力判断、handler runtime guard 与后端 allowlist 回归测试；All/搜索结果同样适用。
2. **搜索路径（中高）**：明确全局搜索包含 DSH，但任何入口打开的 DSH detail 都是只读能力。
3. **错误隔离语义（中）**：选择只 soft-fail 新增的 DSH helper；不把现有三来源一并改为 partial-success。
4. **instance id 稳定性（中）**：规定 canonicalize + SHA-256 前 16 hex，并写明 root 迁移后的缓存失效语义。
5. **Node 版本（中低）**：明确复用 bundled `ccem-node`，Phase 0 按完整依赖 closure 的最高 engine 要求做 gate。
6. **未定价成本（低）**：规定 entry/aggregate 两层字段与“已知成本 + 未定价 token”展示合同。
7. **资源打包（低）**：把 native/WASM 资产和最终 app bundle smoke 提升为阻塞 gate。
8. **标题/标签 overlay（低）**：明确复用现有 annotation 行为，不把 orphan 清理扩进首期。

## 11. 交付门

只有以下事实全部成立，才能宣称“CLI 模型环境接入与 Desktop DSH History / Analytics 已完成”：

1. `ccem dsh run/inspect/doctor` 的 projection、credential hygiene、shell 安全、版本 gate 与退出语义通过自动化；真实 provider smoke 明确区分已验证与未验证能力。
2. CLI 在临时 active DSH root 创建的真实 session，无导入步骤即可被同一 root 下的 Desktop History 与 Analytics 读取。
3. 官方读取 seam 的只读性和三平台打包已经实证，而不是只看源码。
4. 真实 DSH fixture 在 History 中能搜索、打开、查看工具事件，且没有 Resume/Workspace 入口。
5. 同一 fixture 的 DSH Analytics 与 All 汇总守恒，final usage 和 seed 不重复计数。
6. 未知价格不显示为零成本。
7. DSH helper 失败不会使其他来源消失，同时现有三来源错误语义不变。
8. 最终 app bundle 在三平台都能用 bundled `ccem-node` 加载 helper 的完整依赖/资源。
9. `pnpm verify` 与真实 Tauri Desktop 路径通过，源文件 hash/stat 保持不变。
