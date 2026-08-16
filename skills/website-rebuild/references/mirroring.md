# 镜像取证全流程（M0 → M0.5）

> **何时加载本文件**：第 0 步判级为 A/B 后**立即**加载并动工。镜像先于一切分析——历年获奖站 29% 已消失（域名易主/平台回收/抢注/路径移除/HTTP 200 的原地替换五种形态俱全），"第一时间全站镜像作只读证据"不是最佳实践，是抢救行为【probe】。M0.5 断网跑通是阻塞门：镜像不可跑，不得进入逆向与移植。

## 0. 三条地基原则

1. **镜像神圣不可污染**：`legacy-mirror/` 磁盘文件抓下来后永不修改。它既是逆向的唯一原始依据，又是后续所有对拍验收的基准端——污染镜像 = 污染裁判【samsy】【noomo】【lando】。
2. **目录结构 = 源站 URL 空间的字节级还原**：页面按路径落成 `<path>/index.html`，资产按原路径落盘【noomo】【lando】。外部 host 资产落 `assets/<host>/<path>`【lando】。
3. **账本先行**：每个文件的来源 URL、字节数、sha256、下载结果都要有账（§3）。没有账本的镜像不能作为对账与验收的依据【6/6】。

三目录分离：`legacy-mirror/`（只读证据）≠ `public/`（运行资产）≠ `dist/`（部署产物）【oryzo】。运行侧消费镜像资产用符号链接/中间件映射，永不复制重资产（详见 `references/asset-management.md`）。

## 1. 镜像四遍法 + 一条实测

单一手段必漏。HTML 外壳信息量决定主手段：Webflow/静态站资源在 HTML/CSS 里可爬；Next/RSC 站资源藏在 hash chunk 与 flight payload 的转义字符串里，"链接跟随式爬虫第一层就走到头"【kimi】。所以标准动作是四遍互补 + 一条实测。

**每一遍都有别的遍够不到的"唯一发现区"，不可互相替代**——shopify.design 322 文件的逐遍战果【shopifydesign】：

| 遍 | 手段 | 净得 | 该遍**唯一**能发现的东西 |
|---|---|---|---|
| 1 | 正则 BFS 爬虫 | 226 文件 | HTML/CSS/JS 里**字面出现**的一切 |
| 2 | CDP 真实浏览器抓包（3 路由 × 桌面/移动） | **+44** | GLB 模型 / mp3 / favicon 序列 / draco wasm / 懒加载 chunk——**全部只在运行时被拼出来** |
| 3 | bundle 模板字面量静态求解 | **+52** | 编解码器分支的另一半（webm）、完整 13 组 favicon 序列、`.woff.txt` 字体变体 |
| 4 | 静态闭包校验（引用集 − 磁盘集） | **+1** | 抓包与求解都够不到的 chunk（要点开特定 modal 才加载的 `WistiaPlayerWrapper-*.js`） |

反过来说：webm 分支只有静态求解拿得到、GLB 只有抓包拿得到、那个 wrapper chunk 只有闭包校验拿得到。**少跑任何一遍都会留下静默缺口**。

### 第一遍：正则 BFS 爬虫（`scripts/mirror-site.mjs`）

rogier 首创、noomo/lando 三代实战传承的骨架【rogier】【noomo】【lando】：

