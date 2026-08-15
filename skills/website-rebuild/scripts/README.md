# scripts/ — 零依赖工具脚本

全部为零依赖 Node 脚本（Node 22+ 内置 fetch / WebSocket 直连 CDP，不装任何 npm 包）——六项目一致的工具哲学："避免工具链自身版本漂移污染比对"。站点相关常量已提升为 CLI 参数或文件顶部 CONFIG 块（各文件头部有用法示例与传承注释）。

## ⚠ 端口与实例身份（`lib/ports.mjs`，凡起服务/起浏览器的脚本都受此约束）

**串台既造假红也造假绿**，而假绿是不可见的：两个进程连到同一个浏览器/服务时，你会拿到一份完美的双侧对拍报告，而它测的是同一侧。旧版每个脚本各自 `9222 + random*500` / `CDP_PORT || 9333` / `PORT || 5175`，区间重叠且默认值全局固定（实战事故见 shopifydesign §8.30：前台探针连上后台自比脚本的浏览器，报回"复刻侧有 19 次到镜像端口的外联"）。现在统一为：

    端口 = 21000 + slot×1000 + lane×10 + side        # 21000..29999

- **slot（0..8）= 一个工作区**：由 git 根路径哈希得到，同机多项目并发默认不撞；`WRS_PORT_SLOT` 可显式指定（同一项目要并发跑两份同名脚本时也用它）。
- **lane（0..99）= 一个脚本角色**：编号写死在 `lib/ports.mjs` 的 `LANES` 里，**当 ABI 对待**；10–49 已为项目自带的 CDP 门（scroll/audio/scene-graph…）预留，50–99 留给项目自定义。
- **side（0..9）= 对拍的哪一侧**：`1=mirror 2=rebuild 3=live 0=不分侧`。所以**端口自己说明自己是谁**：`25001` 是镜像服务、`25002` 是复刻服务、`25012` 是探针在探复刻侧。
- **占用即响亮失败**（退 3，并打印占用方是谁：CDP 端点/serve.mjs 的 side+root+pid+token/普通 HTTP）。**绝不静默换端口**——换了端口的进程，伙伴脚本就会去跟留在原地的东西说话，这正是假绿的成因。
- **显式覆盖照常支持**（`--port` / `--cdp-port` / `PORT` / `CDP_PORT`），覆盖值一样走占用预检与身份校验，日志里标 `[EXPLICIT]`。
- **最后一道闸是身份校验，不是端口**：CDP 脚本用随机 sentinel 页启动浏览器，attach 时只认自己那一页，认不出立刻退 3 并打印实际看到的 target 列表；`serve.mjs` 每个响应带 `x-wrs-identity` token 并提供 `GET /__wrs/identity`，`pixelcompare.mjs` 据此断言 A/B 确实是两个进程（同 origin、或两个 URL 同一 token，都判死）。

    node scripts/lib/ports.mjs          # 打印本工作区的完整端口表
    node scripts/lib/ports.mjs 25012    # 反解某个端口是谁

## ⚠ 浏览器进程与 CDP 载荷（`lib/chrome.mjs`，凡起无头 Chrome 的脚本都受此约束）

**漏一个渲染进程 = 把像素门调松了。** 旧版收尾一律 `chrome.kill('SIGKILL')`——那只杀浏览器主进程，它已经 fork 的 6–8 个 renderer/GPU/network 子进程不在信号范围内，父进程一死就被 reparent 到 pid 1 继续跑（实测：129 个存活 Chrome / 约 16 个泄漏 profile，最老 2 天 1 小时，"什么都没在跑"而 load average 8.7）。这不是整洁问题：像素门的容差不是手挑的 epsilon，而是**参照侧自己跟自己跑 N 次**得到的自比带宽，背景负载让这 N 次彼此更不一致 → 带宽变宽 → `cross ≤ selfBand + k` 静默原谅真实的跨侧残差。**一个进程泄漏 bug 会让整道像素门变松。**（带宽还有一条"测量中途不许改仪器"的规矩，所以持续增长的泄漏不止是抬高带宽，而是让 N 次会话不可比。）

