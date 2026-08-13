# verification-gates.md — 验收门选型与失效模式

> **何时加载本文件**：为任何里程碑设计验收方式之前必须加载；以及当一个门"全绿但用户/真机发现了问题"时回来查失效模式。像素/字节对拍类门的前置条件（冻结与驱动）在 `references/determinism.md`，两份配套使用。

## 0. 总原则

- 验收标准必须是**机器可断言的绿灯**：`failures: []` 空数组【rogier】、CLEAN 退出码【lando】、逐字节 diff 为空【noomo】、94 项契约检查【kimi】——不是"看起来像"。
- "目测像素会骗人，量化比对要用脚本量截图"【oryzo】。
- 门是分层的，成本递增；**底层门先建立，此后全项目期保持全绿**（noomo 的 SSR 门在 git log 里几乎每条 commit message 都以 "SSR gates green" 结尾）【noomo】。
- 每类"像不像"都要有对应的数字化手段：行亮度剖面、逐 band delta、颜色时间轨迹、computed style/rect 逐值对比、canvas-only 隔离对比、DOM 身份断言【rogier】。
- 门本身会失效。全绿 ≠ 正确，见 §4。

## 1. 五类门定义与适用条件

### 1.1 SSR/DOM 字节门（最先建立）

- **定义**：SSR 输出 / 静态 HTML / payload / config 与镜像做逐字节（或空白归一化后）diff，diff 为空即绿。
- **实例**：
  - noomo `verify-ssr.mjs`：9 条路由的 body DOM / `__NUXT_DATA__` payload（1804 字节逐字节，连 `<html  lang="en">` 双空格都对齐）/ config script（掩掉 buildId），外加尾部脚本顺序与未知 slug 404 行为，每 commit 回归【noomo】。
  - oryzo："构建产物 body 与源站空白归一化后 diff 为空" + 浏览器 scrollHeight 46410px 与源站一致【oryzo】。
  - kimi `verify-routes.mjs`：94 项契约（head 8 字段 × 5 路由、12+8 条重定向**含状态码**与尾斜杠链、怪癖可达性、assetPrefix、favicon）【kimi】。
- **适用条件**：站点有 SSR/静态 HTML 产物。**应最先建立、终身保持全绿**——"字节层先行使后续所有视觉 debug 都能排除 DOM/payload 差异"【noomo】。
- **skill 脚本**：`scripts/verify-ssr.mjs`、`scripts/verify-routes.mjs`。
- **搭建注意**：
  - 含随机量的部分（RSC 逐请求 nonce、buildId）diff 前必须 mask【kimi】【noomo】。
  - 重定向门必须断言**状态码本身**：Next `permanent:true` 发 308 而源站发 301，不断言状态码就漏【kimi】。
  - 状态码断言用裸 fetch 独立实测，不走浏览器——浏览器自动跟随重定向正是当初镜像栽跟头的动作【kimi】。
  - 验证仪器（probe shim 等）注入必须 query 门控，无参数时输出字节不变，否则污染本门【noomo】。

### 1.2 整页像素 byte-equal 门

- **定义**：冻结全部熵源后，双侧同位姿截图（或 canvas `getImageData`/`readPixels` 直读），FNV 哈希相等即绿。
- **实例**：kimi 32 个整页位姿（桌面 1440×900 × 8 + 移动 390×844 × 7 + 平板 768×1024 × 7 + hover 射线（CDP 真实鼠标）+ deck 内嵌覆盖层 ×2 + 过渡中间帧 + campus/social 独立页 6 位姿）与镜像逐字节相同；另有 4 个画布字节门（月球/星云/pixel-flow/WebGL Dither `readPixels` 直读）【kimi】。
- **适用条件**：DOM 渲染为主、熵源可枚举冻结的站点。前提假设："同机同版本 Chrome 的 DOM 渲染是逐字节确定的"【kimi】——前提与九种冻结协议见 `references/determinism.md`。
- **skill 脚本**：`scripts/pixelcompare.mjs`（byte-equal 档）+ `scripts/lib/png.mjs`。
- **搭建流程**：每个门自起镜像/复刻两个服务器 → 同一冻结协议驱动到同一位姿 → 截图/直读 → 哈希比对 → 产物成对入库（kimi 的 `docs/*-check/`；`side-by-side.mjs` 渲染 [镜像|重建|热力图] 合成图到 `docs/side-by-side/`，26 对全部 meanAbsDiff 0）【kimi】。
- **附带用法**："应当不影响画面"的架构改动用"位姿哈希不变"关账（kimi M7.1 加动态加载后桌面 8 位姿哈希不变，证明改造像素零影响）【kimi】。

