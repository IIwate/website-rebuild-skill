# 第 0 步：范围判定与指纹路由（⛔ 阻塞门）

> **何时加载本文件**：拿到目标 URL 后、执行任何镜像/逆向动作之前。本步骤是阻塞门——判级未落地前，禁止进入 M0。全部判据来自 43 站边界探测实测【probe】，其中三个已复刻站（landonorris/lusion/noomo）作为阳性锚点全部通过校验。

## 1. 判级体系与 v0.1 范围政策

| 判级 | 定义 | v0.1 政策（判出后立即执行） |
|---|---|---|
| **A** | 完全适用：与六个已完成项目同物种，管线（镜像→beautify 行号逆向→转写移植→确定性验收）①→④无断点 | **主场，直接做**。进入 SKILL.md 主流程 M0，加载 `references/mirroring.md` |
| **B** | 适用但缺分场景指南：管线成立，断点全部是"缺某份操作指南" | **可做**。若对应分场景指南已存在则加载；尚缺则明确提示用户"该场景指南待补（v0.2+ roadmap），可继续但对应环节需自行摸索"，列出缺口名称后再动工 |
| **C** | 逆向模式需改变：声明式框架/资产化动画使"转写式移植"失效，需"重构式逆向" | **明确拒绝**并解释："该站为声明式架构（RSC/编译后组件树），本 skill 的转写式方法论不适用；需要的是重构式逆向（从运行时输出反推组件结构再重写），是另一门手艺，v0.1 不支持" |
| **D** | 方法论失效：行为主体在服务端，客户端无可移植目标 | **拒绝**。这是永久边界，不是待补指南 |
| **X** | 原站已消失：断在第 0 步，无镜像对象 | **引导用户**：告知原站已消亡及消亡形态，给 archive.org（Wayback Machine）抢救路径，或建议换目标 |

判级的真正变量不是框架名、年代或站点类型，而是**签名行为（让这个站获奖的那些效果）住在哪里**【probe】：
- 住在**静态资产**里（minified/未混淆 bundle、GLSL、GLB、视频、Rive 文件）→ A/B；
- 住在**声明式组件树**里（RSC flight 流、Vue/Nuxt 编译产物、R3F+Theatre）→ C；
- 住在**服务端函数**里（WordPress、电商库存、A/B 分桶、个性化）→ D。

## 2. 指纹探测流程（六步，curl-only 可执行）

准备：统一 UA、请求间隔 ≥1s、产物落 `probe/` 目录留证。

```bash
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
TARGET='https://example.com/awarded-path'   # 必须是获奖/目标路径本身，不是只探根域
mkdir -p probe
```

### 步骤 1：存活性（GET，路径粒度）

```bash
curl -sL -A "$UA" -o probe/a.html \
  -w 'code=%{http_code} final=%{url_effective} redirects=%{num_redirects} time=%{time_total}s\n' "$TARGET"
```

- **必须 GET，禁止用 HEAD（`curl -sIL`）作唯一判据**：API Gateway/CloudFront 前端对 HEAD 返回假 404（kprverse：HEAD 404 / GET 200）【probe】。
- **路径粒度**：根域 200 不等于作品存活——dontboardme 根站 200 但获奖路径 404【probe】。
- **最终 URL 同一性校验**：`final` 落点域 ≠ 目标域即 X 信号（darknetflix 301→netflix.com、umami-land 整域 301→google.com）【probe】。`curl -sIL` 表面 200 会掩盖 301 退役信号。

### 步骤 2：双抓 diff（确定性）

```bash
sleep 5
curl -sL -A "$UA" -o probe/b.html "$TARGET"
cmp -s probe/a.html probe/b.html && echo BYTE-IDENTICAL || { wc -c probe/a.html probe/b.html; diff <(fold -w 80 probe/a.html) <(fold -w 80 probe/b.html) | head -40; }
```

三分类，直接影响判级与后续验收门设计：
- **byte-identical**：理想镜像对象（apple、noomo 的 SSR 输出连 26KB 注水负载都逐字节一致）【probe】。
- **token 级差异**：仅 nonce/随机装饰串（kprverse 全文只差 12 个字符的装饰性编号；某些 WAF/CDN 每次注入的轮换 token 同类）→ 仍可镜像，验收门加掩码规则，**不要误判为动态渲染判 D**【probe】。
- **内容级差异**：文案/结构/数据随请求变（A/B 分桶、个性化注水）→ D 信号（airbnb）【probe】。