- **种子**：全部已知页面路由 + 已知关键资产路径（rogier 60 个初始路径；lando 从 `/` 爬 7 页并用 `/404-page-not-found` 探测出 404 模板）。
- **提取正则集**：对每个文本响应（HTML/JS/CSS/SVG/JSON）提取 `href/src/poster/content` 属性、CSS `url()`、动态 `import()`、`new Worker("...")`、`fetch("...")`、资产目录前缀字面量（`/assets|_astro|audio|content|fonts|images|models|workers/` 类）、按扩展名白名单匹配的绝对 URL【rogier】【noomo】。
- **格式感知深挖**：下载 `.gltf`/glTF 后解析 JSON，把 `buffers[].uri`、`images[].uri` 递归入队【rogier】【noomo】；扫描页面 chunk 内数据结构推导资产路径（rogier 用 `thumbnail:{...}` 正则推出 `/images/thumbs/*`——数据藏在 JS 里，DOM 抓不到）【rogier】。
- **host 白名单**：外部资源只收白名单 CDN 域（lando 12 个），防爬飞【lando】。
- **迭代到不动点**：每轮下载产生的新文本再过一遍正则，直到无新 URL（lando 4 轮——CSS 里的字体、JS 里的 .riv 在后续轮次才被发现）【lando】。
- **纯静态解析变体**：bundle 结构清晰时可不用爬虫，直接从 bundle 静态解析出完整资产清单逐个 curl（samsy 107 文件约 260MB 全部来自 bundle 静态解析）【samsy】。

### 第二遍：真实浏览器 CDP 抓包补录（`scripts/netcapture.mjs`）

静态解析对**运行时拼接的 URL**天然失明。headless Chrome 实跑全路由 × 桌面/移动双视口、走完整个滚动/交互流程，用 CDP 记录实际发出的同源请求，与磁盘 diff 出 GAP 清单逐项补录【kimi】：

- kimi 实测补齐 23 个运行时拼接资源：`avatar_01..16.png` 的序号、`buttons/zh-CN/` 的语言目录都是运行时拼的【kimi】。
- samsy 同思路：Chrome 实跑（/ → WORKS → ABOUT）抓 network 补录 `preloader.png`、worker chunk【samsy】。
- 轻量变体：真实 Chrome 加载后执行 `performance.getEntriesByType('resource')`，取运行时实际请求的同源路径逐一核对镜像命中（noomo 56 路径全命中）——静态爬取之外的运行时闭环【noomo】。
- 工具零依赖：Node 22+ 内置 WebSocket 直连 CDP，不装 puppeteer【kimi】【samsy】。

### 第三遍：bundle 模板字面量静态求解（人工）

抓包也有盲区——滚动深度够不到、条件分支不触发的资源，回到 bundle 里人工解模板字面量：

- `` `/models/crystal${e}.glb` `` 把 `${e}` 求解为 0–6 逐个补抓【noomo】。
- deck 深处资源（`about-us/process/step1..4.png` 等 6 个）靠解析 bundle 模板字面量补齐【kimi】。
- 基址变量拼接：lando 的 GL 资产基址 `vQ="https://lando.itsoffbrand.io/gl"`（4 GLB + 3 HDRI + 解码器 + MSDF 字体）与 Rive 基址 `mj=".../rive/"`（8 个 .riv）都是变量拼接，静态正则不可见——从 bundle 读出基址后枚举补抓【lando】。
- 语言变体：浏览器只请求当前语言那份，`en-US` 等按同构路径手工拉【kimi】。
- **能力探测分支**：`` `/video/${i}.${SU}` `` 里的 `SU` 由 `canPlayType` 决定，抓包只走当前浏览器那半边——两个分支都要求解补抓（详见 §8 盲区 checklist）【shopifydesign】。

### 第四遍：静态闭包校验（引用集 − 磁盘集 = ∅）【shopifydesign】

前三遍跑完仍会漏一类东西：**既不字面出现在 HTML、又不被抓包触发、也不是模板拼接**的 chunk。shopify.design 的 `WistiaPlayerWrapper-*.js` 三条全占——它是普通 import 名（模板求解看不见），要点开特定视频 modal 才加载（6 次路由 × 视口抓包全程未触发），任何 HTML 里都没有它。

抓法成本极低（一个 grep + 一次集合差），却能兜住前三遍的共同盲区：

1. 在**所有已镜像的 js/css/html** 里 grep 构建器产物的文件名形态 `<name>-<hash>.{js,css}`，取并集 = **引用集**；
2. 列出磁盘上同类文件的 basename 集合 = **磁盘集**；
3. 做差 `引用集 − 磁盘集`，逐个补抓（走与前三遍同一个下载器，账本才是一本），直到差集为空。