### 1.3 量化像素对拍门（非 byte-equal）

- **定义**：双侧同参数、同状态截图后计算量化指标，指标落进显式容差即绿；**必须配噪声归类纪律**（§6）。
- **实例与指标**：
  - rogier：行亮度剖面差 ±4 灰阶（sharp 按行采样灰度，x 取 20%–80% 区间）+ 逐 band delta 收敛记录（修复前 +0.0691 → 修复后 -0.0011，残差用数字关账）+ 换页颜色时间轨迹逐点对齐（每 120ms 采样计算色，per-sample RGB delta ≤6）【rogier】。
  - oryzo：按 section 对齐的 14 个滚动点、同视口 1456×830，平均亮度差 ±0.5【oryzo】。
  - samsy：1280×800 截图 64×40 网格逐格色差相似度（home 99.4% / works 98.3% / about 98.6%）+ 最差格逐一目检归因——"因场景是活的（视频/glitch/粒子随机相位），刻意用粗网格而非逐像素 diff"【samsy】。
  - noomo：六滚动检查点（t∈{1.2, 6.5, 10.5, 15, 17.5, 19.3}）同帧对拍，双侧参考帧入库，逐帧登记差异（F1/F2/F3）【noomo】。
- **适用条件**：WebGL/视频/随机相位等"活场景"，逐字节不可行时的降级。
- **skill 脚本**：`scripts/pixelcompare.mjs`（网格/剖面档）。
- **辅助手段**：canvas-only 对比（隐藏 DOM 只比 WebGL 输出，把"DOM 截图噪声"从归因中剥离）、computed style / 几何矩形逐值对比（CDP 抓两站同一元素最终计算值逐值比）【rogier】。

### 1.4 数值探针门

- **定义**：不比画面，直接断言内部状态/数学层数值。
- **实例**：
  - rogier：16 步激活顺序数组逐项断言；**68 处 mode 字符串比对**——把源码语义编码成 `source-<符号>-<行为>` 常量嵌进运行时状态，实现端与探针端共享同一组常量逐一比对，"实现遵循了哪条源码语义"从口头承诺变成自动回归项【rogier】。
  - samsy：引擎状态断言（15 NPC / 7 舞者 / instancer / 25 作品）+ `--full` 状态全遍历（IDLE→WORKS→ABOUT、皮肤机、Konami 派对链）【samsy】。
  - kimi：拟合 661/661 最大残差 4.75e-7、事件重放 p95 残差 0.0019（不起浏览器的数学层重放）【kimi】。
  - noomo：相机位姿与基准插值小数点后三位全等、42 层与源站 `X.create` 全序一致、RT 尺寸精确值（"3650×1930→1460×772 = 视口×dpr×padding"）【noomo】。
- **适用条件**：内部状态可暴露——复刻侧自建句柄（noomo 的 `window.__sweet3`、rogier 的 `window.__rogier*Probe`，均 query 门控并登记偏差）；源站侧读不到 state 时用拟合/重放绕过【kimi】。数据驱动动画必配此门（见 `references/animation-recovery.md`）。
- **skill 脚本**：`scripts/probe.mjs` 的 `--eval/--evalAfter`（延迟二次求值，用于断言异步导航结果【lando】）。

