# Workspace: 从某个模型输出 turn 分叉新建会话

## 需求

Workspace 会话视图中，从某个模型输出的 turn 分叉出一条新会话：新会话携带截至该 turn 的完整对话历史，输入第一条消息后继续对话；原会话不受任何影响。

## 方案（已实证）

用 Agent SDK **standalone `forkSession(sessionId, { upToMessageId, dir })`**（0.3.220 已内置，`sdk.d.ts` L700-718）：纯本地 transcript 切片复制，返回新 sessionId，零模型调用。新 runtime 以普通 `resume: forkedId` 启动 —— 复用最成熟的 resume 路径。

被否决的备选：
- `query({ resume, resumeSessionAt, forkSession: true })`：fork 时刻必须立即消耗一次模型调用；CLI 2.1.223+ 对截断式 resume 有 `resumeDropsTurn` 校验而当前 0.3.220 缺该选项，边界可能被拒。
- Rust 手工截断 `~/.claude/projects/*.jsonl`：重复实现 SDK 能力，且每行 `sessionId` 需重写，弃。

边界（SDK 文档明确）：fork 只分叉对话历史，不回退文件系统（文件回退已有 checkpoint 功能，互不混淆）。第一版 Claude native 会话 only（live + history 两个视图都支持）；codex 不显示入口。

## 关键链路（侦察结论）

- 前端已有完整模板：`runContinueHistorySession`（Workspace.tsx:2568）= `createNativeSession({ providerSessionId, seedBoundaryMessageCount, seedMessages })` + `upsertLiveSessionEntry` + 切 live 视图。fork 只是多两个参数 + seed 前缀切片。
- helper `Init`（index.ts:55）已有 `provider_session_id`；`buildClaudeQueryOptions` 只传 `resume`。fork 在 Init 处理时先调 `forkSession()` 再走原路径。
- **缺口**：live 会话的 assistant turn uuid 是合成的 `assistant-turn-<seq>`；helper `assistant_chunk` 事件没透传 SDK `message.uuid`（handler 里可得，index.ts:2389）。
- per-turn 动作入口：`MessageMetaBar`（WorkspaceMessageBubble.tsx:1181-1304），memo comparator 只比较 message，callback 需 stable。
- history 模式消息自带 provider uuid（ConversationMessageData.uuid），直接可用。

## 阶段

### Phase 0 — Spike：实证 forkSession 原语（~15min）
用本机既有 transcript（`~/.claude/projects` 任一会话文件）+ 安装的 SDK 跑一次性 node 脚本：`forkSession(id, { upToMessageId: 文件中某个 assistant uuid, dir })` → 断言新文件只含截至该 uuid 的行、`getSessionMessages(newId)` 可读、原文件字节不变。
**停止条件**：原语行为与文档不符（切片不含端点/新文件不可读）→ 回到方案选型。

### Phase 1 — helper：Init fork 支持 + assistant uuid 透传
- `packages/native-runtime-helper/src/index.ts`：
  - `Init` type 增 `fork_session?: boolean; fork_at_message_id?: string | null`
  - Init 处理：`fork_session && provider_session_id` → `await forkSession(providerSessionId, { upToMessageId, dir: working_dir })` → `currentProviderSessionId = forked.sessionId`，emit `session_meta`（新 id）；失败 emit 结构化错误
  - `assistant_chunk` 事件 payload 增 `message_uuid`（取 `message.uuid`，可空）
- 测试：`packages/native-runtime-helper/test/fork-session.test.mjs`（mock forkSession 或用 fixture transcript）

### Phase 2 — Rust：命令参数 + payload 字段
- `event_bus.rs`：`AssistantChunk` 增 `message_uuid: Option<String>`（`#[serde(default, skip_serializing_if)]`，旧事件兼容）
- `native_runtime.rs`：`NativeSessionOptions` + `HelperInputCommand::Init` 增 `fork_session` / `fork_at_message_id`；provenance `source_session_id` 记父会话
- `main.rs`：`create_native_session` 增 `fork_from_message_id: Option<String>`，透传；claude-only 校验
- 聚焦测试：native_runtime 选项透传 + ipc_isolation