```bash
# 引用集（hash 长度按目标站构建器调整；Vite 常见 8 位）
grep -rhoE '[A-Za-z0-9_.$-]+-[A-Za-z0-9_-]{8}\.(js|css)' legacy-mirror \
  --include='*.js' --include='*.css' --include='*.html' | sort -u > /tmp/refs.txt
# 磁盘集
find legacy-mirror -type f \( -name '*.js' -o -name '*.css' \) -exec basename {} \; | sort -u > /tmp/disk.txt
comm -23 /tmp/refs.txt /tmp/disk.txt        # 输出非空 = 还有没抓到的 chunk
```

shopify.design 实测 26 个引用 vs 25 个文件 → 缺 1，补抓后归零。**差集为空是 M0 关账条件之一（§10）**；差集里若确有故意不入库的外部 chunk，按 §6 外部依赖决策表逐条登记，不许无声留着。

### 逐 URL 实测状态码（不可省略）

**服务端重定向在客户端产物里零留痕**：光读 bundle 永远看不出 `/zh-cn/*` 是 301——必须对每条路由裸 fetch 实测状态码并记账【kimi】。注意用裸 fetch 而非浏览器（浏览器自动跟随重定向，正是造假文件的动作）。

## 2. redirect: "manual" 纪律（红线）

爬虫**绝不默认跟随重定向**。kimi 的著名教训：第一版爬虫用 `redirect: "follow"`，把 301 目标的 body 写在来源路径下，**凭空造出 10 个假文件——"把 301 误当成 200"**【kimi】。修复方案三件套：

1. 爬虫 fetch 一律 `redirect: "manual"`；
2. 重定向单独记入 `redirects.tsv` 账本（"这是源站行为，不是爬虫记账"）；
3. 独立验证脚本用裸 fetch 断言每条重定向的**状态码本身**——Next 的 `permanent: true` 发 308 而源站发 301，门必须断言状态码而不只断言"有重定向"【kimi】。

## 3. manifest 账本体系

镜像目录旁必备的账本（kimi 制度最完整，按需裁剪）【kimi】【samsy】【noomo】【lando】：

| 账本 | 内容 | 作用 |
|---|---|---|
| `inventory.tsv` | 逐文件 sha256 权威清单 | 一切资产比对的唯一来源【kimi】 |
| `manifest.tsv` / `mirror-manifest.json` | 下载流水：url → path/bytes/type/OK-FAIL，含 mirroredAt/downloaded/failed | 留证 + 重刷依据【samsy】【noomo】【lando】 |
| `redirects.tsv` | 源站重定向逐条（来源、目标、状态码） | 重定向是源站行为，需回放与断言【kimi】 |
| `netcapture.tsv` | 抓包 HAVE/GAP 对账表 | GAP=0 是 M0 关账条件之一【kimi】 |
| `external.txt` | 外部 URL 逐条甄别（kimi 47 条） | 喂给 §6 外部依赖决策表【kimi】 |

特殊载荷单独镜像：RSC flight payload 带 `RSC: 1` 头取回的另一份 body 存 `_rsc/`，其中含逐请求随机 nonce，**diff 前必须 mask**【kimi】。bundle 内联的 base64 资产（LUT、SMAA 纹理）提取到 `_extracted/`（分析产物区，与原件字节纯净区分开）【noomo】。

## 4. 镜像神圣 + 服务层改写

一切本地化适配在**服务层响应时动态完成**，磁盘纯净【samsy】【noomo】【lando】。`scripts/serve.mjs`（samsy 首创响应层改写，kimi→noomo→lando 四代传承）职责清单：

