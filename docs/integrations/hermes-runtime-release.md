# Hermes 组件发行

Hermes 按需从 `Genuifx/ccem` 的固定 GitHub Release 下载。Desktop 编译的默认来源是 `apps/desktop/src-tauri/hermes-runtime-source.json`；公钥复用 `tauri.conf.json` 中已固定的 CCEM publisher/updater 公钥。下载包附带的公钥不能改变信任根。

当前已验证的运行时目标是 macOS arm64、macOS 14 及以上；其他目标仍使用已有的明确不支持结果。

## 发布顺序

1. 更新组件版本与递增 sequence，提交受保护 main。组件 tag 使用纯数字点分版本，例如 `2026.10.2.1`，不触发 Desktop 的 `v*` 发布工作流。
2. 从精确 main SHA 手动运行 `Release Hermes Runtime`。该流程构建 pinned Python、锁定依赖和已审核 Hermes revision，跑搬迁、网关、对话、Skills 检查，再用现有 `TAURI_SIGNING_PRIVATE_KEY` 签名清单。签名步骤使用 Tauri signer 的 `TAURI_PRIVATE_KEY` / `TAURI_PRIVATE_KEY_PASSWORD` 环境变量，不把私钥作为命令参数或发行资产。
3. 发布步骤只接收当前 run 的已验证资产。它拒绝已有 tag，先上传 draft、重新下载验签与核对完整 ZIP，再公开为独立组件 release。`--latest=false` 保证 Desktop updater 的 latest 不变。
4. 组件公开后才跑 Desktop 的 pre-tag readiness / repair release。Desktop producer 强制验证远端清单签名、精确版本和 ZIP 的大小及 Range 支持；缺少组件时停止打包，不能再发行一个安装入口不可用的包。

## 下载与恢复

只允许固定的 `https://github.com/Genuifx/ccem/releases/download/<version>/...` 起点跳转到精确的 `release-assets.githubusercontent.com` HTTPS 官方资产域。临时 CDN query 不进入持久化记录；断点续传仍记录固定 GitHub 地址并校验 ETag/Range。保留现有 30 秒单次 I/O 等待预算，持续传输的大包可超过 30 秒；停滞请求不能阻塞取消达数分钟。

清单及 ZIP 继续经过现有 Minisign、SHA-256、大小、路径安全、兼容版本、搬迁健康检查与原子激活；失败保留原活动运行时。重启租约直接验证本地已落盘的清单、签名及 ZIP，不重新下载远端清单。新下载必须属于当前固定 tag；启动已安装组件只校验当前信任根和已存安装凭据，后续 Desktop 更新来源版本不会禁用已安装的兼容组件。

## 本地检查

```sh
node scripts/hermes/check-release.mjs
node --test scripts/hermes/release-contract.test.mjs
node scripts/hermes/check-release.mjs --published
```

最后一条是正式源可用性检查，组件尚未发布时失败是预期门禁。调试 loopback 测试入口保持只在 debug 编译中存在，不能作为正式发布源替代品。

## 官方协议核对

- [GitHub 的 runner / 网络说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) 明确列出 arm64 的 `macos-15` 和 Release 资产域 `release-assets.githubusercontent.com`。本组件仅适用于已验证的 macOS arm64，不能据此宣称 Intel 或 Windows 已支持。
- [Tauri signer CLI](https://v2.tauri.app/reference/cli/#signer-sign) 使用 `TAURI_PRIVATE_KEY` / `TAURI_PRIVATE_KEY_PASSWORD`；现有 CI secret 名称映射到这两个变量。实际 Tauri CLI 签名已用一次性测试 key 验证，测试 key 无法通过正式 publisher root。
- [GitHub CLI release create](https://cli.github.com/manual/gh_release_create) 支持 `--latest=false`。组件同时标记为 prerelease，以保留 Desktop 的稳定更新入口；公开前重新下载完整资产并验签/hash。
