# CCEM：把环境、编程会话和重复任务放到一起

> 基于当前源码的待发布介绍草稿。核对日期：2026-09-06；源码版本字段为 2.80.0。本稿描述当前 checkout 的实现，尚未核实对应下载交付物，也未进行本轮应用实测。

在不同项目之间切换 AI 编程助手，常常还要切换服务地址、模型配置和工作目录。任务一多，又需要知道哪些会话在运行、定时任务有没有执行，以及用量来自哪里。

CCEM 提供 CLI 和 Desktop 两个入口：在终端管理环境，在桌面工作台创建 Claude Code 或 Codex 会话，也能用命令查询正在运行的 Desktop。下面按五个使用场景介绍当前源码支持的能力。

## 给不同服务保存环境配置

用 `ccem add <name>` 新建一个具名环境，按提示选择预设并补全配置；随后用 `ccem ls` 查看列表、用 `ccem use <name>` 选择当前环境。环境名称由你决定；可以选用预设，也可以自行填写配置，名称不会自动确定服务商。

例如，保存一个名为 `work` 的环境后，可以这样使用：

```bash
ccem add work
ccem ls
ccem use work
ccem run claude
```

`ccem run` 会把所选环境应用到它启动的命令。已有终端不会因切换配置而自动获得新的环境变量；要在当前 shell 应用配置，可执行：

```bash
eval "$(ccem env)"
```

这些环境命令管理的是 Claude 相关连接配置。使用前需要准备好对应服务的凭据，以及要运行的编程助手。

## 在工作台发起 Claude 或 Codex 任务

打开 Desktop 的 Workspace，选择工作目录和 Claude/Codex，输入任务并提交。工作台把所选目录、提示词和相关启动设置交给对应运行时，创建编程会话。

这适合把“在哪个项目工作”和“让哪个助手执行”放在同一个入口完成。两种助手有各自的配置解析和启动逻辑，需要相应运行时与认证配置可用，不能假设 Claude 的全部选项都适用于 Codex。例如，当前动态路由仅适用于 Claude 会话。

## 把重复工作保存为定时任务

在 Desktop 的定时任务页面，可以填写任务提示词、工作目录和五段式 cron 表达式，创建或编辑任务；也可以启停任务、查看运行记录与详情。运行记录用于核对实际执行情况，保存成功本身不代表任务已经跑完。

偏好脚本操作时，CLI 也提供 `ccem cron create`、`ccem cron list` 和 `ccem cron delete`。例如，先保存一个暂停状态的工作日检查任务，审阅后再到 Desktop 启用：

```bash
ccem cron create --name weekday-review --schedule '0 9 * * 1-5' \
  --prompt '检查当前项目并总结需要关注的问题' \
  --disabled --json
ccem cron list --json
```

未指定工作目录时，这条创建命令使用当前目录。CLI 负责保存任务，自动执行依赖正在运行且启用了后台服务的 Desktop 调度器，按本机时间匹配计划。

## 查看用量，也看清费用统计的范围

Desktop 的分析页提供 Claude、Codex 等来源筛选，汇总可读取的用量记录，并结合模型价格计算费用。你可以分别查看不同来源，也可以查看汇总数据。

价格数据不完整时，界面会将总费用标为已知费用，并显示未定价的 Token 数。因此，这里的金额用于了解已采集、已定价的用量，不应直接等同于服务商的完整账单。

## 从终端查看 Desktop 会话

Desktop 运行且本地控制端点可用时，可以直接在终端检查连接、列出工作台会话，再读取某个会话的状态和事件：

```bash
ccem desktop health --json
ccem desktop sessions --json
```

取得会话的 runtime ID 后：

```bash
ccem desktop status <runtimeId> --json
ccem desktop events <runtimeId> --since 0 --limit 50 --json
```

这组入口适合把会话检查接入自己的脚本。它查询本机正在运行的 Desktop；安装 CLI 本身不会提供一个独立的桌面会话服务。

## 获取与进一步阅读

CLI 包名为 `ccem`，仓库保留了 `npm install -g ccem` 和 `npx ccem` 的安装入口；Desktop 下载入口见 [GitHub Releases](https://github.com/Genuifx/ccem/releases)。安装到的版本及平台附件应以实际取得的交付物为准，本稿尚未验证它们与当前源码一致。

现有 [中文 README](../../README_zh.md) 保留了截图和更广泛的功能介绍。本稿只覆盖上面五个场景；逐项源码定位、旧文案修正和发布缺口见 [事实记录](ccem-product-facts-2026-09-06.md)。
