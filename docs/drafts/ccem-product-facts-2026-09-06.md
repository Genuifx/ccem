# CCEM 功能介绍事实记录

## 快照与范围

- 仓库：`/Users/wzt/G/Github/claude-code-env-manager`
- 检查日期：2026-09-06，快照取证时间 15:52:54 +08:00。
- 分支：`main`；HEAD：`aa433829cc4b1c8fd8411a6cc78b057069ae5036`。
- 初始工作区有未跟踪的 `assets/`、`docs/research/agent-browser-workbench-handoff.md`、`docs/research/ccem-ops-control-tower-optimization-handoff.md`；未作为能力证据，未改动。
- 版本来源：`apps/cli/package.json:3`、`apps/desktop/package.json:3`、`apps/desktop/src-tauri/tauri.conf.json:4` 均为 `2.80.0`；根 `package.json:3` 为 monorepo 的 `2.0.0`，不当作产品交付版本。
- 本地 remote 配置为 `git@github.com:Genuifx/ccem.git`；未查询远端 commit 可取得性，源码证据使用本地路径，不生成远端固定 SHA 链接。
- 用户仅指定技能；据当前仓库选择中文产品介绍草稿，读者为希望了解基本用法的 AI 编程助手用户。成稿见 [产品介绍](ccem-product-introduction-2026-09-06.zh.md)。
- 以当前 HEAD 为唯一基准，不声称这些能力均为近期新增。首轮仅交付草稿；用户随后要求更新 README，落地情况见末节。未安装依赖、构建、启动应用、运行产品命令、提交、推送或发布。
- 检查范围为环境 CLI、工作台创建会话、定时任务、分析页和 Desktop 查询 CLI。远程聊天、浏览器、技能安装、回退、更新器等不在本次能力核验范围内。

## 能力矩阵

下面所有源码定位均绑定上述 HEAD；本次引用的源码没有未提交改动。`implemented` 表示入口、调用链与实现已核对；`released` 和 `observed` 是独立维度。所有行的发布与本轮实测均未证实，既不代表不存在，也不代表失败。

| ID | 用户动作与结果 | 条件 / 限制 | 证据 | implemented | released | observed |
| --- | --- | --- | --- | --- | --- | --- |
| F01 | 添加具名环境并查看列表 | 添加时交互选择预设、填写配置；名称不决定预设 | E01 | 已证实 | 未证实 | 未证实 |
| F02 | 选择环境，输出 shell 设置或带配置启动命令 | 管理 Claude 环境变量；不能自动修改父 shell | E02 | 已证实 | 未证实 | 未证实 |
| F03 | 在 Workspace 选择目录、助手并提交任务以创建会话 | 需要相应运行时及认证；动态路由限 Claude | E03 | 已证实 | 未证实 | 未证实 |
| F04 | CLI 创建、列出、删除定时任务记录 | 五段 cron；默认 cwd；支持暂停创建；创建不等于执行 | E04 | 已证实 | 未证实 | 未证实 |
| F05 | Desktop 创建、编辑、启停任务并查看执行记录 | 自动执行需要后台调度器；按本机时间；开发实例后台服务另有限制 | E05 | 已证实 | 未证实 | 未证实 |
| F06 | 分来源查看用量与价格计算结果 | 依赖可读取记录和价格覆盖；未定价 Token 单独提示 | E06 | 已证实 | 未证实 | 未证实 |
| F07 | CLI 查询 Desktop 健康、会话、状态与有界事件 | Desktop 必须运行，本机鉴权控制端点需可用 | E07 | 已证实 | 未证实 | 未证实 |

## 源码定位

链接定位到关键起始行，随后说明所检查的调用链，供本地审阅。

### E01：添加与列出环境

- [CLI 添加入口](/Users/wzt/G/Github/claude-code-env-manager/apps/cli/src/index.ts:855)：`add <name>` 询问是否使用预设，再选择预设、调用配置问答和 `setRegistries`。
- [配置写入](/Users/wzt/G/Github/claude-code-env-manager/apps/cli/src/index.ts:281)：检查官方环境不变量后写入 `registries`。
- [列表入口](/Users/wzt/G/Github/claude-code-env-manager/apps/cli/src/index.ts:702)：读取环境并输出列表。