- **MIME 补全**（glb/hdr/ktx2 等）+ **Range 请求**支持（视频可 seek）【noomo】。HLS 站另需 `.m3u8`/`.ts`/`.m4s` 正确 MIME，否则播放器拒绝清单、补录下来的阶梯照样不播（`scripts/serve.mjs` 已内置）【racingshop】。
- **CDN 基址动态改写**：源 bundle 无条件写死 BunnyCDN 前缀且该 CDN 要求同源引用 → 响应层把基址替换为 `/cdn/` 并映射回本地目录【samsy】；外部 host URL 统一重写为 `/ext/<host>/` 路径【lando】。
- **遥测 stub**：GA 反代路径返回 JS stub，不外联【lando】。
- **404 语义复刻**：未知路径回落源站 404 模板并返回真 HTTP 404（平台语义）【lando】。
- **RSC 路由**：带 RSC 请求头的请求路由到 `_rsc/` 镜像【kimi】。
- **probe 注入口**：`?__probe` 时在 `<head>` 首部注入确定性 shim，无 query 时输出字节不变【noomo】。
- **SRI 剥离**：服务层改写过的文本字节无法匹配原 integrity 哈希，需剥离 SRI 属性并**登记为偏差**【lando】。

例外条款：rogier 一代曾直接改磁盘 bundle（禁 service worker、detect-gpu benchmarks 本地化、GPU fallback），但**每处重写登记在案**（"Known local JS rewrites"）并在对比时扣除【rogier】——后代演进为"干脆不改磁盘"。如确实不得已改磁盘，必须照 rogier 的登记纪律执行。

## 5. 断网跑通验收门（M0.5，⛔ 阻塞门）

"镜像可跑才能当对拍基准，且实跑必然暴露静态解析盲区"——隐藏关键步【lando】。**先过 §5.1 的镜像自检门**（本门的每一项都拿镜像当输入，镜像错了它照样能全绿），再用 `scripts/serve.mjs` 伺服镜像，断网（或禁外联监控下）执行：

验收标准（全部满足才关账）：
- **零 404**：noomo 断网服务 99/99 URL 全 200【noomo】；samsy 全新加载零 404【samsy】。
- **零控制台错误**：全路由 + 404 页跑 `scripts/probe.mjs` 探针全 CLEAN，首页含**全滚动**【lando】。
- **零外联**：无任何对源站/CDN 的真实网络请求【samsy】。
- **重定向断言**：kimi 7/7 路由零 4xx + 5 条重定向逐条断言（裸 fetch 独立跑，用 `scripts/verify-routes.mjs` 对镜像伺服执行路由/重定向/状态码契约）【kimi】。
- **关键流程走通**：首访交互流程实际走一遍（samsy 首访 /tutorial 流程走通）【samsy】。
- **GAP=0 对账**：netcapture 对账表无未销账条目【kimi】。

实跑必然暴露盲区并当场补录，这是预期内流程而非失败：lando 实跑发现 head/helmet/glass 的 13 件 PBR 纹理"由纹理集拼接，正则不可见"，只有真跑看网络请求才能发现【lando】。

M0.5 之后，`serve.mjs` 终身兼任后续所有对拍的"源站参照服"（如 `PORT=3200 SERVE_ROOT=legacy-mirror`）【noomo】。

### 5.1 镜像要有属于自己的门：下游全绿证明不了镜像对【objectarchive】

**下游所有门测的是"渲染得出来吗"，不是"字节对不对"。** 零 404、零控制台错误、零外联、像素对拍——每一道都跑在镜像**之上**、拿镜像当输入。于是镜像是全项目的证据基座，却是**唯一没有独立验收**的一环：镜像错了，下游照样可以全绿。

实证（objectandarchive M0）：图片 CDN 是**查询参数化的变换接口**——`x.jpg?width=320` / `?width=600` / `?width=1200` 是三份不同字节的资源。而 url→路径映射只看 `pathname`，三个尺寸**坍缩成同一个文件**（谁最后写谁赢，142 条 CDN 路径里 57 条受影响）；serve 端每个 `?width=` 又都回那同一个文件，页面照样把图渲染出来 → **零 404 门在错镜像上变绿**。这类错不会在 M0.5 暴露，会一路活到像素对拍才以"某张图糊了 / 尺寸不对"的形态出现，那时归因成本已经翻几倍。