### Phase 3 — 前端：uuid 投影 + fork 入口 + 对话框
- `tauri-ipc.ts`：命令参数 + `assistant_chunk` payload 类型
- `useTauriCommands.ts`：`createNativeSession` 增 `forkFromMessageId?`
- `workspaceEventTranscript.ts`：pending turn 记录 `messageUuid`，flush 时 `ConversationMessageData.uuid = messageUuid ?? synthetic`
- `WorkspaceMessageBubble.tsx` `MessageMetaBar`：assistant turn 且有真实 uuid 且 provider=claude 时显示 fork 按钮（stable callback prop `onForkTurn`）
- 新组件 `components/workspace/WorkspaceForkDialog.tsx`（shadcn Dialog + Textarea，遵循设计 token）：显示分叉点摘要，输入新会话第一条消息，提交 → `createNativeSession({ providerSessionId: 父, forkFromMessageId: uuid, initialPrompt, seedBoundaryMessageCount: idx+1, ... })` → `upsertLiveSessionEntry(seedMessages: messages.slice(0, idx+1))` → 切 live
- live 视图（WorkspaceNativeSessionView）与 history 视图（WorkspaceConversationDetail → 经 Workspace.tsx `runForkFromTurn`）各自接线
- `locales/zh.json` / `en.json`：`workspace.forkTurn.*`

### Phase 4 — 验证 + 审查 + 交付
- `pnpm --filter @ccem/native-runtime-helper test && build`；`cd apps/desktop/src-tauri && cargo test native`（聚焦）；`pnpm --filter @ccem/desktop build`
- 真实路径：`pnpm tauri:dev`（dev app identity）+ Tauri MCP：建会话跑 ≥2 turn → 对 turn 1 点分叉 → 输入第一条消息 → 断言：新会话出现在 live 列表并激活、transcript 显示 turn-1 前缀 + 新 turn、原会话内容不变、`~/.claude/projects` 出现新 session 文件且原文件未动。截图。
- 审查修复循环（对照 review-gates）→ pathspec commit → 交付报告。

## 触碰文件清单

helper: `index.ts`、`test/fork-session.test.mjs`(新)
Rust: `event_bus.rs`、`native_runtime.rs`、`main.rs`
前端: `tauri-ipc.ts`、`useTauriCommands.ts`、`workspaceEventTranscript.ts`、`WorkspaceMessageBubble.tsx`、`WorkspaceForkDialog.tsx`(新)、`Workspace.tsx`、`WorkspaceNativeSessionView.tsx`、`WorkspaceConversationDetail.tsx`、`locales/{zh,en}.json`

## 回滚 / 停止条件

- 每阶段独立 checkpoint commit，可单独 revert。
- Phase 0 spike 证伪 → 停，重选方案。
- SDK `forkSession` 在真实 transcript 上行为异常（不可 resume / 切片错位）→ 停，整理证据升级为 SDK 兼容性问题再定。
- tauri:dev 自测若遇环境阻塞（API 不可用），用 spike 的本地 transcript 验证 fork 语义 + 单测覆盖 IPC 链路，明确标注未验证边界。

## 非目标

- 不做 codex/opencode 分叉；不做文件系统回退（checkpoint 已有）；不做原会话内 rewind；不做分叉谱系 UI（provenance 已记录，后续可做）。

## 附：外部调研记录（交付后补全行业案例腿）

原语选型阶段已查官方文档（Agent SDK sessions 页、TS SDK 参考、changelog 版本核对 0.3.220↔CLI 2.1.220）并本地实证 spike；行业案例腿为交付后补查，结论与已交付设计吻合：

| 方案 | 适用前提 | 主要风险 | 来源 |
|---|---|---|---|
| SDK `forkSession(id, {upToMessageId})` 本地切片（已采用） | SDK ≥0.3.220；切点需真实 assistant uuid | 依赖 SDK 私有文件布局（已实证） | sdk.d.ts + 官方 sessions 文档 |
| `query({resume, resumeSessionAt, forkSession})` | fork 时愿付一次模型调用 | CLI 2.1.223+ 的 resumeDropsTurn 校验当前缺失，可能被拒 | 同上 changelog |
| Rust 手工截断 JSONL | 无 | 需重写每行 uuid/sessionId，重复造轮子 | — |

行业案例：
- LibreChat fork：per-message 入口 → 新会话 + 复制前缀 + 原会话不动（与本案一致）。UX 差异：LibreChat 为"先分叉后输入"，本案为"输入第一条消息后分叉"（受 create_native_session 必填 initial_prompt 约束）——若演进为前者，helper 的 ensureClaudeSession 无 prompt 路径可用。来源：https://www.librechat.ai/docs/features/fork 、https://github.com/danny-avila/LibreChat/discussions/2908
- Claude Code /rewind：每次 rewind 自动创建 conversation fork 而非截断原件，社区反向求"不要 fork"（#9279）——印证"fork 不动原件"是默认安全语义。来源：https://code.claude.com/docs/en/checkpointing 、https://github.com/anthropics/claude-code/issues/9279

过程教训：官方原语解决了"怎么分叉"，但 UX 形态（"先分叉还是带输入分叉"）本应在实现前查行业案例定夺——本次该腿跳过得过早，止损规则被用得过激。
