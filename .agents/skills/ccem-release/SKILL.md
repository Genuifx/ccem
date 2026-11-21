---
name: ccem-release
description: Publish a new ccem release, commit generated release files, or trigger the ccem GitHub Actions release flow for CLI and Desktop.
---

# Ccem Release

只读取发布所需的最小集合：工作区状态、最近语义版本 tag、五处版本源、changeset，以及相关 release/readiness workflow。不要用本地构建成功代替远端交付证据。

这是仓库唯一维护的发布流程；`.claude/skills/ccem-release/SKILL.md` 只负责转到本文件。用户指定技能文件路径时，直接读取该文件，不用同名技能替代指定来源。只修复发布阻碍时，可以完成非发布 readiness；不要把修复请求扩展为打 tag 或正式发布。

发布状态必须按下面的顺序前进：

```text
BASELINE_CLEAN -> CANDIDATE_ON_MAIN -> READY -> TAGGED -> DELIVERED
```

规则：

- 每次发布前都先对账最近 tag 的精确 SHA：Release CLI、Release Desktop、GitHub Release 资产、`latest.json`、npm version 和 `dist-tags.latest`。无论 `main` 后面是否已有新提交，这一步都不能跳过。
- 任一交付缺口都进入 `REPAIR_REQUIRED`。不得继续生成下一个普通 minor/patch，也不得移动旧 tag。修复后只能创建一个明确的 repair release。
- release commit 先单独推到受保护的 `main`，此时绝不创建 tag。
- 在候选源码的精确 SHA/版本上，必须同时通过 `Desktop Release Readiness`（`mode2-signed-readiness.yml`）与 `Release CLI` 的 `Preflight npm Trusted Publisher` job。run 的 `head_sha`、输入 SHA 和当前 `origin/main` 必须一致；candidate tag 仍须不存在。
- readiness 失败时保留同一个未打 tag 的候选版本；不得再次 bump。修复提交进入 main 后，候选 SHA 更新为当前 `origin/main`，两条 readiness 都必须验证这个新 SHA。历史版本提交只说明版本来源，不能永久锁定待发布源码。
- 只有 `READY` 才能创建并显式推送不可变 tag。禁止 force-push、移动 tag、用 `--follow-tags` 隐式推 lightweight tag。
- tag 后的 workflow、Release 资产、updater manifest 与 npm 是彼此独立的交付结果，必须分别核验。

默认流程：

1. fetch `origin/main` 与 tags，完成无条件 baseline 对账。
2. 五处版本已经领先 latest tag 时，按下方恢复流程保留该版本；否则在隔离 worktree 跑本地门禁，生成并 review 下一版本，提交 `chore: release vX.Y.Z`。
3. 需要推送新 candidate 时，再次确认远端没有竞态，只推 release commit 到 `main`。已有 candidate 不重复生成或推送。
4. 对当前候选源码的精确 SHA 运行并等待两条 pre-tag readiness；任何 UNKNOWN/FAIL 都不得打 tag。
5. 再次确认 `origin/main` 未前进、candidate tag 在本地和远端均不存在，然后创建并显式 push `vX.Y.Z`。
6. 按精确 tag SHA 核验 CLI、Desktop、GitHub Release/资产、`latest.json`、npm；只在全部吻合时报告 `RELEASED`。

最终报告必须分别列出 candidate commit、main push、两条 readiness、tag push、CLI、Desktop、Release 资产、`latest.json` 与 npm 的实际状态。

## 恢复已升版但未打 tag 的候选

先完成 baseline 对账，再运行 `pnpm release:resume`。命令统一 fetch 现有 `origin/main` / tags，复用 `resolve-release-candidate.mjs` 从当前 main 的五处版本源解析稳定版候选，并核对远端 SHA、baseline tag 和候选 tag 缺席。不会 bump、commit、push、打 tag 或正式发布。输出的 `sourceCommit` 才是本轮候选 SHA，不能用历史最早的 `chore: release` SHA 替代。预发布版本应单独核对通道，不套用稳定版恢复命令。

命令复用当前 SHA 的有效证据、等待已有 pending run，仅调度缺失的 CLI preflight / Desktop readiness，绑定精确 `expected_sha` 与 `expected_version`。完全 skipped 的自动 push 不算 readiness。按最新实质 attempt 选择证据，较新的 pending / failure 不能被旧绿灯掩盖；同一 run 的重跑须按 attempt 时间而非仅 run ID 排序。最后使用 `check-pretag-readiness-runs.mjs` 核验选定 run 的 main、SHA、工作流、事件与当前 attempt 的 required job，并在读取 jobs 后再次检查 attempt 没有变化。

它只输出 `PRETAG_READINESS_VERIFIED`，同时明确 `baselineDelivery: NOT_CHECKED`、`releaseEligible: false`。独立 baseline 交付门禁未完成时，绝不能据此宣称 `READY` 或允许发布。现有独立 tag-time checker 的成功 run 查询入口保持兼容；resume 额外实行最新实质 attempt 选择。完整 CI 不新增为强制发布门禁。

GitHub API 只读请求只对明确的临时网络/HTTP 错误做有限重试，包含响应体中断与异常 cause 链；无效 JSON、权限或证据失败立即停止。失败的工作流不自动重跑：按打印出的精确 run/attempt 用已认证的 `gh run view ... --log-failed` 看真实失败，不能仅凭日志出现 `ENOTFOUND` 就判断整个工作流可安全重跑。匿名日志接口的 403 不证明当前用户没有权限。

不确定 dispatch 只对账远端，不盲目重复 POST。发送前持久保存本地 intent，后续同 clone 的调用先对账它；没有新匹配 run 时保留 intent 并报告 `UNKNOWN_DISPATCH`。旧 SHA 未解决的 intent 也阻止新候选。共享 Git 元数据中的锁防止同 clone/worktree 并发；进程被杀后先核验锁内 host/PID 已结束，只清理锁，不能顺便删除 intent。独立 clone 或其他操作者不受本地锁约束。

main 前进、tag 出现、确定失败或证据不明都停止；不会循环追逐 main，不再次 bump，也不沿用其他 SHA 的 readiness。两小时观察窗口结束仍 pending 时保留真实运行状态，稍后同命令可继续复用。最终任何独立获准的打 tag 动作之前，仍须重新证明远端 main 等于候选 SHA、候选 tag 在本地和远端均不存在，并完成 baseline 对账。

参数、状态、重试边界、intent/锁处理与验证说明见 [非发布恢复命令](../../../docs/integrations/release-resume.md)。
