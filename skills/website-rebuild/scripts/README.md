# scripts/ - 网站采集、分析与验证脚本

脚本使用 Node 22+ 的内置模块及本地共享模块. 部分分析脚本通过 `npx` 调用固定版本的 Acorn、js-beautify 等工具, 离线运行需要预先存在的 npm 缓存. `tools/` 的 AST 变换另有开发依赖, 见 [tools/README.md](../tools/README.md).

## 端口与实例身份

`lib/ports.mjs` 按下式分配默认端口:

```text
port = 21000 + slot * 1000 + lane * 10 + side
```

- `slot` 为 0-8, 由工作区路径散列选择; 散列可能冲突, 可用 `WRS_PORT_SLOT` 指定.
- `lane` 为脚本角色编号, 定义在 `LANES`; 10-49 预留给项目检查, 50-99 供项目自行分配.
- `side` 区分镜像、复刻和在线目标: `1=mirror`, `2=rebuild`, `3=live`, `0=unspecified`.
- `--port`、`--cdp-port`、`PORT`、`CDP_PORT` 可覆盖默认值. 已占用端口报错并退出 3.
- CDP 连接通过随机 sentinel 页面核对实例; `serve.mjs` 提供 `x-wrs-identity` 和 `/__wrs/identity`. `pixelcompare.mjs` 拒绝把同一来源或同一服务 token 当成两个独立比较侧.

```bash
node scripts/lib/ports.mjs
node scripts/lib/ports.mjs 25012
```

shopifydesign 的案例中, 前台探针连接了后台比较脚本的浏览器, 报告 19 次指向镜像端口的外联. 端口分配减少冲突, 实例身份校验用于发现连接错误; 二者都不能仅凭端口号推断服务内容.

## 浏览器进程与 CDP 传输

`lib/chrome.mjs` 使用独立进程组启动 Chrome, 在正常结束和可处理的退出信号上清理进程组与临时 profile. `SIGKILL` 无法被捕获; 下次启动会检查本工作区同角色的孤儿进程. 孤儿识别依赖进程信息与本工具的 profile 命名, 不代表所有浏览器进程的通用清理器.

```bash
node scripts/lib/chrome.mjs
node scripts/lib/chrome.mjs --all
node scripts/lib/chrome.mjs --reap
```

objectandarchive 曾记录 129 个残留 Chrome 进程、约 16 个 profile, 最长存活 2 天 1 小时, 系统 load average 为 8.7. 背景负载可能改变重复截图的差异分布, 应在可比负载下测量像素容差.

截图通过 CDP WebSocket 以 base64 传输. 超大消息可能造成连接关闭或调用超时; 客户端拒绝未完成调用并报告传输错误. 下列数据是特定机器上的观察, 不是协议上限:

| 截图 | base64 字符数 | 观察结果 |
|---|---:|---|
| 1280x800 PNG | 2,395,616 | 成功, 280 ms |
| 390x844 PNG | 734,240 | 成功 |
| 1728x1080 JPEG q100 | 1,995,384 | 成功, 106 ms |
| 1728x1080 JPEG q92 | 827,968 | 成功, 58 ms |
| 1728x1080 PNG | 约 3.6M | close 1006 |

该机观察到的边界在 2.40M-2.72M 之间. 另一台 Chrome 150 / Node 22 环境可接收入站 3.33M、发送出站 4.37M, 约 7M 的噪声 PNG 仍失败. 不应将 2.4M 当作跨版本保证值.

`probe.mjs`、`pixelcompare.mjs` 支持 `--format png|jpeg|webp --quality N`. 有损格式适用于按同一编码参数进行的视觉指标比较; 需要原始像素保真时使用 PNG 或直接读回像素. `pixelcompare.mjs` 的指标计算还会把两帧嵌入一次 `Runtime.evaluate`, 其消息大小可能超过单帧截图.

## 镜像验证

`verify-mirror.mjs` 检查 URL 映射、清单与磁盘一致性、类型和挑战页特征、已发现引用的完整性, 并可选回源抽样. 这些检查不能替代引用发现覆盖分析, 也不能证明所有 HTTP 200 响应都具有预期内容.