因此镜像自检门与 M0.5 断网门**并列，且跑在它之前**。断言面四项：

- [ ] **映射单射性**：把账本里全部 URL 过一遍 url→本地路径的映射函数，**任何两个不同 URL 落到同一路径即红**。这一项直接抓查询参数化资产；修法是让映射**查询感知**（如 `x.jpg?v=1&width=600` → `x@@v=1&width=600.jpg`），并且**镜像端、serve 端、闭包校验三方共用同一个映射实现**（写成一个模块，不许各写一份——三份实现分歧本身就是新的静默错源）。**这条的通用形态**（工具链里凡是"两处以上要算出同一个答案"的逻辑一律单一实现，含识别信号与代价）见 `verification-gates.md` §2.1.1。
- [ ] **账本与磁盘一致**：`inventory.tsv` 的逐文件 sha256 与磁盘现状重算一致；文件数、字节数对得上；"账本有磁盘无"与"磁盘有账本无"**两个方向都要报**。
- [ ] **闭包完整性**：引用集 − 磁盘集 = ∅（§1 第四遍），差集里每一条在 `external.txt` 有决策。
- [ ] **抽样回源核对**（联网时做，可选）：从账本随机抽 N 条重新拉一次比 sha256。它是唯一能机器化抓住"抓下来的其实是拒绝页 / catch-all 兜底页"的断言（§9 里"小响应告警""catch-all 假 200"两条坑的自动化形式）。

本 skill 自带 `scripts/verify-mirror.mjs`；objectandarchive 侧另有一个项目脚本 `verify-offline.mjs`（不在本 skill 内）。两者分工明确：**前者管"镜像本身对不对"，后者管"镜像跑起来对不对"**。

## 6. 外部依赖决策表

抓不进镜像/不该入库的依赖（授权字体、第三方 SaaS、CDN）单独列表，**逐项显式决策**，三选一【oryzo】【samsy】【kimi】：

| 处置 | 适用 | 判例 |
|---|---|---|
| 保留原引用不入库 | 授权条款禁止自托管的资产 | Adobe Fonts (Typekit) CSS 引用保留，副本仅存 `legacy-mirror/external/` 供参考【oryzo】【samsy】 |
| 换端点/本地化 | 可自托管的 vendor 资源 | detect-gpu 的 unpkg benchmarks 指向本地 `/vendor/`【rogier】；Rive WASM 从 `/ext/unpkg.com/...` 本地提供【lando】 |
| 接受降级 | 纯统计/非行为依赖 | GA/Cloudflare Insights 不接入【oryzo】【samsy】 |

特别小心有行为副作用的第三方：samsy 的 PartyKit 多人服务直连的是**源站生产房间**——决策表里要写明礼仪边界（"别广播"）【samsy】。bundle 内出现 `/api/` 字符串 ⇒ 强制做运行时 API 快照（导航数据可能在 headless CMS 里）【probe】。

## 7. 跨域与受保护资产的抓取

- **补齐 Referer 请求头**：部分资产域要求同源 Referer，缺失时按其约定返回 403 → 抓取请求按要求带上 `Referer: https://<目标站>/`，满足服务器对合法引用的期望【lando】。
- **小响应告警**：bundle 响应 <1KB 极可能是拒绝页（landonorris 的资产域缺 Referer 时返回 32 字节拒绝页，曾造成探测假阴性）——按字节数守卫，触发即补齐 Referer 重试【probe】。
- **CDN 跨域引用的运行期处理**：镜像抓取解决"抓得下来"，本地回放还要解决"bundle 会去请求 CDN"——用 §4 的服务层基址改写把引用指回本地，不改磁盘【samsy】。
- 遇到需要登录态、付费墙或授权的资产（本 skill 适用范围之外），停止并告知用户，不尝试获取。

## 8. 镜像盲区 checklist

静态爬取**必漏**的资产类型，逐项建"从源站补录"通道并 checklist 化销账【oryzo】【samsy】：