现在统一为 `lib/chrome.mjs`：

- **收进程组，不收进程**：`spawn(..., { detached: true })` 让 Chrome 成为进程组长，子进程继承同组，收尾 `process.kill(-pid, …)` 一次带走全部；**先 SIGTERM 后 SIGKILL**（留出关 profile 的时间）。
- **覆盖全部退出路径**：`exit` / `SIGINT` / `SIGTERM` / `SIGHUP` / `uncaughtException` / `unhandledRejection` 都收割。正常收尾是这几条里**最不重要**的一条——现场泄漏全部来自另外几条。`exit` 处的收割必须同步（用 `Atomics.wait` 而非 Promise）。
- **临时 user-data-dir 即身份**：`<tmp>/wrs-chrome-s<slot>-<role>-p<port>-XXXXXX`，收尾删除。这个名字才让"这 129 个 Chrome 里哪些是我的"成为可判定问题，也把清扫范围限死在本工具链自己起的实例上（永远碰不到你自己的浏览器）。
- **启动前自检**：每个脚本先扫本工作区同角色的**孤儿**实例（`ppid == 1`，即启动它的脚本已死），**响亮报出**（pid / 存活时长 / profile 路径 + 上面那条因果）再回收，然后才做端口预检——顺序反了的话，自己上一轮留下的残骸会变成一句要手工清理的"端口被占"。**判据是孤儿而不是同名**：活着的兄弟进程有活着的父进程，一律不碰，那种情况归 `lib/ports.mjs` 的端口闸响亮裁决。

<!-- -->

    node scripts/lib/chrome.mjs          # 列出本工作区的实例（ORPHAN 会标出来）
    node scripts/lib/chrome.mjs --all    # 本机所有工作区
    node scripts/lib/chrome.mjs --reap   # 回收列出的孤儿（连同其进程组）

**截图有传输层硬顶，且旧版表现为无声超时。** `Page.captureScreenshot` 把整帧作为**一条** base64 WebSocket 消息回传，而 Node 内置 WebSocket 会在消息过大时直接 `close 1006`——此后每条 CDP 调用都超时且没有自己的错误信息。实测（objectandarchive D-G6，同机同 Chrome）：`1280×800 png` = 2,395,616 字符可用（280ms）；`390×844 png` = 734,240 可用；`1728×1080 jpeg q100` = 1,995,384 可用（106ms）、`q92` = 827,968 可用（**58ms**）；**`1728×1080 png ≈ 3.6M` → 直接 1006**。可用上界在 2.40M–2.72M 之间。换一台机器（Chrome 150 / Node 22）复测：入站 3.33M 可用、出站 4.37M 可用，而 1728×1080 的**噪声** PNG（≈7M）照样死——**上界随机器/版本浮动，2.4M 是可以依赖的线，不是断裂点**。处置三条：

- **失败必须响亮**：所有 CDP 客户端都装 `onclose`（拒绝在飞的调用）**加**逐调用超时，截图失败打印"载荷超限：`<size>`，视口 `<w×h>` 格式 `<fmt>`"+ 可操作的降级清单，退 4。**无声超时是最坏的失败形态**——它不告诉你任何事。
- **可行的规避**：`probe.mjs` / `pixelcompare.mjs` 新增 `--format png|jpeg --quality N`（默认仍 PNG 以保字节保真；`probe.mjs` 的 `--shot x.jpg` 会按扩展名自动切 jpeg）。**什么时候必须降**：视口 ≳ 1500×900 且内容是照片/噪声类时 PNG 到不了岸，改 `--format jpeg --quality 92`（58ms/张）。字节门保持 PNG；像素/指标门用 q92 已实测无编码噪声（同一静止态连拍两帧逐字节相同）。
- **注意二次放大**：`pixelcompare.mjs` 的指标与合成步骤把**两帧**内联进一条 `Runtime.evaluate` 再取回结果，所以那条消息约为单帧的 2 倍——两张截图都过了却死在指标步是正常的，这两步失败时会点名是哪一步、内联了多少字符。