#### 1.4.1 场景图数值门（§1.4 最强的一个子类）【shopifydesign】

- **定义**：把引擎"读 DOM 建场景"的那个函数**逐字转写成独立探针脚本**，两侧各跑一次，输出结构化 JSON 基准，**逐字段数值 diff**。差异为空即绿。
- **适用判据（唯一一条）**：**引擎的场景构建是 DOM/CSS 的纯函数**——即场景是 (HTML 字节, CSS 字节, 视口, scrollY) 的函数。取证信号：同一个函数里同时出现 `querySelectorAll("[data-*]")` + `getBoundingClientRect()` + `getComputedStyle()`。命中即可建门。
- **实例**【shopifydesign】：shopify.design 的 `QL` L30737–L30899 逐字转写为项目侧的 `dump-scene-graph.mjs`（零依赖、裸 CDP；**本 skill 不提供该脚本**——它是那个站 bundle 内部函数的逐字转写，换个站连挂载点都不存在，必须按目标站的引擎重写一份），产出 `objects[]`（world 坐标/尺寸/字号/对齐/行高/字距/圆角/旋转/颜色）+ `carousels[]`（`--card-width`/`--card-height`/`--card-gap` 与逐卡矩形）+ `docHeight`，入库 `docs/scene-baseline/`。
- **实测数据**：
  - 镜像自比（未冻结）：63 个对象里 2 个处于 mid-tween，**7 个字段漂移**；
  - 镜像自比（冻结后）：**0 字段差异**；
  - 镜像（冻结）vs 线上：63 个场景对象 + 轮播记录 + docHeight **全部 0 差异**（唯一需要归一的是镜像侧 `/ext/` URL 改写）。
- **为什么优于像素门**：① **精确**——数值全等或不全等，没有容差、不需要噪声归类；② **可归因**——差异直接指向"哪个对象的哪个字段"，像素门只能告诉你"某处不像"；③ **它恰好卡住唯一会真正破坏 3D 的东西**：CSS 布局漂 1px = 3D 物体位移 1px×全局缩放。像素门此后只需负责 shader 输出。
- **它比 §1.4 一般形态强在哪**：§1.4 的前提是"内部状态可暴露"（复刻侧自建句柄、源站侧靠拟合/重放绕过）。场景图数值门**两侧都不需要插桩**——转写出来的探针在源站的原混淆 bundle 上照样跑。因此它是**唯一能直接从线上源站取到同一份数值基准的数值门**，可以在移植开工前就建立，并终身作为 DOM/CSS 改动的回归门。
- **搭建纪律**：
  - **逐字转写，连 bug 一起转**：`QL` 里 carousel 元素在第一遍遍历中落不进 text/image/shape 任何分支、空转一次——照抄；"改进"它就等于在比另一个程序。minified 标识符与源行号保留在注释里，两边可肉眼 diff。
  - **读取器的副作用同样要转写**：`mG.readLayout()` L46372–L46385 在解析前把场景根改成 `transform:""; position:fixed; height:100vh`，读完还原并 `scrollTo`。漏掉这一步实测得到统一 158px 的 Z 偏移——读到的是活布局，不是引擎看到的布局。
  - **解析作用域按源站来**（本例是 `[data-dom-layout]` 而非 `document`）；退化到 body 时要在产物里显式打标（`layoutRoot: "body(FALLBACK)"`），否则会静默比错东西。
  - **先冻结，再取基准**：未冻结时同一镜像两次采样就漂 7 个字段。单侧自比 0 差异是双侧对拍的前置条件（熵源清单见 `references/determinism.md` §1、§3）。
  - **归一化只允许做偏差表里登记过的那一项**（本例 `/ext/` URL 改写），其余一律算真差异——否则这个门会退化成可调参的像素门。

### 1.5 CLEAN 探针门（底线门）

