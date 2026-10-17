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

先完成 baseline 对账，再运行 `git fetch origin main --tags` 和 `node scripts/ci/resolve-release-candidate.mjs`。这个只读命令从当前 `origin/main` 的五处版本源解析稳定版候选，核对远端 SHA、baseline tag 和候选 tag 缺席；不会 bump、commit、push、打 tag 或证明 readiness 已通过。输出的 `sourceCommit` 才是本轮候选 SHA，不能用 `git log` 找到的最早 `chore: release` SHA 替代它。预发布版本应单独核对其通道，不套用稳定版恢复命令。

自动触发只匹配 release commit message，普通修复提交上的 skipped run 不代表门禁成功。缺少当前 SHA 的成功证据时，使用输出中的精确 `sourceCommit` / `version` 调度两条非发布工作流：

```bash
gh workflow run release-cli.yml --ref main -f expected_sha="$CANDIDATE_SHA" -f expected_version="$VERSION"
gh workflow run mode2-signed-readiness.yml --ref main -f expected_sha="$CANDIDATE_SHA" -f expected_version="$VERSION"
```

记录新 run ID，等待真实结论；同时验证 required job `Preflight npm Trusted Publisher` / `Confirm Desktop Release Readiness` 成功。复用 `scripts/ci/check-pretag-readiness-runs.mjs` 检查精确 SHA、工作流、main、push/dispatch 事件和当前 attempt 的 required job，不能只看 workflow 总体绿灯或借用其他 SHA 的结果。最终打 tag 前仍须重新证明远端 main 等于候选 SHA，候选 tag 在本地和远端均不存在。

失败时优先用已认证的 `gh run view <run-id> --log-failed` 读取日志；匿名日志接口的 403 不证明当前用户没有权限。若是证据上传 `ENOTFOUND` 等临时基础设施错误，在重新核对当前 SHA 后最多补跑一次非发布工作流；重复失败则保留候选并报告实际错误。main 前进后重新解析并验证新 SHA；本轮再次前进则报告竞态，不循环追逐 main，也不沿用旧 readiness。