objectandarchive 的记录包括查询变体映射冲突、转义 URL 漏提取、豁免前缀过宽及文本类型漏识别. 纳入 16 份 `.atom` 后, 引用数从 3,109 增至 3,521. 另一次 3 workers 抓取保存了 43 份挑战页; 清单哈希一致仍未发现内容错误, 构建变换命中数 4 低于要求的 5 才暴露问题. 现有真实性检查采用挑战页特征和 Content-Type/魔数比对, 文件体积异常仅作为诊断线索.

路径与引用规则由 `lib/urlpath.mjs`、`lib/extract-refs.mjs` 共享. 共享规则避免两侧解释不一致, 也可能带来共同漏检, 因此仍需用独立样本核实发现集合.

## 命令行约定

独立 CLI 使用 `lib/cli.mjs`: `--help`/`-h` 输出文件头部说明与选项清单, `--version` 输出 skill 版本, 未知长选项退出 2. 参数取值与必填校验由各脚本完成. 各脚本并未统一支持 `--key=value`, 示例使用 `--key value`. 库、配置样例和浏览器注入脚本不都支持独立 CLI 调用.

## 退出码约定

| 码 | 含义 | 主要使用位置 |
|---|---|---|
| 0 | 检查通过或任务完成; 部分工具会明确报告 SKIPPED | 全部 |
| 1 | 检查失败或数据读取失败 | verify-* 等 |
| 2 | 参数、输入或配置错误 | CLI 与各脚本 |
| 3 | 端口占用或实例身份不符 | ports 与 CDP 启动逻辑 |
| 4 | CDP 传输失败或超时 | probe / pixelcompare |
| 5 | 前置条件不满足, 如无法识别容器、无检查输入或空帧 | 分析与验证脚本 |
| 6 | 页面未达到要求的状态 | pixelcompare / pixel-walk |
| 130 | SIGINT 中断, 爬虫已尝试保存清单 | mirror-site |

具体错误仍以脚本输出为准, 不将退出 0 的 SKIPPED 记录作为覆盖证据.

## 脚本索引

一行一个脚本.**这张表回答"选哪个";"怎么跑"由脚本自己回答**--每个脚本的完整规格(选项, 断言, 语义)住在它的文件头注里,`node scripts/<x>.mjs --help` 原样打印;**为什么这么设计**的实证见 [references/case-studies/scripts.md](../references/case-studies/scripts.md).三处各归一处: 表里不再复述头注, 头注不再讲故事.