- **定义**：无头加载 + 滚动/遍历状态，采集 console 错误、页面异常、失败/非 2xx 请求，零错误（白名单放行已知残留）即 CLEAN，退出码进 CI。
- **实例**：lando `verify.mjs` 全 7 路由 × 桌面(1728×1080)/移动(390×844) = 14 个探针跑，滚动到 50%、等 12s、已知残留（iubenda badge）白名单放行，M7 关闭时 14/14 ALL PASS【lando】；samsy 零控制台错误门，无头回归必带 anti-throttling 旗标【samsy】；oryzo 无头双分支（桌面 + iPhone 级 390×844 触摸仿真）+ 三段截图【oryzo】。
- **适用条件**：**所有站点**，成本最低，从 M0.5 镜像跑通开始终身使用（镜像与复刻两侧都跑）。
- **skill 脚本**：`scripts/probe.mjs`（必须含 CDP Log 域监听，见 §7 坑 1）。
- **纪律**：已知残留也登记在案（无头 SplitText 字体时序警告、uTime 相位细微差），不假装 100%【lando】。

### 1.6 零外联门的完整断言面（⚠ 常被漏判）

"零外联"是离线复刻的核心声明，但**资源级探针只数 request，会漏掉三类真实外联**。断言面必须覆盖：

| 类别 | 为什么资源探针抓不到 | 怎么断言 |
|---|---|---|
| **连接预热**：`<link rel="preconnect">`、`<link rel="dns-prefetch">` | 不产生资源请求，但联网时**真的发起 DNS 查询与 TCP/TLS 握手** | 对构建产物静态 grep 这两类 `<link>`，外部 host 一律移除或登记 |
| **内联自包含遥测** | 遥测实现整段内联在 HTML 里，不依赖被 stub 的外部脚本；`sendBeacon`/`fetch` 直打绝对外部域 | grep 构建产物里的外部绝对 URL 字符串，逐条判定是否可触发 |
| **兜底路径外联** | 只在某脚本加载失败时才触发，正常跑不出现 | 读代码判定触发条件，不能只靠跑一遍 |

实证【racingshop】：一次判定"零外联"通过的 Shopify 复刻，21 个页面全部残留 `preconnect → shop.app` 与 `dns-prefetch → monorail-edge.shopifysvc.com`；且每页内联着完整 Monorail 实现，`Monorail.produce('monorail-edge.shopifysvc.com', …)` 经 `sendBeacon` 直打外部域——它位于 trekkie 脚本加载失败的兜底路径里，本体在盘时不触发，被广告拦截器按文件名拦截时会触发。三条都不产生常规资源请求，探针全绿。**这正是 §4.1「门只断言想到的字段」的实例。**

反过来，**出站 `<a href>` 锚点不算外联**（如页脚的 shopify.com/legal 链接）：它是源站内容，按宪法第 3 条应逐字保留，点击才跳转，加载时无网络活动。

**关账要求**：零外联门的产出物里要有"外部绝对 URL 清单 + 逐条判定（不可触发 / 已移除 / 已登记为潜伏外联）"，而不只是一句"probe 全绿"。

## 2. 门型选择决策树

```
站点有 SSR/静态 HTML 产物？
├─ 是 → 先建 SSR/DOM 字节门（§1.1），每 commit 回归、终身全绿
└─ 否 → 至少建路由/契约门（重定向状态码、head 字段）

该画面/场景是否"静止且熵源可枚举"？（DOM 渲染为主，无不可冻随机源）
├─ 是 → 冻结协议 + 整页 byte-equal 门（§1.2）；冻不住的局部用
│        "同等隐藏"协议剥离并另建专门门覆盖【kimi】
└─ 否（WebGL/视频/随机相位）→ 先别急着降级，再问一层：
    场景构建是否为 DOM/CSS 的纯函数？
    （同一函数里同时出现 querySelectorAll("[data-*]")
      + getBoundingClientRect() + getComputedStyle()）
    ├─ 是 → 先建场景图数值门（§1.4.1）：逐字转写该函数为探针，
    │        两侧逐字段数值 diff，0 差异关账；像素门退居其后，
    │        只负责 shader 输出那一层【shopifydesign】
    └─ 否 → 降级为量化像素对拍门（§1.3）
             + 显式噪声归类（§6）+ 最差格/最差点目检归因

动画/交互由数据或纯函数驱动？
├─ 是 → 补数值探针门（§1.4）：dump 基准 → 拟合/重放/全等断言
└─ 否 → 至少对关键内部状态加探针断言（mode 字符串 / 状态遍历）

全程兜底：CLEAN 探针门（§1.5）对每条路由 × 每个视口跑，每次改动必过。
```