- [ ] worker 运行时才 fetch 的文件（WASM 排序 worker、baker.worker）【oryzo】【samsy】
- [ ] 懒加载资源（画廊图片、preloader 图、懒加载 chunk）【oryzo】【samsy】
- [ ] **流媒体清单阶梯**：HLS/DASH 的 master `.m3u8`/`.mpd` 能被静态爬到，但 rendition 播放列表与 `.ts`/`.m4s` 分片是播放器**运行时**才请求的，静态爬取全漏（racingshop 实测只抓到 master + 封面 MP4，漏了 3 个 rendition + 12 个分片，靠探针报 404 才暴露）——用 `scripts/gapfill-video.mjs` 递归解析清单阶梯补录【racingshop】
- [ ] 移动端变体：oryzo 规则是扩展名前插 `_MOBILE`（纹理上限 800px vs 桌面 2560px）——逆向出命名规则后批量补抓【oryzo】；双端纹理变体（桌面 webp + 移动 ktx2）【lando】
- [ ] 仅特定 query 触发的 chunk（samsy 的 `?editor` / `?gameboy` 才加载的 editor-*.js / gb-*.js）【samsy】
- [ ] 纹理集拼接路径（正则不可见，只有实跑网络请求可见）【lando】
- [ ] 非当前语言的本地化资源（浏览器只请求当前语言）【kimi】
- [ ] 抓包滚动深度够不到的深处资源（回第三遍模板字面量求解）【kimi】
- [ ] 字体文件（rogier 首轮漏抓，后补齐并验证与源站逐字节一致）【rogier】
- [ ] **编解码器 / 能力探测分支变体**：源站按浏览器能力选资产格式，抓包只会拿到当前浏览器那一半分支——
      `SU = document.createElement("video").canPlayType('video/mp4; codecs="hvc1"') !== "" ? "mp4" : "webm"`，
      Chrome 走 mp4，**另一半 4 个 webm 文件只有第三遍静态求解拿得到**；同类还有 webp/avif、ktx2/basis 的能力分叉。
      做法：在 bundle 里 grep `canPlayType` / `createImageBitmap` / 扩展名三元表达式，把**每个分支的取值全枚举**后补抓【shopifydesign】
- [ ] 前三遍共同盲区：既不字面出现、又不被抓包触发、也非模板拼接的 chunk → 用第四遍静态闭包校验兜底【shopifydesign】
- [ ] **查询参数化的资产变换接口**：图片 CDN 把尺寸/裁剪/格式写在 query 里（`x.jpg?width=320|600|1200`、`?crop=center`、`&format=webp`），**同 pathname 不同字节**。按 pathname 落盘会让整组变体坍缩成一个文件，而下游零 404 门照样绿（§5.1）。做法：映射与落盘**查询感知**，并把"同 pathname 多变体"单独清点（objectandarchive：142 条 CDN 路径中 57 条有多个 `?width=` 变体）【objectarchive】
- [ ] **`srcset` 的非首个候选**：`srcset` 是逗号分隔的候选表，多数爬虫正则要求候选前有引号，于是**每组只命中第一条**——objectandarchive 68 组 × 约 5 条，约 270 个变体对第一遍完全隐形；浏览器按 DPR/视口只请求其中一条，**第二遍抓包也补不全**。做法：`srcset` / `imagesrcset` 属性单独按逗号拆开逐条入队【objectarchive】
- [ ] **不带尾斜杠的裸主机基址常量**：代码常写 `const B="https://cdn.example.com"`、`window.shopUrl='https://site.com'` 再拼路径；只匹配"带尾斜杠"形式的提取/改写规则对它天然失明——objectandarchive 实测因此漏了 4 个遥测外联 + **2 个到线上源站的主题资产请求（那份资产一直在盘上）**。同类还有 JSON 转义的协议相对写法 `\/\/host\/`。做法：提取与改写规则覆盖**裸主机 / 带尾斜杠 / 协议相对 / JSON 转义**四种形态，且**探针要报完整 URL 而不只是 host 直方图**，否则看不出漏的到底是哪一条【objectarchive】

