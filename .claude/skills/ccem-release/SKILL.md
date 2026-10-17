---
name: ccem-release
description: Publish a new ccem release, commit generated release files, or trigger the ccem GitHub Actions release flow for CLI and Desktop.
---

# Ccem Release

先读取并遵循 [唯一发布流程](../../../.agents/skills/ccem-release/SKILL.md)，即仓库根目录的 `.agents/skills/ccem-release/SKILL.md`。本入口不维护另一套发布步骤。

尤其是恢复已升版但未打 tag 的候选：保留版本，以当前 `origin/main` 的精确 SHA 重新验证两条 readiness；历史 bump commit 不锁定候选源码。只有 baseline 和当前 SHA 的门禁都通过，且用户请求包括发布，才进入打 tag / 交付阶段。