### 步骤 3：物种/年代校验（防"隐性下线"）

200 且确定 ≠ 是那个作品。**HTTP 200 的尸体**是五种消亡形态里最隐蔽的一种：

```bash
grep -io '<meta name="generator"[^>]*>' probe/a.html          # 平台/主题指纹
grep -c 'wp-content' probe/a.html                              # WordPress 密度
grep -oE '(Copyright|©)[^<]{0,80}(19|20)[0-9]{2}' probe/a.html | head   # license/版权年份
grep -ciE 'shopify|Prestige|Dawn|elementor' probe/a.html       # 商店主题替身
```

- **技术栈年代与获奖年份矛盾** → X（dontboardme 根站已是 Nuxt3 重建版）【probe】。
- **generator/依赖 license 年份晚于获奖期 + 获奖期技术栈残留 grep 为零** → 隐性下线判 X（prometheus-fuels 域名 200 但已换成 WordPress+Elementor，原 WebGL 站残留为零；simply-chocolate 原域名原品牌但代码已是 Shopify Prestige 主题；koox 根 200 是 Shopify 替身）【probe】。
- 域名活 ≠ 作品活：star-atlas 获奖原版被重建版**原地偷换**（域名不变）——如需复刻"获奖那一版"，须提示用户走 Wayback【probe】。

### 步骤 4：技术指纹（HTML 层）

```bash
# script 枚举必须先剥 HTML 注释（注释内脚本会污染清单）
perl -0777 -pe 's/<!--.*?-->//gs' probe/a.html | grep -oE '<script[^>]*src="[^"]*"' | sort -u
# 现代站可能没有任何 <script src>（Shopify Editions 三代全靠内联 import()）——再搜内联动态导入
grep -oE 'import\("[^"]+"\)' probe/a.html | sort -u
# 框架/架构标记
grep -c 'self.__next_f' probe/a.html                 # Next RSC flight → C 信号
grep -c '__reactRouterContext' probe/a.html          # React Router SSR → C 信号
grep -c '__NUXT__' probe/a.html                      # Nuxt → 不直接判级，过三判据（§4）
grep -o 'data-v-[0-9a-f]\{6,8\}' probe/a.html | wc -l   # Vue scoped 密度
grep -c '<!--\[-->' probe/a.html                     # Vue3 SSR fragment 注释
grep -ciE 'theatre|@react-three/fiber' probe/a.html  # 动画即数据 → C 信号
```

### 步骤 5：bundle 可逆向性

```bash
BUNDLE='https://example.com/assets/main.xxxx.js'
curl -s -A "$UA" -o probe/bundle.js -w 'size=%{size_download}\n' "$BUNDLE"
# 响应 <1KB → 极可能是缺 Referer 的拒绝页（landonorris 返回 32 字节拒绝页造成假阴性），补齐 Referer 重试
[ "$(wc -c < probe/bundle.js)" -lt 1024 ] && curl -s -A "$UA" -e "${TARGET%/*}/" -o probe/bundle.js "$BUNDLE"
# minification 形态预检（未混淆产物可跳过 beautify，省一道工）
wc -lc probe/bundle.js
awk '{ if (length($0)>m) m=length($0) } END { print "longest_line=" m }' probe/bundle.js
grep -c 'sourceMappingURL' probe/bundle.js
# MB 级单行文件先注入换行再 grep，防有界量词正则卡死
tr ';{}' '\n' < probe/bundle.js > probe/bundle.lines
grep -c 'WebGLRenderer' probe/bundle.lines    # three 认强签名（WebGLRenderer/REVISION），不认弱字符串 "three"
grep -c '/api/'         probe/bundle.lines    # >0 ⇒ 镜像阶段强制做运行时 API 快照（B 信号）
```