## ⚠ 镜像有自己的门（`verify-mirror.mjs`）

下游每一道门问的都是**"渲染得出来吗"**——零 404、零控制台错误、零外联、像素差多少。没有一道问**"字节对不对"**。所以一个错的镜像可以让所有门全绿：查询参数化的图片 CDN 上 `x.jpg?width=320/600/1200` 是三份不同字节，按 pathname 映射会把它们坍缩成一个文件（谁最后写谁赢），服务端每个 `?width=` 都回同一个文件，srcset 给 1200px 的槽选了 32px 的图，**页面照样渲染**。抓包那一遍按 url+search 记账、按 pathname 查盘，于是从第二个变体起全报 HAVE——GAP=0，假的。

结论写成纪律：**镜像层的缺陷只能在镜像层抓**。抓完镜像先跑 `verify-mirror.mjs`（映射单射性 / 账本一致性 / 闭包 / 可选抽样回源），它绿了，下游的门才有意义。四方共用 `lib/urlpath.mjs`（映射）与 `lib/extract-refs.mjs`（引用提取）也是同一条纪律的结构形式：**门不能自带一份被审对象的实现**，否则它继承的正是它要抓的盲区。

| 脚本 | 用途 | 典型用法 | 出处 | 成熟度 |
|---|---|---|---|---|
| `fingerprint.mjs` | Step 0 指纹侦察（`references/scope-and-fingerprint.md` §2 六步 curl 协议）的跨平台等价——无 POSIX 工具链（Windows PowerShell 无 curl/cmp/fold/tr/perl）也能跑：GET 存活 + 手动重定向链与终点域同一性、双抓确定性 diff、物种/年代 grep、HTML 技术指纹（剥注释枚举 `<script src>`/内联 `import()`、框架模式×引擎范式标记，计数一律出现次数语义 = `grep -o \| wc -l`）、bundle 初检（<1KB 自动补 Referer 重试、minification 形态、three 强签名、`/api/` 计数、catch-all content-type 告警）。**只采证据不出判级**；下载物逐个记 sha256，请求间隔 ≥1s | `node fingerprint.mjs --target https://example.com/awarded-path --bundle https://example.com/assets/main.xxx.js` | 新写（把 §2 手工协议脚本化，协议内容零发明） | 中（逐条对照 §2 实现 + 实站冒烟三路：byte-identical / 301 链 / <1KB Referer 重试；未经完整项目实战） |
| `mirror-site.mjs` | BFS 爬虫镜像源站（页面/跨域资产，文本资产迭代到不动点；对要求同源 Referer 的资产域补齐 Referer 头、404 模板探测）。**`redirect: "manual"` 硬纪律**：重定向只记进 `redirects.tsv` 并把目标重新入队，绝不把 301 的 body 写在来源路径下。产出三本账：`mirror-manifest.json`（含逐文件 sha256）、`inventory.tsv`、`redirects.tsv`，外加 `urlpath-policy.json`（本镜像用的 url→路径策略，服务/抓包/验收三方读它）。`--seeds` 让第三遍从 bundle/payload 里解出来的 URL 走同一个下载器，账才是一本。**url→路径映射与引用提取均已上收进 `lib/`**：映射查询感知（`?width=` 变体不再坍缩）、`srcset` 逐候选提取（旧正则只认引号后第一条，一组 5 条只见 1 条） | `node mirror-site.mjs --origin https://example.com --hosts cdn.x.com --probe-404 /no-such-page --seeds solved-urls.txt`；确认某参数不改字节后才 `--query-ignore v,cb` | lando 版（rogier→noomo→lando→shopifydesign→objectandarchive 五代传承） | 高 |
| `netcapture.mjs` | 真实浏览器 CDP 抓包，与磁盘镜像 diff 对账（HAVE/GAP），补运行时拼接 URL。**`--hosts` 在 CDN 站上不是可选项**：记录范围是 host 白名单（语义同 mirror-site 的 `ASSET_HOSTS`，把同一份 host 清单传给它）；不在白名单的 host 只计数并在末尾列出，未传 `--hosts` 却漏掉大量流量时打印 UNDER-OBSERVED 告警——旧版只记同源，会在只看到约 2% 流量时报 GAP=0（实测 246 个 URL 里 208 个在 CDN 上）。落盘对账走 `lib/urlpath.mjs`：**以前按 url+search 记账却按 pathname 查盘**，查询参数化的图片 CDN 上每个变体从第二个起都对着"另一张图"报 HAVE，又是一次假 GAP=0。`--fetch` 只落字节不落账，`verify-mirror.mjs` 会把它记为孤儿——补漏请走 `mirror-site.mjs --seeds`。本家族里跑得最久、被 Ctrl-C 最多，浏览器生命周期走 `lib/chrome.mjs`（进程组收割 + 启动前孤儿自检） | `node netcapture.mjs --origin https://example.com --hosts cdn.x.com --routes /,/about` | kimi 版（+shopifydesign host 白名单，+objectandarchive 共享映射） | 高 |
| `verify-mirror.mjs` | **镜像自己的门**（其余所有门问的都是"渲染得出来吗"，没人问"字节对不对"，所以错镜像能全绿）。四项断言，失败退 1：① **映射单射性**——不同 URL 落到同一文件即失败，分别对"账本记录的路径"（已经发生的坍缩）和"`lib/urlpath.mjs` 今天算出的路径"（现行策略会造成的坍缩）各查一遍，两者不一致即 MAPPING DRIFT（镜像是用另一套映射/查询策略写的）；② **账本一致性**——manifest 逐行 sha256/字节对磁盘实测、`inventory.tsv` 与 manifest 互校、账本条目集 = 磁盘文件集（孤儿/幽灵都点名）；③ **闭包**——引用集 − 磁盘集 = ∅，用与爬虫**同一个** `lib/extract-refs.mjs`，门不会继承被审对象的盲区（`--allow-missing external.txt` 放行已登记的非文件/降级项）；④ **抽样回源**——`--resample N` 重新请求 N 条比 sha256，**默认关闭**，开启时低频（`--resample-delay`，默认 1500ms）、默认排除 HTML | `node verify-mirror.mjs --mirror legacy-mirror --allow-missing legacy-mirror/external.txt`；发布前 `--resample 8` | 新写（objectandarchive M0 的五条镜像层缺陷是它的需求书） | 高（本仓 fixture 实跑：旧爬虫产出的真实坍缩被四项全部抓出；错误 `--query-ignore` 当场判死） |
| `gapfill-video.mjs` | HLS 流媒体阶梯补录：master m3u8 → 递归取 variant/备用音轨/I-frame 播放列表 → 逐段下载 `.ts`/`.m4s`（含 EXT-X-MAP 初始化段、EXT-X-KEY）→ 追加进 manifest 账本。补的是静态爬虫的结构性盲区：HTML 里只有 master，其余全由播放器运行时 fetch，只有探针 404 才暴露（`serve.mjs` 的 MIME 表已含 `.m3u8`/`.ts`/`.m4s`/`.mpd`，补录后即可本地回放） | `node gapfill-video.mjs --master https://cdn.x.com/vp/<id>/<id>.m3u8 --origin https://example.com`（`--dry-run` 先看阶梯全貌） | racingshop 版（通用化：递归下降 + 相对 URI 解析 + 备用轨道/fMP4 分支） | 高（racingshop 实战验证扁平阶梯；递归与备用轨道分支为通用化新增，已用 fixture + 原站数据回归） |
| `serve.mjs` | 零依赖静态服务器：MIME 补全（含 HLS 阶梯与 `.mov`）、Range、redirects.tsv 重定向回放（FROM 写绝对 URL 或裸路径都能命中）、`/ext/<host>/` 服务层改写（镜像磁盘神圣不改）、`--stub-ext-hosts` 把"改写进 `/ext/` 但故意不镜像"的遥测 host 回 JS stub（否则要么真外联、要么 404）、`?__probe` 注入 probe-shim、404.html 回放。**`--side mirror\|rebuild` 必填**（除非显式给 `--port`/`PORT`）：它决定端口（…1 镜像 / …2 复刻）并写进每个响应的 `x-wrs-identity`，端口被占直接退 3 并点名占用方。三条镜像层修复：① **查询感知取文件**（`lib/urlpath.mjs`，读镜像里的 `urlpath-policy.json`）——按 pathname 取文件会拿一个变体回答所有 `?width=`，页面照渲染，零 404 门在错镜像上变绿；② **host 改写覆盖四种写法**——普通 / 协议相对 / JSON 转义（`https:\/\/host\/` 与 `\/\/host\/`）/ **裸主机常量**（`"https://otlp.example.com"` 后面代码自己拼路径）；新增 `--origin-host` 把源站对自己的绝对/协议相对自引用改写成根相对（否则离线镜像会向线上真站要盘上已有的图）；③ **回放前跳过本地化后自指的重定向**（源站常有 http→https 同路径条目，两侧本地化后同路径 → `ERR_TOO_MANY_REDIRECTS`，把真实在盘的资产打死） | `node serve.mjs --side mirror --root legacy-mirror --origin-host example.com`；复刻侧 `node serve.mjs --side rebuild --root dist`；有遥测时加 `--stub-ext-hosts www.googletagmanager.com,www.clarity.ms` | noomo+lando 合并版（samsy→kimi→noomo→lando→racingshop→shopifydesign→objectandarchive；kimi 的 RSC 层需按项目自加） | 高 |
| `probe.mjs` | CDP 无头探针：console/异常/网络采集 + Log 域监听（SRI 拦截盲区修复）、`--eval/--evalAfter/--shot/--mobile`、CLEAN 判定退出码进 CI。`--no-external` 把"任何离开本服务 origin 的请求"记为失败（断网门要求的零外联，此前无人断言）；`--walk N` 全页滚动走查（`--scroll` 只跳单点，跳过的场景根本不挂载）。调试端口按 side 分配（side 从目标 URL 的端口自动反解，可用 `--side` 覆盖），attach 只认自己的 sentinel 页；外联清单里凡是本工具链的回环端口都会标注归属（`1x 127.0.0.1:25001 <- serve.mjs side MIRROR`），`--expect-side` 可断言对面服务确实是那一侧。浏览器生命周期走 `lib/chrome.mjs`（进程组收割 + 启动前孤儿自检）；`--shot` 支持 `--format jpeg --quality N`，撞上 CDP 载荷硬顶时响亮失败并给出降级清单（详见上文两节） | `node probe.mjs http://127.0.0.1:25001/ --shot out.png --walk 24 --no-external`；大视口截图 `--shot out.jpg --format jpeg --quality 92` | lando 版（rogier 探针家族→samsy regression→lando→shopifydesign） | 高 |
| `verify-routes.mjs` | 路由/重定向/head 契约门：head+`<main>` 全属性逐字段对镜像比、重定向断言状态码本身。`CONFIG.server` 起的被测服务走 `lib/chrome.mjs` 的 `spawnReaped`（进程组 + 全退出路径收割）——`npm run dev` 之类是启动器，`server.kill()` 只杀启动器、真正的服务继续占着端口 | 编辑文件顶部 CONFIG 后 `node verify-routes.mjs` | kimi 版 | 高（CONFIG 需按项目填写） |
| `verify-ssr.mjs` | SSR 逐字节门：body DOM / 数据 payload / config / 序列化顺序四项对镜像 byte-equal（buildId 掩码） | `node verify-ssr.mjs`（端口取自 `lib/ports.mjs` 并打印；`PORT=3100` 可覆盖；页面可自动发现） | noomo 版 | 高（提取器为 Nuxt 专用，换框架需替换） |
| `pixelcompare.mjs` | 双服务器 A/B 截图 + 64×40 网格量化（适合活体场景）+ 并排合成图 + metric.json；`--max-mean` 可作门。**开拍前先证明 A/B 是两个进程**：同 origin 或两个 URL 拿到同一个 `serve.mjs` identity token 一律退 3（否则那份完美报告测的是同一侧），标签与服务自报的 side 不符则告警。浏览器生命周期走 `lib/chrome.mjs`——**这里的进程泄漏会直接把自比带宽抬高、把门调松**。`--format jpeg --quality N` 是撞上 CDP 载荷硬顶时的规避（默认 PNG），截图/指标/合成三步失败都点名原因并退 4，不再无声超时 | `node pixelcompare.mjs --a http://127.0.0.1:25002/ --b http://127.0.0.1:25001/ --name home`；1728×1080 加 `--format jpeg --quality 92` | samsy 版为主 | 高（驱动到特定状态的逻辑属调用方） |
| `side-by-side.mjs` | 消费门产出的 mirror-/rebuild- PNG 对，合成 [镜像\|重建\|8× 差异热力图] + 汇总表。本身不起任何进程（纯后处理）；但**上游采集**受 CDP 载荷硬顶约束，若某对帧是 JPEG 回退的产物，热力图读作“差在哪”而不是“差多少” | `node side-by-side.mjs --dir docs` | kimi 版 | 高 |
| `probe-shim.js` | 确定性驱动 shim：接管**整个熵面**——rAF / setTimeout / setInterval / visibility / `performance.now` / `Date.now` / `new Date` / `Math.random`（定种 mulberry32，可 `__reseed(n)`），`__pump(dt,frames)` 手动泵帧后这些时钟全部与帧时间锁步，双侧同位注入（serve.mjs `?__probe` 自动注入）。只冻 rAF 不够：漏掉的时钟会让同一镜像两次采样差出数值（实测 7 个字段） | 由 serve.mjs 注入；探针侧调 `window.__pump(16.7, 60)` | noomo 版（+shopifydesign 熵面补全） | 高 |
| `dump-timelines.mjs` | 手写 GLB 解析器，动画曲线 dump 成 JSON 数值账本——"数值基准先行"范例（先 dump 源数据再移植再数值验收） | `node dump-timelines.mjs legacy-mirror/timelines/cam.glb` | noomo 版 | 中（GLB 专用，范式可泛化） |
| `beautify-bundle.mjs` | 薄封装：钉死 `js-beautify@1.15.1` 展开 bundle 到 `legacy-mirror/_pretty/` 并自动生成含再生成命令的 `_pretty/README.md`（版本漂移作废行号坐标系） | `node beautify-bundle.mjs legacy-mirror/assets/cdn.x.com/bundle.js` | 新写薄封装（oryzo 引入流程、samsy 钉版本、kimi/noomo/lando 统一 1.15.1） | 中（新写，未经项目实战） |
| `extract-source.mjs` | 字节切片器：按钉死行号区间从 `_pretty/` 切字节、按**源序**拼成生成文件（`AUTO-GENERATED … DO NOT EDIT BY HAND` 头注 + 别名/桩 import + 导出表），逐字移植的首选实现形式（纪律见 [porting-discipline.md §2.2](../references/porting-discipline.md)）。三件套齐备：切片表 `{from,to,note,symbols}`（`to` 含尾行）/ 源文件 **sha256 守卫**（不符退 3 并打印"坐标系已移动，全部 `L####` 引用作废"，而不是静默切错行）/ **符号别名表**（可逐符号注明解析依据，与桩文件同为 import 组）。`--check` 生成物过期即失败（直接进验收门）；`--balance-check` 用 `new Function()` 抓切片边界错（§6.2 (c)）。**机器与数据分离**：路径/sha256/切片表/别名表全在 `--slices` 配置（`.mjs` 或 `.json`），带注释样例见同目录 `slices.config.example.mjs` | `node extract-source.mjs --slices slices.config.mjs`；门：`node extract-source.mjs --slices slices.config.mjs --check` | shopifydesign 版（原脚本切片表硬编码，通用化为配置驱动） | 高（shopifydesign 实战：M2 33 段/2,475 行，M3 增至 41 段；配置化 + `--balance-check` 为通用化新增，已 fixture 验证切片/守卫/`--check`/边界错四路） |
| `lib/ports.mjs` | **端口分配 + 实例身份注册表**（见本文件顶部一节）：`21000 + slot×1000 + lane×10 + side` 的确定性分配（默认互不重叠、端口自带语义）、占用即退 3 并点名占用方、CDP sentinel 归属校验、`serve.mjs` 身份 token 与双侧同一性断言。带 CLI：打印本工作区端口表 / 反解端口 | `node scripts/lib/ports.mjs`；脚本内 `import { resolvePort, assertPortFree, assertOwnBrowser } from "./lib/ports.mjs"` | 新写（shopifydesign §8.30 串台事故的根治） | 高（本仓 fixture 实跑验证：并发不冲突 / 占用响亮失败 / 双侧各连各的） |
| `lib/chrome.mjs` | **浏览器/子进程生命周期注册表**（见本文件顶部一节）：`detached` 进程组启动、SIGTERM→SIGKILL 分级收割、六条退出路径全覆盖、临时 user-data-dir 即身份、启动前同角色**孤儿**自检并响亮回收；另收 CDP 载荷硬顶的实测常量与降级建议（`shotCeilingAdvice`）。`spawnReaped` 供非 Chrome 的子进程（被测服务）复用。带 CLI：列出/回收本机实例 | `node scripts/lib/chrome.mjs --all`；脚本内 `import { preflightChrome, launchChrome } from "./lib/chrome.mjs"` | 新写（objectandarchive Mn-1a 仪器教训 #5 + D-G6） | 高（实跑验证：正常收尾 / SIGINT / SIGTERM 后零残留；SIGKILL 制造 11 个孤儿后下一轮自检全数回收并清 profile；1728×1080 PNG 复现 close 1006 并响亮退 4；jpeg q92 全程跑通） |
| `lib/urlpath.mjs` | **唯一的 url→本地路径映射**，`mirror-site` / `netcapture` / `serve` / `verify-mirror` 四方共用（三方各存一份 `localPathFor()` 本身就是 bug 源）。**查询感知**：查询串排序后编成文件名后缀并插在扩展名前（`x.jpg?v=1&width=600` → `x@@v=1&width=600.jpg`），所以 `?width=320/600/1200` 是三个文件而不是一个；含文件系统敏感字符或过长的降级为 `@@h<sha1-12>`（**任何**敏感字符都降级，而不是替换成 `_`——替换会让 `?q=a/b` 与 `?q=a?b` 撞名，等于把要防的坍缩又造回来）。**策略可配置、默认保守**：默认每个参数都进键（宁可多存不可坍缩），确认某参数不改字节后再 `--query-ignore v,cb` 或 `--query-only width,height`；有效策略由爬虫写进 `<mirror>/urlpath-policy.json`，其余三方读它，四方不可能漂 | `import { localRelPath, serveCandidates, loadPolicy } from "./lib/urlpath.mjs"` | objectandarchive 版（D-T1） | 高（本仓 fixture 实跑：同路径不同 query 落到不同文件；排序无关；敏感字符不撞名） |
| `lib/extract-refs.mjs` | **唯一的资产引用提取器**，爬虫与 `verify-mirror.mjs` 的闭包门共用——门若自带一份正则，就会继承被审爬虫的盲区，然后报出一个"引用集 − 磁盘集 = ∅"的假绿。五种写法：绝对 / 协议相对 / 根相对属性（含 `poster`/`content`/`data-src` 等懒加载拼写）/ **`srcset` 逐候选** / CSS `url()`。`srcset` 是逗号分隔候选表，只有第一条前面有引号，引号锚定的正则一组只看得见 1/5 条，而账本看上去是齐的 | `import { createRefExtractor } from "./lib/extract-refs.mjs"` | objectandarchive 版（D-T2） | 高（本仓 fixture 实跑：5 候选 srcset + imagesrcset 全数提取；旧版同页只提到 1 条 `src=`） |
| `lib/png.mjs` | 零依赖 PNG 编解码 + 图像统计/比对（恒输出 RGBA——kimi M7.3 colorType 事故的防呆） | `import { decodePng, encodePng, compare, imageStats } from "./lib/png.mjs"` | kimi 版 | 高 |