### 2.1 门的运行纪律

- 选型后把**"改动区域 → 最小门集合"写成映射表**进 REBUILD_PLAN（rogier：改 Home WebGL → build + 渲染器审计 + Home 桌面/移动输出 + thumb spotlight；改路由 → focused 路由探针 + 受影响页面门）【rogier】。
- 维护**分级命令清单**（rogier 的 "Validation Profiles"）：从 "docs-only（`git diff --check`）" 到"浏览器探针全家桶"，可直接复制执行【rogier】。
- 每个工作单元以门收尾：HANDOFF/日志记录以 "Gates: ... green" 收尾，探针产物路径留档【rogier】。
- 门脚本环境变量参数化（OUT_DIR/CDP_PORT/VIEWPORT/PROBE_WAIT/REBUILD_URL），多端口并行跑【rogier】。
- 全部门用零依赖 Node 脚本（Node 22+ 内置 WebSocket 直连 CDP），"避免工具链自身版本漂移污染比对"【kimi】。

## 3. 分层验证体系（成本递增，全部要做）

1. **每里程碑冷启动实测**：全新加载（"不手动切效果——手动切换会掩盖初始化状态 bug"【kimi】；oryzo 的 NaN 传染 bug 只在冷启动暴露【oryzo】）、零控制台错误、截图取证，验收标准写进里程碑日志【samsy】。
2. **无头自动门每 commit 跑**：§1 的门按选型组合，判定必须机器可断言【6/6】。
3. **与源站对拍**：按 §2 选像素/数值门；产物入库留证（`docs/compare/`、`docs/pixelcompare/`、`docs/side-by-side/`）。
4. **冷头评审（收官审计）**："功能测试测不出『整块遗漏』，只有清单式核对能"【samsy】。四种形态，按站型选用（可叠加）：
   - 对 bundle 应用区**顶层类逐一核对落点**：samsy 60 个顶层类，揪出唯一真缺口（编辑器 raycast 盒工厂，回归和像素比对都测不出——场景 children 应为 35 实为 0）【samsy】。
   - **模块清单对账**：kimi M7.5 抓出只在过渡中出现的 ASCII 瀑布组件从未移植（见 §4.5）【kimi】。
   - **零 TODO/stub 审计** + 偏差表/怪癖表补全【noomo】。
   - **反向扫描**：枚举复刻独有的全部 118 条 (media, selector) CSS 规则逐条判定"必要机制 / 等价别名 / 多余发明"，揪出 3 条真发明【rogier】。
   - 评审姿态："不信文档，逐条回到镜像与 bundle 复核"（kimi 专设 R1 审查里程碑，抓出 4 条实锤）【kimi】。
5. **部署即验证**：真实网络延迟暴露本地永不触发的竞态——samsy 用 CDP Fetch 单文件延迟**二分定位**到两张纹理，根因判定为"部署拓扑差异（单源 vs CDN 分域）"而非代码，修复分"保真修正"与"登记偏差"两笔【samsy】；真机对拍兜 headless 盲区（§6）。

## 4. 门的六种失效模式与防呆【kimi】

kimi 对"门"本身做了系统反思，六条全部有实锤事故。设计每个门时逐条自检：

### 4.1 门只断言想到的字段

