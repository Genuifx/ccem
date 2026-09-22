# Hermes 托管运行时制品

客户端只接收预构建且经过签名的运行时，不运行 pip、uv、Git 或上游安装脚本。安装器的构造、状态轮询及未安装时的清理均不创建目录或下载内容。当前验证对象为 macOS arm64；其余平台明确返回 `unsupported_platform`。

## 已固定的构建输入

| 输入 | 固定值 |
| --- | --- |
| Hermes | `bc1330eebc0aa8a443501b5f62586eb7361353a5`，声明版本 0.21.0 |
| uv.lock SHA-256 | `6393f09ee88cc5683f0e563306f96b5c068f901a8baa60f7209f302c1ac602d9` |
| 私有 Python | CPython 3.11.16，Astral python-build-standalone 20260901，macOS arm64 install_only_stripped |
| Python 下载字节 | 26,961,472 |
| Python SHA-256 | `768f05cf200273bbdda9a5955a5a6892a4b22f2a0b1e4b0a9160f5c7fce86816` |
| 依赖 | 原始 uv.lock 的 core + wecom + feishu + messaging，固定 wheel 闭包，包含 `aiohttp==3.14.3` 和五渠道 SDK |
| 桥协议 | 1，源码应用 `scripts/hermes/patches/0001-managed-gateway-contracts.patch` |
| 本地组件版本 | `2026.9.23.3`，签名清单 sequence 5 |
| 已审核补丁 SHA-256 | `0caa8b78df6b95a7109ccefa6f00d9018c3f70ac24cb2ee1c76de7af3035cc88` |
| 已打包 host SHA-256 | `fefec0d196ab7f0ec533230c2dababa444ade46e58dafa43c7e14e366e3cc625` |
| 已打包 QR helper SHA-256 | `0cb81f5cbc150dc7538b51665b5677ea93e10030ef04439372acc08f5bf5b668` |