## TODO（未打包的缺口，需要时去源项目手工移植）

- **extract-i18n.mjs**（括号配平 + 隔离 vm 求值抽取 bundle 内数据成 JSON，键集交叉校验）——抽取式移植范式，但解析逻辑绑定具体 bundle 结构。移植自 `careers-kimi-rebuild/scripts/extract-i18n.mjs`。
- **regression.mjs**（状态全遍历 CDP 回归：localStorage 预种、逐状态截图断言）——状态机定义站点专用，probe.mjs 已覆盖单页探测。移植自 `samsyninja-rebuild/scripts/regression.mjs`。
- **gen-shells.mjs / gen_components.py**（DOM 外壳生成：零重写流水线 vs 保守切组件）——策略绑定站点类型（见 dom-shell-strategies 分支），不宜做成单一通用脚本。移植自 `landonorris-rebuild/scripts/gen-shells.mjs` / oryzo 的 `gen_components.py`。
- **dump-scene-graph.mjs（运行时场景图 dump 成数值账本）**——评估后不纳入：shopifydesign 那份是源站 bundle 里某个内部函数的逐字转写，换个站点连挂载点都不存在。范式（先 dump 源站数值再移植再数值验收）已由 `dump-timelines.mjs` 代表；需要时按目标站的引擎重写一份。
- **rogier 的 capture.mjs / analyze-home-bands.mjs**（行亮度剖面分析）——依赖 sharp，违反零依赖哲学，未纳入；等价能力可用 `lib/png.mjs` + 自写剖面重做。
- **racingshop 的 gapfill.mjs（协议相对 URL 归一重解）**——评估后不纳入：它修的是爬虫把 `//host/path` 拼成 `https://origin//host/path` 的 bug，而 `mirror-site.mjs` 已在提取阶段就把协议相对 URL 归一成 `https://host/path`，根因不再产生，留着只会诱导别人跑一个针对不存在故障的补丁。若历史镜像里已有这类损坏条目，一次性重解那份 manifest 即可，不需要常备脚本。
- **kimi 确定性冻结协议（八协议表）**——是文档/协议不是脚本，应进 references/，不在本目录范围。
- **layer-report.mjs（内联块四层归属门）**——`shopify-platform.md` §0.3 步骤 5 把它定为 M1 关账条件，但本 skill 暂未提供实现。机械部分通用（枚举 `<script>`、先掩 HTML 注释、块正文 sha256、与归属表 join、UNCLASSIFIED/AMBIGUOUS 非零退出），站点专用的是那张归属表本身与 §0.2 的判层判据。移植参照 `objectarchive-rebuild/scripts/layer-report.mjs` + `docs/layer-map.json`。