销账方式：每项要么"已补录（见 manifest 行）"，要么"确认源站不存在此类"，不许留空。

## 9. 常见坑

- **redirect follow 造假文件**：默认跟随重定向会把 301 误当成 200，凭空造出假文件——`redirect: "manual"` 红线【kimi】。
- **服务端行为零留痕**：redirects/状态码必须逐 URL 实测，读产物读不出来；308 vs 301 这种差异只有断言状态码本身才能抓住【kimi】。
- **catch-all 假 200**：请求 `.map`/任意路径返回 index.html（other-side-of-truth）——对每个下载物做 content-type 校验与哈希碰撞检测（大量文件同 hash = catch-all 兜底页）【probe】。
- **零 404 门在错镜像上变绿**：下游每一道门测的都是"渲染得出来吗"，不是"字节对不对"。查询参数化资产坍缩成一个文件后，serve 端每个尺寸都回同一份文件、页面照常渲染，四道验收门全绿——**镜像必须有属于自己的门**（§5.1）【objectarchive】。
- **HTML 里没有 `<script src>`**：现代站可能全靠内联 `import()`（Shopify Editions 三代）——爬虫只认 script 标签会漏掉全部 JS【probe】；script 枚举还要排除 HTML 注释内的脚本【probe】。
- **RSC nonce 假 diff**：`_rsc/` 载荷含逐请求随机 nonce，不 mask 直接 diff 会误报不确定【kimi】。
- **镜像跑不通就开工**：镜像没过 M0.5 门就逆向/移植，等于没有对拍基准，后续一切"像不像"都无法归因【lando】【samsy】。
- **探针自身盲区**：镜像 CSS 被 Chrome 因 SRI 校验**静默拦截**，安全报错走 CDP Log 域——探针若只监听 Runtime/Network，M0.5 的"CLEAN"存在盲区（`scripts/probe.mjs` 已并入 Log 域监听；自查时确认这一点）【lando】。
- **后台标签节流伪装假死**：M0 阶段在后台标签实跑镜像，rAF 节流 + gsap lagSmoothing 会把站点冻成假死，误判"镜像坏了"（noomo M0 亲历，samsy 曾因此误改源码后撤销）——无头/实跑一律带 anti-throttling 旗标或保持前台【noomo】【samsy】【oryzo】。
- **直接改磁盘镜像**：一切适配走服务层；确实不得已改磁盘必须逐处登记并在对比时扣除（rogier 一代纪律）【rogier】。

## 10. M0/M0.5 关账条件（产出物清单）

- [ ] `legacy-mirror/`：目录结构 = 源站 URL 空间，磁盘纯净、只读
- [ ] 账本齐备：manifest（含 sha256）、redirects.tsv、netcapture GAP 对账（=0）、external.txt
- [ ] **静态闭包校验通过**：全镜像的 `<name>-<hash>.{js,css}` 引用集 − 磁盘集 **= ∅**（差集里的外部 chunk 须在 external.txt 有决策）【shopifydesign】
- [ ] **镜像自检门通过**（§5.1，跑在断网门之前）：映射单射性 / 账本与磁盘 sha256 一致 / 闭包完整 /（联网可选）抽样回源核对
- [ ] `scripts/serve.mjs` 可伺服镜像，服务层改写清单逐项登记
- [ ] 断网验收全绿：零 404 / 零控制台错误（probe CLEAN，含全滚动）/ 零外联 / 重定向状态码断言通过
- [ ] 外部依赖决策表：每条外部 URL 有归属决策（保留引用/换端点/接受降级）
- [ ] 镜像盲区 checklist 逐项销账
- [ ] 版权预评估已出（哪些资产不可再分发 → 是否公开部署的初步决断，详见 `references/legal-and-deploy.md`）

全部勾完 → M0 关账，进入 M1 逆向（`references/reverse-engineering.md`）。