| 脚本 | 用途 | 阶段 | 出处 | 验证记录与限制 |
|---|---|---|---|---|
| `scripts/fingerprint.mjs` | 采集 GET 响应, 重定向, 两次采样与 bundle 标记; 跟随一次短 ESM 导入 | Step 0 | landonorris, lamalama 等探测记录 | 不自动判级; 小响应, 重定向后的导入与 sourcemap 需结合内容判断 |
| `scripts/mirror-site.mjs` | BFS 爬虫镜像: 资产白名单迭代到不动点, 三本账逐文件 sha256 | M0 第一遍 | lando 版(rogier→noomo→lando→shopifydesign→objectandarchive 五代演进) | 已有项目使用记录 |
| `scripts/wayback-mirror.mjs` | X 类存档恢复: 把失效站点从 Wayback 抢成标准镜像 | M0(X 类失效站点存档恢复) | darknetflix/umamiland 版(v0.2.4) | 已记录(两个失效站点实跑:312+123 文件, 0 抓取失败, 缺失资源记录如实) |
| `scripts/netcapture.mjs` | 真实浏览器 CDP 抓包, 对账补录运行时资源(CDN 站必传 --hosts) | M0 第二遍 | kimi 版(+shopifydesign host 白名单,+objectandarchive 共享映射) | 已有项目使用记录 |
| `scripts/verify-mirror.mjs` | 镜像自己的检查: 单射 / 账本 / 真实性 / 闭包, 跑在一切下游检查之前 | M0 验收前, 每次重抓镜像后 | 新写(objectandarchive M0 的五条镜像层缺陷是它的需求书 + M(n) 的 D-T10) | 已记录(本仓 fixture 实跑: 旧爬虫产出的真实坍缩被映射与账本两项逐条抓出; 错误 `--query-ignore` 当场判死; 豁免语义 fixture 修前把基址下两个真缺文件静默豁免, 修后逐条报出, 整 host 豁免与 `*` 显式前缀各自照常.**AUTHENTICITY 与文本判定 fixture**:挑战页 + 声明 `image/png` 而正文是 HTML 的文件各自逐条报告失败, 声明 `font/woff2` 的 `.woff` **不误报**;360 KB 真页面里嵌 reCAPTCHA + PerimeterX **不误报**;同一份完整镜像上旧检查扫 1 个文件报 "= ∅", 新检查扫 3 个文件看见 5 条引用,**人为删掉两个真资产后旧检查照样 PASS 0, 新检查逐条报告失败**) |
| `scripts/gapfill-video.mjs` | HLS 播放列表、备用轨道、初始化段、密钥和媒体分片补录 | M0(有 HLS 流媒体时) | racingshop 项目实践 | 本地用例覆盖递归引用、查询参数变体、已有文件与清单一致性 |
| `scripts/reconcile-gaps.mjs` | 运行时缺口对账器: GAP 行 + 字节推导全集, 逐条补进镜像 | M0(运行时资源多的站) | rauchg 版 | 已记录(rauchg 项目实践 1,600+ URL 零失败) |
| `scripts/flight-decode.mjs` | C1 的坐标系: 把每页内联的 flight 流解成可寻址的树 | M1(C1) | rauchg 版 | 已记录(19 文档全解; selftest 合成流夹具) |
| `scripts/verify-flight.mjs` | C1 语义检查: 重构工程与镜像 flight 树逐语义比对 | M(n-1)(C1) | rauchg 版 | 已记录(18/18 路由完成验收; selftest 绿/红双面夹具) |
| `scripts/serve.mjs` | 静态服务: MIME / Range / 重定向 / URL 改写 / 固定 JSON 端点替身, 带实例身份 | M0.5 起全程 | noomo, lando, racingshop, lamalama 等项目 | `--stub-json PATH::FILE` 按路径返回固定 JSON, 不恢复后端处理逻辑; RSC 等响应按项目配置 |
| `scripts/probe.mjs` | CDP 无头探针:404 / 控制台错误 / 外联 / 截图, 一页一报 | M0.5 起每 commit | lando 版(rogier 探针家族→samsy regression→lando→shopifydesign) | 已有项目使用记录 |
| `scripts/verify-routes.mjs` | 路由 / 重定向 / <head> 契约检查, 状态码也比 | M2+ | kimi 版 | 已记录(CONFIG 需按项目填写) |
| `scripts/verify-ssr.mjs` | SSR 逐字节契约检查: body DOM / 载荷 / 运行时配置对镜像 | M2+(有 SSR 产物时最先建) | noomo 版 | 已记录(提取器为 Nuxt 专用, 换框架需替换) |
| `scripts/pixelcompare.mjs` | 量化像素对比: 自比带宽 + 跨侧残差, 非空帧与双进程前置 | M(n-1);`--freeze-css` 时 M(n-1)(CSS 驱动的站) | samsy 版为主 | 已记录(驱动到特定状态的逻辑属调用方) |
| `scripts/side-by-side.mjs` | 双侧截图并排合成图(展示用, 不是检查) | M(n-1) | kimi 版 | 已有项目使用记录 |
| `scripts/probe-shim.js` | 确定性驱动 shim:冻 rAF / 时钟 / 随机, 让两侧采到同一时刻 | M(n-1) | noomo 版(+shopifydesign 熵面补全) | 已有项目使用记录 |
| `scripts/dump-timelines.mjs` | GLB 动画曲线 dump 成 JSON 数值账本 | M1(数据驱动动画时) | noomo 版 | 有限验证(GLB 专用, 模式可泛化) |
| `scripts/beautify-bundle.mjs` | 固定版本格式化并校验 bundle, 支持 ESM 与累积来源清单 | M1 | oryzo, samsy, kimi, noomo, lando, lamalama | 语法和 token 校验不构成全部语义的证明; 格式化失败会保留原件并报告失败 |
| `scripts/extract-source.mjs` | 字节切片器: 按 _pretty/ 行号区间逐字取出源 | M2+(逐字移植期) | shopifydesign 版(原脚本切片表硬编码, 通用化为配置驱动) | 已记录(shopifydesign 项目实践: M2 33 段/2,475 行, M3 增至 41 段; 配置化 + `--balance-check` 为通用化新增, 已 fixture 验证切片/守卫/`--check`/边界错四路) |
| `scripts/module-map.mjs` | 模块化 bundle 的分层表: 认容器, 列模块, 连依赖边 | M1(模块化打包产物) | airpodspro 版 | 需核对目标输入的适用性 |
| `scripts/closure.mjs` | 从种子模块算传递依赖闭包, 纵向功能切片边界的依据之一 | M2+(模块化打包产物) | airpodspro 版 | 需核对目标输入的适用性 |
| `scripts/slice-modules.mjs` | 按模块 id 逐字切片, gen 头带完整再生成命令 | M2+(模块化打包产物) | raycastkbd 版 | 需核对目标输入的适用性 |
| `scripts/harvest-cases.mjs` | 从源站运行中的引擎采用例(基线的 A 侧) | M2+(源站引擎可达时) | airpodspro 版 | 需核对目标输入的适用性 |
| `scripts/verify-harvest.mjs` | 采集基线的 B 侧: 移植实现按行为复现源站的用例 | M2+(有采集基线时) | airpodspro 版 | 需核对目标输入的适用性 |
| `scripts/verify-crossside.mjs` | 跨侧检查: 两侧同一输入, 比输出 | M2+(源站有可直接调用的接缝时) | airpodspro 版 | 需核对目标输入的适用性 |
| `scripts/verify-zerodep.mjs` | 解析字面量 import、再导出和 require(), 检查外部依赖与 tools/ 引用 | 修改脚本依赖时 | airpodspro 版 | 调用固定版本的 Acorn; 离线运行需本地缓存 |
| `scripts/build-site.mjs` | 策略 A 构建层: 按变换表把镜像外壳变成复刻外壳 | M2+(策略 A) | racingshop 版(v0.1.17 无人值守闭环) | 已有项目使用记录 |
| `scripts/verify-shell.mjs` | 外壳字节检查: 每个差异 hunk 必须能由变换表重放 | M2+(策略 A) | racingshop 版(v0.1.17) | 已有项目使用记录 |
| `scripts/verify-offline.mjs` | 零外联检查的静态一半: 预连接 / 内联信标 / 回退路径 | M0.5 起每 commit | racingshop 版(v0.1.17) | 已有项目使用记录 |
| `scripts/verify-payload.mjs` | SSG payload 检查: 把内联数据当数据比, 不当文本比 | M0.5 起(有 SSG payload 时) | noomo 版谱系(v0.1.19;v0.1.71 Nuxt 3 外置载荷; v0.1.73 `--allow-absent`) | 已有项目使用记录 |
| `scripts/verify-lenprefix.mjs` | 自带长度的载荷检查: flight T 行声明多少字节就得有多少 | M0.5 起(有 flight 载荷时) | eightdesign 版(v0.1.61) | 已有项目使用记录 |
| `scripts/verify-refs-served.mjs` | 引用可达检查: 产出里每条资源引用逐条问服务器 | M2+ 起每 commit | eightdesign 版(v0.1.68;v0.1.72 `--allow`) | 已有项目使用记录 |
| `scripts/verify-standalone.mjs` | 自包含检查: src/ 复制到任何地方断网可跑 | M(n+1) | eightdesign 版(v0.1.64) | 已有项目使用记录 |
| `scripts/verify-fresh.mjs` | 新鲜度检查: dist 是否等于此刻从 src 重建的字节 | M(n+1)(有构建步骤时每次) | eightdesign 版(v0.1.64) | 需核对目标输入的适用性 |
| `scripts/verify-symbols.mjs` | 符号映射检查: port/ 每个顶层声明在 src/ 里恰有一个去处 | M(n+1) | airpodspro 版(v0.1.24) | 已有项目使用记录 |
| `scripts/verify-module-map.mjs` | M(n+1) 等价检查: src/modules 每个文件与打包器字节 token 级一致 | M(n+1)(模块化打包产物) | airpodspro 版(v0.1.46) | 已有项目使用记录 |
| `scripts/cold-audit-modules.mjs` | M(n) 静态覆盖核对: 闭包里每个模块都被 port 覆盖, 报 n/N examined | M(n)(模块化打包产物) | airpodspro 版(v0.1.46;v0.1.73 箭头工厂; v0.3.15 单参工厂) | 已有项目使用记录 |
| `scripts/cold-audit-decls.mjs` | M(n) 静态声明核对: 扁平 bundle 的顶层声明逐个归桶 | M(n)(扁平产物; 手写移植形态的第一段验收依据) | samsy 版(v0.3.14) | 已有项目使用记录 |
| `scripts/verify-tween.mjs` | 纵向功能切片的数值检查: 同一关键帧规格喂两个引擎, 比写出的值 | M2+(有补间/时间轴引擎时) | airpodspro 版(v0.1.36) | 有限验证(切片专用模式) |
| `scripts/frame-census.mjs` | 这一帧上有东西吗: 事后复核任意截图是不是空帧 | M(n-1) | racingshop 版(v0.1.21) | 已有项目使用记录 |
| `scripts/census-bundles.mjs` | 无容器产物的 chunk 级坐标账本 | M1(无容器产物) | hashgraphvc 版(v0.2.0) | 已记录(对原项目 33/33 sha 交叉一致) |
| `scripts/slice-esm.mjs` | 拼接式分解切片器: parts 逐字节拼回 chunk | M2+(拼接式分解) | hashgraphvc 版(v0.2.0) | 已记录(33 chunk / 44.9 万行 → 2,043 件全数重拼一致) |
| `scripts/verify-reassembly.mjs` | 重拼检查: 每个 part 的 sha256 与拼接后的 chunk 哈希都对得上 | M(n+1)(拼接式分解) | hashgraphvc 版(v0.2.0) | 已有项目使用记录 |
| `scripts/sweep-routes.mjs` | 渲染广度检查: 全路由一个浏览器跑完, 逐路由记错误 / 失败 / 外联 | M0.5 起(全路由广度) | overworld/milknetwork 版(v0.2.3) | 已记录(20 路由含音频钩子 4.4 分钟全清;122 路由 7.5 分钟, 正确复认已登记的 Vimeo 401) |
| `scripts/pixel-walk.mjs` | 在多个滚动位置比较像素, 转发 seed, ready, hold, chunk 和 CSS 冻结参数 | M(n-1) | shopifydesign, lamalama | 自比用于估计波动; 核对实际落点, 非空帧和检查点覆盖 |
| `scripts/lib/ports.mjs` | 端口分配 + 实例身份注册表(slot / lane / side) | 所有起服务 / 起浏览器的脚本依赖 | 新写(shopifydesign §8.30 实例连接错误事故的根治) | 已记录(本仓 fixture 实跑验证: 并发不冲突 / 占用明确报错并非零退出 / 双侧各连各的) |
| `scripts/lib/chrome.mjs` | 无头浏览器生命周期: 进程组回收, 孤儿回收, 载荷硬顶 | 所有 CDP 脚本依赖 | 新写(objectandarchive Mn-1a 仪器教训 #5 + D-G6) | 已记录(实跑验证: 正常收尾 / SIGINT / SIGTERM 后零残留; SIGKILL 制造 11 个孤儿后下一轮自检全数回收并清 profile;1728×1080 PNG 复现 close 1006 并明确退 4;jpeg q92 全程跑通) |
| `scripts/lib/urlpath.mjs` | 唯一的 url→本地路径映射(查询感知),爬虫与检查共用 | mirror-site / netcapture / serve / verify-mirror 共用 | objectandarchive 版(D-T1) | 已记录(本仓 fixture 实跑: 同路径不同 query 落到不同文件; 排序无关; 敏感字符不撞名) |
| `scripts/lib/extract-refs.mjs` | 唯一的资产引用提取器 + 唯一的"什么算文本"判定 | 爬虫与 verify-mirror / verify-refs-served 共用 | objectandarchive 版(D-T2 + D-T10) | 已记录(本仓 fixture 实跑:5 候选 srcset + imagesrcset 全数提取, 旧版同页只提到 1 条 `src=`;6 种转义拼写修前引用集 1, 修后 8.**真镜像差分实跑**:objectandarchive 的 197 个文本文件上 1,587 → 1,767,**0 丢失**,新增里含该项目版权审计手工找出的那 2 个 woff2;对着该项目自己那版"补两条转义正则"的修法再差分, 仍多出 **121 条**--JSON-LD 里 `"image":"https:\/\/host\/….jpg?v=…\u0026width=1920"` 这种**一条字符串里两种转义**,按 `\/` 写的形状会在 `\u0026` 处停下, 于是引用不是丢失而是被**截断**成 `?v=…`,而那个 URL 在查询感知映射下是**另一个确实在盘上的文件**--检查仍通过) |
| `scripts/lib/negotiate.mjs` | 内容协商 Accept 策略与 std→bare 请求头梯子 | mirror-site / reconcile-gaps / fingerprint 依赖 | basement D5(v0.3.9)+ v0.3.18 收拢 | 已记录(selftest 验证接口约定 + 回环 403/404/302 梯子) |
| `scripts/lib/png.mjs` | 零依赖 PNG 编解码 + 图像统计 / 比对, 恒输出 RGBA | 对比脚本依赖 | kimi 版 | 已有项目使用记录 |
| `scripts/lib/cli.mjs` | 唯一的 argv 合同:--help / --version / 未知选项 FATAL / 退出码表 | 全部脚本 | v0.3.17 新写(评审反馈) | 已记录(selftest 逐脚本扫) |
| `scripts/lib/hash.mjs` | 唯一的 sha256 拼写 | 全部账本与检查 | v0.3.18 收拢 | 已记录(selftest 往返) |
| `scripts/lib/ledger.mjs` | 镜像三本账的唯一读写实现 | mirror-site / verify-mirror / make-standalone 共用 | v0.3.18 收拢(四个写入方 / 六个读取方归一) | 已记录(selftest 往返 + mirror-site 回环爬取) |
| `scripts/lib/cdp.mjs` | 唯一的 CDP 客户端: 有界调用, 断连明确 | 所有 CDP 脚本依赖 | v0.3.18 收拢(probe / pixelcompare / netcapture / sweep-routes / ports) | 已记录(真 Chrome 冒烟: probe / sweep / pixelcompare 跨侧与自比) |
| `scripts/verify-tokens.mjs` | token 流等价检查 | M2+(排版字节交付时每 commit) | v0.3.10 新写(14islands L2 完成验收反馈) | 已记录(selftest 绿/红双面) |
| `scripts/verify-nextdata.mjs` | pages router 载荷检查(__NEXT_DATA__) | M0.5 起(pages router 站) | v0.3.10 新写(14islands L2 完成验收反馈) | 已记录(selftest 绿/红双面) |
| `scripts/emit-webpack-chunk.mjs` | 多 chunk webpack 站的逐字再发射 | M2+(webpack 多 chunk 站) | v0.3.10 新写(14islands L2 完成验收反馈) | 需核对目标输入的适用性 |
| `scripts/lib/tokens.mjs` | token 解析(beautify-bundle / verify-tokens 共用) | beautify-bundle / verify-tokens 依赖 | v0.3.10 新写(14islands L2 完成验收反馈) | 已记录(selftest) |
| `scripts/lib/flight.mjs` | flight 流的解析与寻址(flight-decode / verify-flight / verify-refs-served 共用) | C1 与 flight 载荷检查依赖 | rauchg 版谱系 | 已记录(selftest 合成流夹具) |
| `scripts/lib/shell-build.mjs` | 策略 A 的变换表执行器(build-site 与 verify-shell 共用同一份, 检查不自带实现) | M2+(策略 A) | racingshop 版(v0.1.17) | 已记录(selftest 绿/红双面) |
| `scripts/lib/version.mjs` | 这份 scripts/ 拷贝自哪个 skill 版本;`--help` / `--version` 都打印它 | 全部脚本 | v0.3.17 新写 | 已记录(selftest 钉 SKILL.md frontmatter) |
| `scripts/verify-ledger.mjs` | 可选坐标台账检查: 逐路径核对行号与 Needle | 坐标系建立或变更后 | 通用工具 | 需调用方配置 |
| `scripts/verify-sourceified-tokens.mjs` | 可选源码化 token 检查: 只接受登记的标识符与 shorthand 差异 | M(n+1) | 通用工具 | 需调用方配置 |
| `scripts/lib/data-island.mjs` | devalue 数据岛保护与保留 URL 普查 | lib | 构建层与服务层共用 | 两侧语义一致 |

模式行--本 skill 不提供实现, 写在这里是因为它定义了一种检查的形状:

| 模式 | 形状 | 阶段 | 出处 | 验证记录与限制 |
|---|---|---|---|---|
| `scripts/verify-decls.mjs`(模式, 非本 skill 提供) | **esbuild 形态的分类检查**:模块体裹在 `var X = VA(() => {…})` 惰性包装里, 绑定以逗号链出现, 双射式符号检查在这里成片误报. 正确形状是把每个 port 声明分类进 `declarations` / `collapsed` / `plumbing` / `omitted` 恰好一个桶, 反向要求每个 src 声明有来源或登记理由. **检查的形状要跟着产物的形状走**(`readable-source.md` §3.0.5) | M(n)/M(n+1)(esbuild 产物) | - | - |

## 项目专用脚本参考

- **extract-i18n.mjs**(括号配平 + 隔离 vm 求值抽取 bundle 内数据成 JSON,键集交叉校验)--抽取式移植模式, 但解析逻辑绑定具体 bundle 结构. 移植自 `careers-kimi-rebuild/scripts/extract-i18n.mjs`.
- **regression.mjs**(状态全遍历 CDP 回归: localStorage 预种, 逐状态截图断言)--状态机定义站点专用, probe.mjs 已覆盖单页探测. 移植自 `samsyninja-rebuild/scripts/regression.mjs`.
- **gen-shells.mjs / gen_components.py**(DOM 外壳生成: 零重写流水线 vs 保守切组件)--策略绑定站点类型(见 dom-shell-strategies 分支),不宜做成单一通用脚本. 移植自 `landonorris-rebuild/scripts/gen-shells.mjs` / oryzo 的 `gen_components.py`.
- **dump-scene-graph.mjs(运行时场景图 dump 成数值账本)**--评估后不纳入: shopifydesign 那份是源站 bundle 里某个内部函数的逐字转写, 换个站点连挂载点都不存在. 模式(先 dump 源站数值再移植再数值验收)已由 `dump-timelines.mjs` 代表; 需要时按目标站的引擎重写一份.
- **rogier 的 capture.mjs / analyze-home-bands.mjs**(行亮度剖面分析)--依赖 sharp,违反内置模块约定, 未纳入; 等价能力可用 `lib/png.mjs` + 自写剖面重做.
- **racingshop 的 gapfill.mjs(协议相对 URL 归一重解)**--评估后不纳入: 它修的是爬虫把 `//host/path` 拼成 `https://origin//host/path` 的 bug,而 `mirror-site.mjs` 已在提取阶段就把协议相对 URL 归一成 `https://host/path`,根因不再产生, 留着只会诱导别人跑一个针对不存在故障的补丁. 若历史镜像里已有这类损坏条目, 一次性重解那份 manifest 即可, 不需要常备脚本.
- **kimi 确定性冻结协议(八协议表)**--是文档/协议不是脚本, 应进 references/,不在本目录范围.
- **layer-report.mjs(内联块四层归属检查)**--`shopify-platform.md` §0.3 步骤 5 把它定为 M1 验收条件, 但本 skill 暂未提供实现. 机械部分通用(枚举 `<script>`, 先掩 HTML 注释, 块正文 sha256, 与归属表 join, UNCLASSIFIED/AMBIGUOUS 非零退出),站点专用的是那张归属表本身与 §0.2 的判层判据. 移植参照 `objectarchive-rebuild/scripts/layer-report.mjs` + `docs/layer-map.json`.