- **事故**：`<main>` 只比 3 个固定字段，抓不到 shell 组件发明的源站没有的 DOM 属性；只测无斜杠形态，抓不到尾斜杠重定向链与源站相反（R1 审查 F2/F3）。
- **防呆**：**并集全量比对**替代字段名单比对——把双侧出现过的字段取并集逐一比，而不是只比自己列出来的。

### 4.2 门对"驱动步骤没生效"是盲的

- **事故**（M5.3）：eclipse 位姿的驱动步骤悄悄失败，截的还是 hero 画面，门照样全绿。
- **防呆**：**同会话位姿哈希必须互异**——不同位姿截图哈希相同，说明驱动没生效，直接判红。任何"先驱动到状态 X 再断言"的门都要有"确实到达了 X"的独立证据。

### 4.3 byte-equal 不证明"测的是想测的画面"

- **事故**（M5.3）：双侧一致地缺弧形文字，byte-equal 照样全绿——它只证明"复刻 == 镜像的这个截图"，不证明截图里有该有的东西。
- **防呆**：字节门之外保留人工目视产物（side-by-side 合成图逐张过目）；关键内容加存在性断言（DOM/数值探针）；覆盖面靠 §4.5 的清单对账，不靠门的颜色。

### 4.4 门把录制巧合编码成规格

- **事故**（M3.5）："pixel-entry 首帧 anchor == 585px" 依赖源站的加载时序；复刻加载更快就假红。
- **防呆**：**断言机制本身而非环境量**——断言"anchor 由哪条公式推出"，不断言某次录制里它恰好等于多少。写门时对每条断言问一句：这是源站的规格，还是那天录制环境的巧合？

### 4.5 静止态门对过渡组件结构性失明

- **事故**（M7.5）：只在场景过渡中出现的 ASCII 字母瀑布组件（模块 7868）从未移植，26 个静止位姿全绿。
- **防呆**：**枚举源站模块清单逐一对账落点**，作为独立收官步骤——"覆盖面的空洞要靠清单对账，而不是靠门的颜色"。对过渡态本身，用 framebudget 冻结协议把中间帧（第 24 帧、u=0.5）也纳入字节比对（见 `references/determinism.md` §2）。

### 4.6 诊断工具与验收门混用一份代码

- **事故**（M7.3）：门只需"确定性 + 双侧同函数"，诊断需要"绝对正确"；一份 PNG 解码代码同时服务两者，Chrome 截图是 colorType 2（三通道）而代码硬编码 `*4` 索引，画出一整轮几何假象——坏账藏在门的全绿里。
- **防呆**：诊断代码与门代码**分离正确性标准**；基础库（如 PNG 编解码）对权威实现逐格验证（`scripts/lib/png.mjs` 对 Pillow 逐格验证过）。

## 5. 根因修复而非调参糊平

像素差异出现后只有三条合法出路：**修复（追到取证级根因）/ 登记偏差 / 定性为采集条件敏感**。禁止调参数把差异糊平。

- noomo F1（全屏竖纹）追到流体求解器 GLSL 版本默认值与源站不符（源站默认 GLSL1、复刻误设 GLSL3 → 全部 shader 编译失败 → 空场 → NaN），一行修复级联解决三个表观 bug【noomo】。
- noomo F2（大字偏小）追到 19 个 `text-sans/serif` Tailwind `@utility` 整族缺失，从源站 CSS 逐条重建【noomo】。
- noomo F3 用 dev.json 基准逐项核对 8 个弹簧值**证明参数链无罪后**才定性为弱视觉差入偏差表【noomo】。
- 逐字提取的 shader 先离线 `node diff` 证同，差异排查就能聚焦到编译参数/数据链【noomo】。
- 修复分两笔账："保真修正"与"登记偏差"分开处理【samsy】。
- 残差用数字关账：修复前后逐 band delta 留档【rogier】。

## 6. 真差异与方法学噪声的归类纪律