### E02：选择与应用环境

- [切换实现](/Users/wzt/G/Github/claude-code-env-manager/apps/cli/src/index.ts:499)：更新 `current` 并提示当前 shell 需要应用导出命令；[命令注册](/Users/wzt/G/Github/claude-code-env-manager/apps/cli/src/index.ts:729)。
- [环境解析](/Users/wzt/G/Github/claude-code-env-manager/apps/cli/src/index.ts:136)：解析 Claude 运行时变量和认证边界；构造 export/unset 输出。
- [env 与 run](/Users/wzt/G/Github/claude-code-env-manager/apps/cli/src/index.ts:985)：前者输出 shell 命令或 JSON；后者在子进程环境中清除受管旧变量、注入当前配置并 spawn。

### E03：工作台会话

- [导航](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src/components/layout/SideRail.tsx:28) 和 [App 挂载](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src/App.tsx:824)：工作台可达。
- [Composer 提交接线](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src/pages/Workspace.tsx:3445) 与 [创建逻辑](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src/pages/Workspace.tsx:2727)：校验提示词、目录，携带 provider 与相关启动参数调用创建。
- [IPC 调用](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src/hooks/useTauriCommands.ts:976)、[注册](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src-tauri/src/lib.rs:5971)、[后端](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src-tauri/src/lib.rs:1324)：分别解析 Claude/Codex 配置，限制非 Claude 路由，于 1476 行调用运行时创建。
- [运行时创建](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src-tauri/src/native_runtime.rs:2379)：准备路由、运行时标识及会话记录，建立 helper 启动参数。此为源码实现证据，不是启动成功回执。

### E04：CLI 定时任务

- [命令组与参数](/Users/wzt/G/Github/claude-code-env-manager/apps/cli/src/index.ts:1035)：list、create、delete；create 支持 `--schedule`、`--prompt`、`--working-dir`、`--disabled`、`--json`。
- [创建实现](/Users/wzt/G/Github/claude-code-env-manager/apps/cli/src/cron.ts:180)：校验必填项与表达式，默认目录为 `process.cwd()`，保存 enabled 状态。
- [存储读写](/Users/wzt/G/Github/claude-code-env-manager/apps/cli/src/cron.ts:56)：`cron-tasks.json`，临时文件写入后 rename；[删除写回](/Users/wzt/G/Github/claude-code-env-manager/apps/cli/src/cron.ts:252)。

### E05：Desktop 定时任务

- [页面接线](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src/App.tsx:789)、[保存处理](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src/pages/CronTasks.tsx:1231)、[启停入口](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src/pages/CronTasks.tsx:1372)、[记录列表](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src/pages/CronTasks.tsx:447)、[详情读取](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src/pages/CronTasks.tsx:942)。
- [IPC](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src/hooks/useTauriCommands.ts:1404)、[后端注册](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src-tauri/src/lib.rs:6053)、[后端增改删与启停](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src-tauri/src/cron.rs:1314)。
- [调度器](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src-tauri/src/cron.rs:1176)：每 30 秒读取任务，按本地时间检查启用的 schedule 任务，按分钟去重后执行。
- [启动条件](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src-tauri/src/lib.rs:6288)：仅在 automatic background services 启用时启动调度器。[后台服务开关实现](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src-tauri/src/dev_instance.rs:25) 默认禁用具名 debug 实例的自动后台服务；本轮未启动实例验证。

### E06：分析

- [页面挂载](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src/App.tsx:783)、[筛选交互](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src/pages/Analytics.tsx:493)、[请求](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src/pages/Analytics.tsx:75)。
- [后端注册](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src-tauri/src/lib.rs:6017)、[聚合实现](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src-tauri/src/analytics.rs:3082)：规范化来源、读取用量缓存及模型价格、聚合统计。
- [费用不完整的处理](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src/pages/Analytics.tsx:557)：采用已知费用标签，并输出未定价 Token 数；不支持“完整账单”的主张。

### E07：Desktop 查询 CLI

