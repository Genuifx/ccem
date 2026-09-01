---
name: ccem-release
description: Publish a new ccem release, commit generated release files, or trigger the ccem GitHub Actions release flow for CLI and Desktop.
---

# Ccem Release

只读取发布所需的最小集合：工作区状态、最近语义版本 tag、五处版本源、changeset，以及相关 release/readiness workflow。不要用本地构建成功代替远端交付证据。

发布状态必须按下面的顺序前进：

```text
BASELINE_CLEAN -> CANDIDATE_ON_MAIN -> READY -> TAGGED -> DELIVERED
```

规则：

- 每次发布前都先对账最近 tag 的精确 SHA：Release CLI、Release Desktop、GitHub Release 资产、`latest.json`、npm version 和 `dist-tags.latest`。无论 `main` 后面是否已有新提交，这一步都不能跳过。
- 任一交付缺口都进入 `REPAIR_REQUIRED`。不得继续生成下一个普通 minor/patch，也不得移动旧 tag。修复后只能创建一个明确的 repair release。
- release commit 先单独推到受保护的 `main`，此时绝不创建 tag。
- 在该 commit 的精确 SHA/版本上，必须同时通过 `Mode 2 Signed Readiness` 与 `Release CLI Trusted Publisher Preflight`。run 的 `head_sha`、输入 SHA 和当前 `origin/main` 必须一致；candidate tag 仍须不存在。
- readiness 失败时保留未打 tag 的 release commit，修复同一个候选版本；不得再次 bump。
- 只有 `READY` 才能创建并显式推送不可变 tag。禁止 force-push、移动 tag、用 `--follow-tags` 隐式推 lightweight tag。
- tag 后的 workflow、Release 资产、updater manifest 与 npm 是彼此独立的交付结果，必须分别核验。

默认流程：

1. fetch `origin/main` 与 tags，完成无条件 baseline 对账。
2. 在隔离 worktree 跑本地门禁，生成并 review 下一版本；提交 `chore: release vX.Y.Z`。
3. 再次确认远端没有竞态，只推 release commit 到 `main`。
4. 对精确 release SHA 运行并等待两条 pre-tag readiness；任何 UNKNOWN/FAIL 都不得打 tag。
5. 再次确认 `origin/main` 未前进、candidate tag 在本地和远端均不存在，然后创建并显式 push `vX.Y.Z`。
6. 按精确 tag SHA 核验 CLI、Desktop、GitHub Release/资产、`latest.json`、npm；只在全部吻合时报告 `RELEASED`。

最终报告必须分别列出 candidate commit、main push、两条 readiness、tag push、CLI、Desktop、Release 资产、`latest.json` 与 npm 的实际状态。