量化门（§1.3）必须显式归类噪声源，否则真 bug 淹没在噪声里：

- **已知噪声源清单**（对拍报告里逐条列出）：虚拟滚动缓动相位造成的构图偏移、动画相位不同的色温差、headless 下授权字体未加载的换行差【oryzo】；视频帧相位、glitch 文字随机相位、粒子随机相位【samsy】；文字块随窗口高度命中相邻组（复检需锁窗口）【noomo】。
- **最差格/最差点逐一目检归因**：每个超差点要么归入已知噪声、要么立案排查【samsy】。
- **正因为归类了噪声，才能在噪声里捞出真 bug**：oryzo 最后一轮真机对比在"噪声"里抓出 8 处纹理缺 sRGB→linear 解码导致整场景偏亮发灰【oryzo】。
- **自动门之外必须保留人工目视/真机兜底**：headless 盲区（授权字体、sRGB 色彩管理）只有真机对比能暴露【oryzo】；编码保真问题（vite 把 srcset 的 %20 二次编码成 %2520 导致 7 图 404）是用户目视抓到的，事后补"全站 URL×磁盘全量审计"【lando】；滚动终点未覆盖（HomeFooter 整段缺失）也是人眼抓到的【noomo】。
- lando 用**真机三方对拍**（线上/镜像/复刻同机位截图，命名区分 mirror-*/rebuild-*/dist-*，入库 `docs/compare/`）把目视也产物化【lando】。

## 7. 常见坑

1. **探针自身有盲区**：Chrome 因 SRI 校验静默拦截 CSS，安全报错走 CDP 的 `Log.entryAdded` 域，而探针只监听 Runtime/Network——"CLEAN"全绿存在盲区。探针必须监听 Log 域；"绿灯工具的覆盖面本身是需要迭代的对象"【lando】。
2. **WebGL 读回假象**：`readRenderTargetPixels` 读回前必查 `gl.getError`，全零缓冲是读回假象不是黑屏【noomo】；无 `preserveDrawingBuffer` 的 WebGL canvas 不能 `drawImage` 读【kimi】。
3. **CDP 工程坑**：调用必须带超时、单次多兆字节 `Runtime.evaluate` 会卡死管道要分块、headless Chrome 无视 SIGTERM 要 SIGKILL【kimi】。
4. **判定时序 bug 前先校准探针**：后台节流、HMR `?t=` 幽灵模块、探针时钟错位、部署拓扑都会伪装成代码 bug（samsy 曾误判源码 bug 并错误"修复"，取证后撤销）【samsy】；探针超时明确区分为 "probe timing, not a product mismatch"（真 GPU tier 3 机器需要 `PROBE_WAIT=25000/45000`）【rogier】。详见 `references/environment-traps.md`。
5. **对拍前先做资产预检**：先确认镜像服务能出图再截图，否则截图会误导归因【rogier】。
6. **检查点必须覆盖滚动两端**（含 t=终点），否则终点处的整段动画缺失漏网【noomo】。
7. **断点笔记里的"下一步很简单"也是待验证断言**【kimi】——门没跑绿之前不许当作事实引用。
8. **驱动状态的选择器要抗干扰**：菜单文字被 glitch 轮换时文本匹配不可用，按 DOM 索引点击驱动【samsy】。

## 8. 产出物

- 门脚本 + 每次运行的结构化产物（summary.json / metric.json / 截图对）入库留证
- 场景图数值基准（源站 / 镜像 / 复刻三份 JSON）+ 逐字段 diff 结果，每次改 DOM/CSS 后回归【shopifydesign】
- "改动区域 → 最小门集合"映射表 + 分级命令清单进 REBUILD_PLAN
- 每条里程碑日志记录门的运行结果（"SSR gates green" / "14/14 PASS" / "Gates: ... green"）
- 冷头评审报告：清单对账结果 + 反向扫描判罪清单 + 偏差表/怪癖表终版
- 已知残留白名单（登记在案，不假装 100%）