- 有公开 sourcemap（`sourcesContent` 完整，如 orano/linear）→ 直取源码替代 beautify 流程，但 linear 型 RSC 站仍按 C 处理（sourcemap 不改变行为归属）【probe】。
- 未混淆产物（bruno-simon 4.86MB esbuild 标识符全保留、star-atlas）→ 跳过 js-beautify，行号坐标系直接建在原文件上【probe】。

### 步骤 6：行为归属 → 出判级

综合 1-5 步回答一个问题：**签名行为的行为源在客户端 chunk 里吗？** 按 §3 判定树落判级，写一句话断点（"最先断掉的是第几步、为什么"），落盘 `probe/verdict.md`。

## 3. 判定树（按序执行，命中即停）

```
1. X 硬判据（任一命中 → X，停止）：
   ├─ 最终落点域 ≠ 目标主体域（301/302 转发、域名易主/抢注/平台回收）
   ├─ 目标路径 GET 404（且已排除 HEAD 假 404）
   ├─ 技术栈年代与获奖年份矛盾（根站是当代重建版）
   └─ 隐性下线：generator/license 年份晚于获奖期 + 获奖期技术栈残留为零
2. D 信号（坐实任一 → D）：
   ├─ wp-content 高密度 + WordPress generator meta（内容与行为主体在服务端 PHP+DB）
   ├─ 双抓为内容级差异（A/B 实验分桶、个性化注水 → 确定性验收彻底断裂）
   └─ 签名行为依赖 cart/checkout/GraphQL 数据面（行为主体是服务端函数）
3. C 信号（命中 ≠ 判 C，必须过 §4 三判据）：
   ├─ self.__next_f（RSC flight）/ __reactRouterContext
   ├─ __NUXT__ / __NUXT_DATA__ / data-v- 高密度 + <!--[--> fragment 注释
   └─ Theatre.js / R3F 标记（动画即数据、组件树声明式）
   → 三判据全"是" → 继续按 4/5 判 A 或 B；判据③为"否" → C
4. A 类签名（全部命中 → A）：
   ├─ 静态构建器产物（webpack/Vite/Astro/Browserify 皆可，年代无关——2019 老栈照样 A）
   ├─ ≥1MB 单体或少数几个 bundle（而非上百个组件粒度 chunk）
   ├─ 内联 three 认强签名：WebGLRenderer/REVISION 命中（弱字符串 "three" 不算）
   ├─ 双抓 byte-identical（或仅 token 级差异）
   └─ 无内容级 API 依赖（bundle 内 /api/ 为零或仅遥测）
5. 其余 → B：管线主线成立，但存在以下任一附加条件（即"缺哪份指南"）：
   多 chunk 大规模切片（stripe 74 分包）/ Shopify 平台层剥离（allbirds、mana-yerba-mate、
   pangram-pangram）/ SSR 快照锁定 + 端点 stub（hackernews）/ React-SSR 冻结与注水剥离 /
   行为外置进 Rive、glTF、KTX2 二进制资产的直搬与 runtime 锁定 / Nuxt-Vue SSG payload 展开
   （chungiyoo）/ 第三方 GCS 桶 + manifest 驱动资产发现（kodeclubs）/ 公开 sourcemap 直取 +
   WAF 轮换 token 掩码（orano）/ 运行时 API-headless CMS 快照（synchronized-studio）/ HAR 驱动镜像
   （persepolis）——逐项列名后按 §1 的 B 政策执行【probe】
```

杂交站可分层判级：kprverse 整体 C，但 three 子层（独立 chunk 的命令式代码）可局部按 A 手法转写【probe】。v0.1 政策仍按整体判级执行，分层结论写进 verdict 供用户参考。

## 4. 三判据规则（防 noomo 型误判，宪法级）

**"检测到 Vue/Nuxt/声明式框架 → 判 C"是被锚点站证伪的错误捷径**【probe】。noomo 是 Nuxt3 SSR 站（`__NUXT__`、74 处 `data-v-`），按单因子规则会误判 C，而地面真值是 A——它的签名动画（GSAP ScrollSmoother 滚动叙事）全在客户端 chunk 里，已被成功 1:1 复刻。框架标记命中后，必须逐条回答：