- [health 注册](/Users/wzt/G/Github/claude-code-env-manager/apps/cli/src/index.ts:1532)、[sessions/status/events 注册](/Users/wzt/G/Github/claude-code-env-manager/apps/cli/src/index.ts:1598)：events 支持 since 和 limit。
- [传输与条件](/Users/wzt/G/Github/claude-code-env-manager/apps/cli/src/desktopControl.ts:321)：读取控制描述符、检查进程与回环端点，以 bearer token 发送 JSON-RPC。
- [服务端处理](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src-tauri/src/external_control.rs:578)：健康状态来自当前 Desktop；会话列表、单会话状态和事件分别来自 native runtime 的查询与有界回放。

## 旧文档的处理建议与本稿采用的修正

| 现有文案 | 当前证据 | 本稿处理 |
| --- | --- | --- |
| README_zh 功能表把定时任务的 CLI 栏标为“—” | E04 已有结构化管理命令 | 区分 CLI 管理任务记录与 Desktop 执行调度 |
| `ccem add kimi` 的注释容易让读者以为名称自动填好预设 | E01 实际为交互选择预设 | 示例使用自定义名称 work，并明确选择步骤 |
| “Desktop 改了环境 CLI 立刻生效，反过来也一样” | E02 明确要求当前 shell 应用导出命令 | 描述配置选择和子进程注入，不暗示已有进程自动切换 |
| 双引擎段落引导到 Dashboard 启动面板 | E03 当前 Workspace 有直接创建入口 | 改用工作目录 → 助手 → 提交任务的工作台路径 |
| 用量介绍强调费用追踪，未就近解释定价缺口 | E06 存在已知费用及未定价 Token 提示 | 明确可采集、可定价范围，避免完整账单承诺 |
| 竞品对比、“一秒找到”等断言 | 本轮没有外部比较或性能实测证据 | 不纳入本稿；不把未核验表述直接判为错误 |

## 仍影响正式发布的缺口

1. **交付版本未核实**：未查询 npm 包与 Desktop 发布附件，未验证平台、下载或安装。本稿保留现有获取入口，明确其版本可能不同于源码；不能以 package 版本或 main 分支推定已发布。
2. **运行行为未实测**：未发起会话、执行定时任务或核验用户真实用量。后续若改成“亲测可用”或稳定版介绍，需在指定交付版本补对应动作与结果证据。
3. **现有截图未复拍**：本稿链接回旧 README，没有将旧截图作为本轮 UI 证据，也没有改写为全量功能清单。

正式合并 README 前可按上表做局部更新，保留原有安装导航与图片。首轮交付为已保存的介绍草稿及审阅证据；后续 README 落地见下节，未提交或发布。


## 后续落地：已更新中英文 README

用户要求直接更新 README 后，本地修订了 `README.md` 与 `README_zh.md`：环境命令注释及生效边界、CLI 定时任务与 Desktop 查询示例和命令表、Workspace 创建入口、定时调度条件、费用定价缺口，以及源码与下载版本的区别。保留既有图片、安装链接及其余章节；不是对未涉及章节的全量事实背书。

补充核对了定时任务通知出口：

- [执行结束通知](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src-tauri/src/cron.rs:1156) 调用 Telegram 与企业微信通知发送。
- [Telegram 条件](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src-tauri/src/telegram/mod.rs:856) 要求 enabled、bot token 和通知或授权 chat ID，向对应目标发送。
- [企业微信条件](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src-tauri/src/cron.rs:653) 要求任务通知启用，解析明确目标或配置中的默认目标；[发送实现](/Users/wzt/G/Github/claude-code-env-manager/apps/desktop/src-tauri/src/cron.rs:693) 通过 bridge manager 发送并记录错误。

因此将定时任务段落的“Telegram、微信或企微”收窄为已核对出口的 Telegram 与企业微信，并说明配置条件。这不推断产品所有其他路径均不支持微信通知。该主张 implemented 已证实，released 和 observed 仍未证实。

本轮复核：审阅完整 README diff；核对两种语言的新增命令、选项与 CLI 注册；检查原有图片和链接保留、Markdown 代码块配对及 `git diff --check`。未执行示例命令，未创建真实任务或发送消息。上述源码仍绑定原 HEAD；README 修订属于本地未提交改动。