构建使用 Astral 的便携 Python 分发。uv 官方说明其托管 Python 来自该项目；install-only 分发提供完整解释器布局。便携构建仍有兼容性限制，因此构建门包括移动目录后执行真实 Python、host 导入检查、Mach-O 依赖检查，不能用“venv 可运行”代替重定位验证。[uv Python 版本](https://docs.astral.sh/uv/concepts/python-versions/)、[Python 分发结构](https://github.com/astral-sh/python-build-standalone/blob/main/docs/distributions.rst)、[已知兼容性差异](https://github.com/astral-sh/python-build-standalone/blob/main/docs/quirks.rst)。

本机系统 uv 0.9.3 无法解析此 lock 的新配置。验证时使用下载到本次 `.artifacts` 的独立 uv 0.12.12，没有修改系统工具。构建端依赖允许下载；用户组件不会携带 uv，也不依赖用户 PATH 中的 Python/Node/Hermes。Telegram、Discord、Slack 已加入当前依赖闭包；未集成平台仍显示不可用，不能让用户在客户端现场安装 SDK 补足。

上游 `wecom` extra 只增加 XML 依赖，单独导出它不能保证企业微信适配器可用。当前 `messaging` 闭包同时提供共享传输依赖 `aiohttp==3.14.3`，不再需要旧包为此导出的 `sms` extra。扫码 helper 与企业微信连接使用包内传输依赖，扫码 HTTPS 显式使用包内 certifi 根证书，避免依赖构建机的 OpenSSL 证书路径。

包内 `ccem_gateway_onboarding.py` 提供扫码创建协议，由 `ccem_gateway_host.py` 从固定同目录路径加载；两个文件均进入签名文件清单。UI 只有收到平台可用且 `qrSetup=true` 时才显示默认扫码入口，当前为企业微信和 Telegram，手动配置继续保留。成功凭据经私有进程管道交给 CCEM 后端加密保存并连接，再进入私聊口令与桌面工作区授权；扫码不会直接授予任务访问权限。取消、过期及授权边界见 [用户路径](hermes-managed-integration.md#用户路径)。

## 安装与恢复契约

`HermesInstaller::new(root)` 仅建立内存状态。`root` 应为 CCEM 私有组件目录，授权 profile 必须放在其外部。UI 同步调用 `prepare_install()` 领取操作，再将 `PreparedHermesInstall::run()` 移入阻塞执行器并轮询进度，确保 worker 启动前收到的取消不会丢失。同步调用者也可使用 `install()`。关闭设置页面不会取消安装。

复用 `browser/runtime` 的 minisign exact-byte 清单验证、带 ETag/Range journal 的下载器、受限 ZIP 解包、原子激活与版本租约。没有复制另一套弱下载/解包实现。清单校验覆盖签名、平台/架构、最低系统版本、协议、来源、长度、哈希、解压大小与单文件上限；客户端只接受固定发布源的同源 HTTPS 制品，拒绝重定向。下载器允许 30 秒请求并从已持久化位置续传，最多两次退避重试；下载阶段取消最迟在当前有界请求返回后生效。Hermes 使用可取消解包入口，在清单条目、文件及 64 KiB 复制块之间检查取消并清理候选。Browser 的默认下载超时及原有解包入口行为不变。

包内 `runtime.json` 绑定固定 Hermes commit、Python 版本、依赖锁和全部文件 inventory。激活前及每次 gateway lease 前验证签名清单、完整缓存 ZIP 哈希和各已安装文件；验证失败不运行 host。ZIP 解包沿用路径穿越、大小、重复路径、大小写冲突和 symlink 防护。本制品将内部文件链接转换为普通文件，客户端拒绝残余符号链接和非预期文件。

重复安装同一签名清单会重新验证全部文件，通过后保留原指针，不重复解包。已安装 payload 被改写时拒绝启动，并明确要求卸载组件再安装；此路径保留外部授权 profile，不假称可自动修复所有本地损坏。

候选包在私有 staging 解压，真实 Python 以 `-I -B` 运行 `ccem_gateway_host.py --self-test`。自检实际导入企微适配器并检查全部五个托管渠道的依赖和严格投递能力，同时加载 QR helper 和 TLS 根证书；缺少传输依赖会直接失败。健康检查取消/超时会 kill 并 wait 该次自有子进程。成功后才提交版本指针；失败保留之前已验证版本。安装序列水位保留在 `manifest-sequence.json`，卸载不会重置它。已下载断点在进程重启后的状态中显示 `paused`，由用户重试继续，启动应用不会自行恢复下载。

进程管理器通过 `lease_runtime()` 获得 `HermesRuntimeLease`，持有到子进程完全退出。安装激活与卸载遇到被占用版本会失败，不能覆盖运行中的解释器。`remove_runtime()` 只清运行时、候选包与下载缓存，保留水位/租约记录和外部 profile；这与撤销凭证或重置授权是不同操作。

## 制品构建及测试

2026-09-23 的五渠道运行包与当前验收见 [多渠道验收记录](hermes-multichannel-verification.md)。后文 9 月 22 日及更早的测量保留为历史基线。

`scripts/hermes/build-runtime.py --stage prepare` 下载固定 Python，取精确 Git archive，校验原始锁文件，用 `uv export --frozen --extra wecom --extra feishu --extra messaging` 导出哈希依赖并仅安装 wheel。`messaging` 包含 Telegram、Discord 和 Slack SDK，沿用同一份上游锁文件。`--stage finalize` 应用已审核补丁、复制 host 与 QR helper、移动目录运行自检，然后生成 ZIP、文件 inventory、签名清单及构建 receipt。自检实际探测五个托管平台的依赖与严格投递契约，缺少任一项便失败；返回的能力写入签名包身份，安装器不以静态渠道枚举替代完整性检查。`--signing-seed` 指向受限权限的 32-byte Ed25519 构建密钥；本地测试私钥只能留在被忽略的 `.artifacts`，不得提交。

2026-09-22 的扫码版完成重定位自检，包内 host/helper 哈希与当时源码一致。以下命令在当时的实际私有包上通过 4 项回归，不修改包、不连接聊天平台：

```bash
python3 -I -B scripts/hermes/test-runtime-package.py \
  --package .artifacts/hermes-qr-live/runtime-package/hermes-runtime -v
```

| 包门 | 实际断言 |
| --- | --- |
| 私有依赖与 helper | `aiohttp`、certifi 和 QR helper 均来自包内，TLS 证书验证开启 |
| 真实适配器自检 | 包内 Python 运行 host 自检，真实企业微信适配器及 QR helper 可加载 |
| 缺失依赖拒绝 | 仅在测试子进程屏蔽 `aiohttp` 后，同一个自检必须失败，不能靠静态能力声明通过 |
| 真实能力发现 | 无网络初始化 host，通过真实 registry 得到企业微信 `available=true`、`qrSetup=true`，其他平台不声明扫码能力 |

另有 26 项 QR 状态、host 和本地 HTTPS 行为测试通过。使用新包的私有 Python/helper 实际调用官方接口，完成生成二维码、未扫码轮询和本地取消；未扫码响应的 `status` 为字符串 `init`，取消后本地轮询码已清除。该探测未扫码、未创建机器人，也未将二维码地址、轮询码或凭据写入输出或磁盘；不构成真实机器人整链路验收。

生产签名可交给发行系统对最终 `manifest.json` 运行 minisign；Rust 与构建脚本使用兼容的 ED/BLAKE2b 签名格式。本地 fixture 的公开验证向量在 `hermes_installer/fixtures`，不包含私钥。

本地开发服务器 `scripts/hermes/runtime-test-server.py` 只监听 `127.0.0.1`，只暴露清单、签名和版本化 ZIP，支持 Range、ETag 及坏签名/断流/限速/坏包注入。debug 构建须显式设置 `CCEM_HERMES_TEST_MANIFEST_URL` 与 `CCEM_HERMES_TEST_PUBLIC_KEY` 才能使用该签名源。签名清单仍绑定 HTTPS loopback URL；唯一的 HTTP 转换限制在显式 debug loopback 分支。发行构建不读取这些环境覆盖。

普通 Rust 测试不会访问发行源或安装真实运行时。真实制品测试为显式 ignored 测试，使用新的私有 smoke root，覆盖下载、签名验证、真实 Python 自检、激活、租约拒绝清理、保留授权 profile、坏签名、磁盘不足注入、取消、断点、失败保留旧版本。磁盘不足使用仅 debug 的 `CCEM_HERMES_TEST_AVAILABLE_BYTES` 注入，不代表跑满真实磁盘。

2026-09-10 的本地验证通过了 60 项普通 Rust 回归，包括真实 ZIP 文件复制中途取消、完整清理候选、再次解包成功；另外显式运行的 2 项真实制品测试均通过。一次新目录机制回归实际完成签名下载安装、自检、原子激活、同包重装、被改写 host 拒绝启动及保留授权卸载，耗时 358 秒。这是下面预检性能修复之前的历史耗时，包含完整解包、重复全量校验与磁盘采样，并非单次 gateway 启动时间，也不代表 2026-09-22 扫码版的 Desktop 验收。

真实 Desktop 首次安装曾超过 7 分钟且候选目录仍空；对自有进程采样后，449/454 个相关采样落在 `preflight_archive → reject_tree_conflict → Iterator::any`。原因是每个文件对已见路径做全表扫描，29,539 个文件使该预检达到平方量级。现在用 BTreeMap 中 `path/` 前缀的有序下界查询检查后代，保留父文件先/后于子项、目录项、相邻前缀及 symlink 类型的冲突语义。新的 30,001 条目 ZIP 预检回归实测 466 ms，普通套件 60 项通过；这是合成大清单的性能回归，优化后的真实 Desktop 安装总耗时须由主流程重试记录。

| 2026-09-22 扫码版 macOS arm64 制品 | 实测值 |
| --- | --- |
| ZIP 下载 | 165,153,675 B（157.5 MiB） |
| 解包普通文件逻辑大小 | 401,496,607 B（382.9 MiB），29,733 个文件 |
| SHA-256 | `f086dba1e01bd6b1d9ac98853e0ddb7618f6bcba46abc91ce9d6b9825d6b4fcd` |
| 下载缓存 + 解包逻辑大小 | 566,650,282 B（540.4 MiB），缓存保留供启动完整性复核 |
| 按 4 KiB 分配单元计算的首次安装空间门槛 | 877,340,074 B（836.7 MiB），含目录/小文件舍入及 64 MiB 余量 |
| 原生加载检查 | 115 个 Mach-O 文件；没有 `/usr/lib`、`/System/Library` 以外的绝对加载依赖；实际最高最低系统版本 11.0，兼容清单保守要求 14.0 |

初版的一次新目录机制测试每 2 秒扫描，165 个采样中观察到逻辑峰值 562,616,209 B、普通文件分配峰值 640,573,440 B（610.9 MiB）。这是旧包的采样观察值，排除文件系统元数据及原有构建目录；处理了 6 次激活/清理时的扫描竞争，不能当作 APFS 独占物理占用或瞬时绝对峰值，也没有覆盖保留旧版本的完整升级峰值。扫码版增加了传输依赖与 helper，上表取自新构建 receipt，没有将初版峰值改标为新包实测。

新包证据：`.artifacts/hermes-qr-live/runtime-package/build-receipt.json`、`.artifacts/hermes-qr-live/runtime-build.log`。历史证据位于 `.artifacts/hermes-implementation/`：`runtime-package-final/build-receipt.json`、`installer-real-package-tests.log`、`installer-final-package-test.log`、`installer-final-package-measurement.json`、`extractor-preflight-regression.log`、`managed-live/install-profile.txt`。包保留完整 Hermes 跟踪源码与锁定依赖，没有宣称已完成最小体积裁剪；不能用本地开发 venv 的大小代替以上数据。

## 发行边界

当前没有虚构生产下载地址或发布信任根。发行构建须由 CCEM 发行流程在编译期提供固定的 `CCEM_HERMES_RUNTIME_MANIFEST_URL` 和 `CCEM_HERMES_RUNTIME_PUBLIC_KEY`；缺少任一项就返回 `source_not_configured`，不能退回任意来源或用户 Hermes。生产资产还须完成 Apple Developer ID 签名、公证与实际托管验证。本地 minisign 测试包不是已经上线的生产发行包。

多次成功升级后的自动历史版本/缓存裁剪尚未实现；当前保留已验证历史及其缓存，显式卸载可以清理。完整升级峰值、生产更新调度与签名有效期/撤销策略也未由这次本地测试证明，不能把首次安装与坏更新保留旧版的回归扩写为这些能力已经交付。

Hermes LICENSE、NOTICE、`python/lib/python3.11/LICENSE.txt` 和依赖 dist-info license 文件保留在组件中。完整本地制品、构建 receipt 与安装测试证据存于 `.artifacts/hermes-implementation` 和 `.artifacts/hermes-qr-live`，不将大 ZIP 或密钥提交到 Git。真实新机器人配对、查询、确认执行和完成通知已由 [扫码现场验收](hermes-qr-verification.md) 单独验证；该结果不代替生产签名、公证和发行验证。