1. **内容可镜像性**：同 URL 短间隔 HTML 是否确定（byte-identical / 仅 token 级差异）？全部内容能否落成静态文件？
2. **签名交互的承载层**：获奖视觉/交互是否为可下载、可 beautify、行号稳定的**客户端命令式代码**（GSAP/three/WebGL）？
3. **客户端是否持有行为源本身**：客户端 chunk 包含渲染/交互逻辑本身，还是仅有服务端序列化结果（RSC flight）？

三判据全"是" → 按 A 处理（声明式框架只是抬高脚手架复刻成本，不改变签名行为的转写可移植性）。判据③为"否" → C（opal-tadpole 反例：Next App Router + RSC，服务端组件源码不下发客户端，只下发 flight 序列化结果——这才是真 C）【probe】。

区分口诀：**框架用于组织 DOM/状态的是脚手架；判级看的是签名行为存放在哪一层**。

## 5. 探测纪律（12 条协议修正，逐条为实测教训）【probe】

探测中的每一步都遵守本清单；违反任一条都产生过真实误判：

1. 存活性判定到**路径粒度**，且用 GET 不用 HEAD（kprverse API 网关对 HEAD 假 404）。
2. `curl -sIL` 表面 200 会掩盖 301 退役信号——必须校验**最终 URL 与目标主体同一性**。
3. 200 后必须做**物种/年代校验**：generator meta、主题 schema、依赖 license 版权年份、获奖期技术栈残留 grep。
4. bundle 响应 <1KB → 补齐 **Referer** 请求头重试（landonorris 的资产域缺 Referer 时返回 32 字节拒绝页，造成假阴性）。
5. script 枚举要**排除 HTML 注释内的脚本**。
6. 现代站 HTML 可能**没有任何 `<script src>`**（Shopify Editions 三代全靠内联 `import()`）——只认 script 标签会漏掉全部 JS。
7. **catch-all 假 200**：请求 `.map` 返回 index.html（other-side-of-truth）——对下载物做 content-type 与哈希碰撞校验。
8. bundle 内出现 `/api/` 字符串 ⇒ 强制做**运行时 API 快照**（synchronized-studio 的导航数据在 Contentful，实测 5 个运行时 API）。
9. MB 级单行文件先 `tr` 注入换行再 grep，防有界量词正则卡死。
10. 未混淆产物（bruno-simon、star-atlas）可跳过 js-beautify——先做 **minification 形态预检**再决定流程。
11. 有公开 sourcemap（orano、linear）时直取 sourcesContent 源码，替代 beautify 流程。
12. WAF/CDN 每次注入的轮换 token 是 nonce 级差异，**不要误判为动态渲染判 D**（把它当可掩码噪声即可）。

## 6. 常见坑

- **HEAD 假死 / GET 存活**：Lambda/API GW 托管静态站的常见形态，只用 `-I` 会把活站判 X【probe】。
- **平台名预判**：凭"这是 Webflow/大厂站"直接预判会错——webflow.com 预判不适用，实测有手写 GSAP/three.js bundle，判 A【probe】。判级只认指纹证据。
- **框架名单因子判级**：Nuxt 站可以是 A（noomo），Next RSC 站一定是 C（opal-tadpole）——差别在三判据③【probe】。
- **把 token 噪声当动态渲染**：nonce/装饰性随机串/WAF 轮换 token 都是可掩码的确定性站【probe】。
- **只探根域**：获奖路径 404 而根域 200 的站会被误判存活【probe】。
- **拖延镜像**：31 个历年获奖站 29% 已消失，集齐五种消亡形态（域名易主/转发、平台回收、域名抢注、路径移除、原地替换）。判级为 A/B 的瞬间，**第一时间全站镜像不是最佳实践，是抢救行为**——立即进入 `references/mirroring.md`【probe】。

## 7. 门判定与产出物

- 产出 `probe/verdict.md`：判级 + 一句话断点 + 关键指纹证据（命令输出摘录）+ B 类缺口清单（如适用）+ 三判据逐条回答（框架标记命中时必填）。
- **A** → 进入 M0，加载 `references/mirroring.md` 与 `references/recon-and-rating.md`。
- **B** → 同上，另按 §1 政策提示指南缺口。
- **C/D** → 按 §1 政策拒绝并解释，流程终止。
- **X** → 按 §1 政策引导 Wayback 或换目标，流程终止。
