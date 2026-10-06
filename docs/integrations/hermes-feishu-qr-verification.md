# 飞书扫码创建验收

2026-09-25，分支 `codex/hermes-integration-phase0`。补齐此前飞书只有手动入口的遗漏；[Hermes 官方文档](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/feishu/)及固定源码 `bc1330e` 都已支持扫码创建。

## 行为与边界

选择飞书默认进入扫码创建，保留手动 App ID / App secret。二维码来自官方 Feishu/Lark launcher；只向固定 accounts 域名发送表单请求，不跟随重定向。按官方间隔轮询，`slow_down` 延长间隔；兼容真实 `expires_in` 和旧 `expire_in`，本地最长等待 300 秒。

取消、刷新、切换渠道或到期后，迟到凭据不能创建连接。App ID、App secret、区域必须完整，区域只能为 `feishu/lark`，同时支持手动配置的区域校验。扫码返回的 `open_id` 不生成授权；继续要求私聊配对和桌面工作区批准。状态与错误不包含 device_code 或 App Secret。

## 自动化验证

- 私有 Python：`-I -B -m unittest discover -s scripts/hermes -p 'test_*onboarding.py'`，47 项通过。包含真实本地 HTTPS 表单、400 pending、429/slow_down、重定向拒绝、Lark 同次返回凭据、间隔、取消/替换迟到结果、过期、完整字段及公共状态脱敏。
- `cargo test --locked hermes_bridge:: --lib`，56 项通过，包含飞书官方 URL/参数和完整区域凭据验证，以及既有独立连接、授权、启动、取消回归。
- `node --test test/hermes-panel-dom.test.mjs`，64 项通过。新增飞书默认扫码、二维码渲染、到期重试、切换手动前取消、Secret 密码输入框以及不自动批准配对的行为覆盖。
- `test-gateway-host.py` 11 项、真实 pinned host `test_ccem_gateway_host.py --source ...` 4 项、私有运行包 `test-runtime-package.py --package ...` 5 项通过；运行包实际发现飞书 `qrSetup=true`，非法区域在真实 host 启动适配器前被拒绝。文件长度与 diff 空白检查通过。
- 独立复审无阻塞 findings，审查员单独运行飞书 8 项协议测试通过。

系统 `/usr/bin/python3` 缺少 aiohttp，因此 HTTPS 验证使用制品内 Python，不安装或修改系统依赖。

## 真实接口与制品

新的签名测试运行包为 `2026.9.25.1 / sequence 6`，沿用原固定 Hermes 源码、依赖闭包、测试密钥和完整性校验。构建经过目录重定位自检与原生依赖审计。

使用新包内 helper 真实请求官方接口，`begin=waiting → poll=waiting → cancel=cancelled`，取消后私有轮询能力已清除。没有扫码、创建飞书机器人或接收真实账号凭据。脱敏记录：`.artifacts/hermes-multichannel/feishu-helper-proof.json`。

## 开发版实际操作

使用本工作树的规范 `pnpm tauri:dev` 启动器，精确连接 manifest 的 MCP `57700`、标识 `com.ccem.desktop.dev.idedbe6da`。在原隔离状态目录通过界面更新组件，完整解包校验后激活 `2026.9.25.1`。

- 渠道卡片显示「飞书 · 扫码创建或手动连接」，选择后默认扫码，不显示凭据表单。
- 实际点击生成，官方 `open.feishu.cn` 二维码渲染为 208 × 208 SVG，后台与界面都进入 `waiting`，继续轮询无错误。
- 点击手动连接后状态变为 `cancelled`，二维码消失，App ID / App secret / 可选区域出现，Secret 使用密码输入框。
- 使用合成值提交非法区域，后台返回 `invalid_channel_field`，连接及授权数量不变。重新扫码后旧错误清除；再次生成与刷新均产生新的 setup 会话，最终取消并移除界面二维码。
- 最终仍只有原企微连接，状态 `running`，原授权一条；没有创建或保存飞书账号。

脱敏证据在 `.artifacts/hermes-multichannel/feishu-desktop-proof.json`；源码与包内 host/helper 的哈希一致性记录在 `feishu-source-package-proof.json`。截图 `ui-feishu-qr-20260925.png` 是真实 WebView 的接入面板 DOM 捕获：原生截图接口因窗口不活跃/超时失败，改用应用已有的 `modern-screenshot` 捕获实际渲染节点，未替换 IPC、二维码数据或界面文案。截图里的测试码已取消。

本轮不把二维码生成或合成响应测试等同于真实飞书账号收发验收；未合入、未 push、未正式发行。
