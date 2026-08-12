# 严格溯源移植（阶段 2：Port）

> **何时加载本文件**：`_pretty/` 坐标系、`docs/engine-notes.md`、技术栈钉死与阶段计划全部就绪（阶段 1 通过判据勾完）之后，开始写第一行复刻代码时加载。本文件的五条纪律在整个移植期持续生效，直到验证收口。

## 1. 宪法级纪律（五条）

多个项目在 REBUILD_PLAN §0 里自称"宪法级"【noomo】【lando】。每条 = 规则 + 操作化 + 实证。

### 1.1 源站代码是唯一裁决，不凭观感修

- **规则**：每个改动先在 bundle/CSS/镜像 HTML 里找到归属行号，再落地【6/6】。rogier 明写进执行规则："Do not tune visuals, motion, audio, or interaction by eye"【rogier】。
- **操作化**：动手前完成"归属"这一步——写不出 `pretty LNNNN` 出处的改动不许提交。rogier 的 batch 流程固化为：本地复现 → 先归属再动手 → 只修 source-owned 行为 → focused 探针 + 回归门 → 文档与代码同 commit【rogier】。
- **实证**：oryzo M2.3 曾用目测近似实现先跑通，随后整批替换——commit 明写"全部逻辑溯源 bundle，**替换了此前的近似实现**"。近似实现只许当脚手架，且必须显式替换归零【oryzo】。

### 1.2 源站有的都要有，没有的不做；不自创补偿性 CSS/JS

- **规则**："宁可先不像，也不要发明规则"【rogier】【noomo】。视觉不对时去找没对齐的机制，不许用自创样式/逻辑把观感糊平。
- **实证**：rogier 十余个视觉 bug **全部**源于"JS 机制没对齐时用自创 CSS 补观感"——等 JS 对齐后，这些补丁反转成 bug【rogier】。
- **操作化（反向扫描）**：定期枚举"复刻独有"的规则逐条判罪。rogier 枚举 `global.css` 里源 bundle 没有的全部 118 条 (media, selector) 规则，逐条判定"必要机制 / 等价别名 / 多余发明"，揪出 3 条真发明并删除【rogier】。

### 1.3 bug / 死代码 / 怪写法照抄不修

- **规则**："压缩代码里的每个怪写法都可能是行为本身"【rogier】。修好它才是偏离。照抄的同时登记进怪癖表（§Q）并注明行号。
- **最强实证【lando Q13】**：源站 `World.destroy` 里 `scene.remove(Q.name)` 传字符串——在 three 中是 no-op。复刻时曾"修好"改成真删除，结果**真删除破坏了场景遍历，导致转场崩溃**，最终按怪癖回抄 no-op。"bug 照抄不修"不是洁癖，是工程安全绳【lando】。
- **其余实证**：
  - rogier：`pz % 250 + 10` 带符号取模被"好心修正"为正取模后，About 页浮动方块全部消失【rogier】；
  - oryzo：`mipFilter` 死参数、光场 RT 错误的 `format="R8"` 照抄——"修正它们反而会偏离源站的实际渲染结果"【oryzo】；
  - samsy：`isSprinting` 恒为 true、事件名拼错导致监听器泄漏、三个调用即崩的死方法（引用全 bundle 无定义的标识符）逐字入库——"修好它们才是偏离"【samsy】；
  - kimi：`lineWidth 0.30000000000000004` 浮点残迹、被读不被写的 CSS 变量、硬编码英文 aria-label 等 26 条怪癖照抄并注明行号【kimi】；
  - noomo Q13：采样数切换事件把 define 大小写写错、从未生效——连这个"无效重编译"都照抄【noomo】；
  - 死代码同样移植：rogier 保留零引用的 `.ts-split` 规则【rogier】；kimi 移植九种轨道形状里八种死代码【kimi】。

### 1.4 有意偏差必须登记

- **规则**（kimi 登记原则原文）："凡是明知与源站不同的实现，必须留一条，写清『源站怎么做的 / 我们怎么做 / 为什么 / 什么条件下重新考虑』。**没登记的差异一律视为 bug**"【kimi】。samsy 用 "REGISTERED DEVIATION" 注释 + 计划文档同步登记【samsy】；rogier 为 "Open Decisions" 表【rogier】；noomo 终版 14 项、lando 12 条、kimi 6 条【noomo】【lando】【kimi】。
- **范本**：kimi 的"4.8MB 字体拒绝子集化"——可压四十余倍但拒绝，理由按杀伤力排五条（首屏渲染门控时序、`measureText` 折行、点阵舍入敏感、538 字是移动靶、私有仓库收益为零），并附"重新考虑的条件"。把"看起来该做的优化"论证为对测量基准的破坏【kimi】。

### 1.5 代码与文档同一次提交

- **规则**：每个里程碑成对提交——`Port xxx`（代码）+ `Update rebuild plan: xxx`（文档）【oryzo】【samsy】【kimi】【noomo】【lando】；rogier 为"文档与代码同 commit"【rogier】。
- 日志四要素见 §5.3。

## 2. 移植文件头注释规范

### 2.1 行号区间映射（每个移植文件必写）

文件头部注明源模块 / minified 名 → 移植名 + `pretty` 行号区间。各代实例（照此格式写）：

- samsy：`Port of source player controller Eu0 ... pretty L63486-L63732`【samsy】
- noomo：`// BlenderTimeline (dr L56346-56442)`、`// Jr CasePage — L51058-51110`【noomo】
- lando：`V9 TrackPoint 32502-32515, z9 Tracks 32516-32848, UN/GN shaders 32849-32944`【lando】
- kimi（函数级映射，多函数文件逐条列）：`scenePosition = source R (L2609-L2617)`、`deriveDeckState = source eL/eF/…(L2914-L2966)`；组件头注 `1:1 port of the MoonEclipse component shell (source module 73655, function b)`【kimi】

混淆别名保留为线索：lando 的移植代码写 `import { gsap as m, ScrollTrigger as TA }`——沿用 bundle 混淆名，让移植代码、逆向笔记、pretty 源码三方可互相对照【lando】。

### 2.2 GLSL / 魔数 / 数据逐字提取

- **GLSL 逐字拷贝、集中存放、头注声明**：oryzo 的 `glsl/index.ts`（845 行、118 段 shader）头部声明 "GLSL extracted verbatim from … **Do not edit by hand**"【oryzo】；lando 流体六 pass 注明 "All GLSL verbatim" 并逐 pass 列源行号【lando】；noomo 连源站变量名 `yeahRaytracingBroWhySoComplex` 都照抄【noomo】。
- **逐字的直接收益**：noomo 离线 `node diff` 证明 shader 与源站逐字一致后，像素差异排查即可**聚焦到编译参数/数据链**（M7a F1 全屏竖纹最终定案为 GLSL 版本默认值差异，一行修复级联解决三个表观 bug）【noomo】。
- **魔数照抄**：`wheelEaseCoeff=12`【oryzo】、bloom strength 0.34 / radius 0.27×DPR（带行号）【samsy】、"噪声种子、灰阶表、4×4 与 8×8 抖动矩阵、量化级数全是硬编码魔数，目测调不出来，只能逐字抄"【kimi】、LCG 种子 1111111114、弹簧参数 (50,15)【noomo】、GSAP 贝塞尔控制点公式与 ScrollTrigger 配置逐字抄录【lando】。

### 2.3 把源码语义编码成可断言的 mode 字符串（可选进阶）

rogier 在实现里嵌入 68 处 mode 字符串，把"当前遵循哪条源码语义"直接编码进运行时状态，如：

```
"source-yD-onProjectActive-spotlight-reveal-woosh-uReveal-before-look-directional"
"source-Lo-update-renderTargetA-to-renderTargetComposite"
```

探针脚本持有同一组 `source-<符号>-<行为>` 常量逐一比对——"实现遵循了哪条源码语义"从口头承诺变成自动回归项【rogier】。移植复杂状态机/渲染链时值得采用：写实现的同时就把语义锚点留给阶段 3 的验证门。

## 3. 数据资产：脚本从 bundle 抽取入库，禁止手抄

- **规则**：数据类资产（i18n、文案、布局表、动画配置、作品清单）写脚本从 bundle 抽成 JSON 入库；**生成物不手改**，要改就改脚本重跑。
- **范本【kimi】**：`extract-i18n.mjs` 用**括号配平**定位对象字面量 + **隔离 vm 求值**抽成 JSON，两语言键集交叉校验（80=80）。副产品：源站英文文案自己的拼写错误（"Leaining rate" / "Senquential"）经管道原样保留——"抽取式移植的免费收益：连错都不用自己抄"。
- **同类实践【samsy】**：`src/data/` 下 works.json（25 条）、cityLayout.json（bundle L65917-66615 逐字反解，35 处摆放）、animations.json（1.64MB）、mixamoRig.json、preloaderFrames.json。
- 为什么不手抄：手抄错误无法审计也无法重放；脚本抽取可重跑、可交叉校验，且连源站的错误都保真。

## 4. 三张登记表制度

REBUILD_PLAN 固定维护三张表（lando 定型，各项目同构【lando】【kimi】【noomo】【samsy】）：

| 表 | 内容 | 判据 |
|---|---|---|
| **§0 纪律表** | 本文件 §1 的五条宪法（lando 的六条版本为蓝本，多一条"每里程碑浏览器实测"） | 开工时写死，全程不改 |
| **§6 偏差表** | 有意偏差，逐条四要素：源站怎么做 / 我们怎么做 / 为什么 / 什么条件下重新考虑 | **没登记的差异一律视为 bug** |
| **§Q 怪癖表** | 源站 bug/死代码/怪写法"照抄不修"的登记，每条带 pretty 行号证据 | 照抄也要留痕，防后人"顺手修好" |

裁决规则：复刻与源站的任何差异，只有三个合法去处——§Q（源站怪癖，我们照抄了）、§6（有意偏差，已登记四要素）、bug（立即修）。**不存在第四类。**

## 5. 里程碑推进与提交纪律

### 5.1 依赖序推进 + 先竖切

- **依赖序**：元系统 → 场景/组件 → 页面专属逻辑。noomo 遵循 engine-notes 结论"先移植三大自研元系统（provider 注入器 / ShaderRegistry / 时间线绑定原语）再写任何材质"【noomo】；lando 按 M3 站点 chrome 层 → M4 Rive 层 → M5 Three GL 层 → M6 页面专属逻辑分层【lando】；samsy M2→M9 同理【samsy】。
- **先竖切一条端到端链路**：oryzo 先把 hero 场景从加载到渲染整条链打通，再横向铺其余场景集群【oryzo】——竖切最早暴露架构级错误。

### 5.2 每里程碑验收后才进下一个

- 浏览器**全新加载**实测（禁止手动切效果——"手动切换会掩盖初始化状态 bug"【kimi】；oryzo 的 NaN 传染 bug 只在冷启动暴露【oryzo】）、零控制台错误、截图取证。
- 已建立的底层验收门保持全绿：noomo 的 git log 里几乎每条 commit message 以 "SSR gates green" 收尾【noomo】。

### 5.3 成对提交 + 日志四要素

每个里程碑一对提交（`Port xxx` + `Update rebuild plan: xxx`），日志固定四要素【kimi】【samsy】【noomo】：

1. **产出**（做了什么，带行号）；
2. **验收**（跑了什么门、结果数值）；
3. **教训**（本轮踩坑与根因）；
4. **下一步断点待办**（带精确行号，如 samsy M7a 待办 "字体管理器 **pretty L60740-L60844（未读）**"）——这是跨会话/跨人交接的入口【samsy】。

### 5.4 里程碑关闭后的重开判据（Phase gate）

- Phase 关闭后不许"因为老了"或"看着可疑"重开——**只有把新问题的 owner 归属到具体源码路径才允许重开**。rogier 的 Reopen Queue 五步：按 owner 分类 → 先查 bundle 证据 → 扣除镜像重写后对比线上 → 窄补丁 → focused 验证 + 共享回归门【rogier】。
- 按改动区域定义**最小 gate 集合**映射表（改 Home WebGL → build + 渲染器审计 + 双视口输出探针；改路由 → focused route 探针 + 受影响页面 gate……），每个 batch 只跑受影响的最小集合，避免全量回归拖慢节奏【rogier】。

## 6. 临时代码生命周期标记

- **规则**：一切 shim/stub 必须显式标注生命周期，否则视为未登记偏差（= bug）。
- oryzo：`phase1-shims.css` 每条 shim 注明"**将在 phase 2 被引擎逻辑取代**"，后续果然全部删除【oryzo】；
- lando：`stubs-notes.md` 是"临时骨架清单（逐波替换为溯源实现）"，每个 stub 文件标注对应源函数与行号区间【lando】；
- 收口时冷头评审要做"零 TODO/stub 审计"（noomo M7c）【noomo】——生命周期标记就是那次审计的对账清单。

### 6.1 no-op stub 必须同时是合法的 classic script 与 module（硬规则）

替换外部脚本的空 stub 文件，**必须在两种加载模式下都能解析**。同一个 stub 文件常被多处引用，而这些引用未必都带 `type="module"`：

- ❌ `export {}` —— 被 **classic**（非 module）`<script src>` 加载时抛 `SyntaxError`，脚本整体不执行。后果会级联：源站后续代码假定该模块已注册全局对象，于是变成 `.init` on undefined 的崩溃，错误现场离真因很远【racingshop】。
- ❌ `export default null`、顶层 `import`、顶层 `await` —— 同理。
- ✅ **纯注释文件**（如 `// no-op stub: replaces <原脚本名>, see REBUILD_PLAN §6 D6`）——两种模式下都合法、都无副作用。**首选**。
- ✅ 受保护的 IIFE（`(function(){ /* no-op */ })();`）——需要 stub 真的建立某个全局占位对象时用。

判定方法：不要凭引用点当前的写法猜。grep 构建产物里**全部**指向该 stub 的 `<script>` 标签，确认 `type` 属性分布；只要存在一处不带 `type="module"`，就必须走双模式合法写法。

## 7. 常见坑（移植坑）

1. **CSS 级联顺序即语义**【rogier】：源站把布局工具类（`.grid`、`.col-*`）放在样式表**末尾**，复刻放开头导致同特异性冲突全部反向解析、项目页媒体栅格坍塌。对策：逐字复刻连"规则出现的顺序"一起复刻。
2. **"先显示再动画"必闪帧**【rogier】：源站以 CSS opacity 0 附加新视图再 `fromTo(0→1, 0.5s)`，复刻直接置 1 造成闪帧——"时序即视觉"。对策：入场/揭示动画的初始态与触发时序逐事件对齐，用阶段截图（如 700ms/1200ms 两帧）验证。
3. **传递依赖反转行为**【noomo】：unhead 2.0.17 → 2.1.17 会反转 bodyClose 脚本顺序，破坏尾部字节序。对策：字节级验收失败时先怀疑传递依赖版本，用 `overrides` 钉死并登记偏差。
4. **Vite 分包使 `instanceof` 跨 chunk 失败**【oryzo】：同一类在不同 chunk 各有一份构造器。对策：改鸭子类型判定。
5. **avif 探测竞态静默 404**【oryzo】：格式探测竞态导致 gobo 纹理静默丢失。对策：资源加载失败不许静默，纳入零 404 门。
6. **构建器对 srcset 二次编码**【lando】：vite 把 `%20` 编成 `%2520`，7 张含空格文件名的图 404，自动门没抓到、人眼抓到。对策：postbuild 还原 + 全站 URL×磁盘全量审计 + 登记偏差；"srcset/style 内 URL 的编码保真需要纳入构建期对拍"。
7. **"好心修正"怪写法即引入 bug**：rogier 带符号取模、lando Q13 修 no-op 反而崩溃（见 §1.3）。对策：照抄 + 登记 §Q。
8. **自创补偿性 CSS 在 JS 对齐后反转成 bug**【rogier】（见 §1.2）。对策：反向扫描定期判罪复刻独有规则。
9. **框架行为无法配置时**：用等价机制对齐并登记偏差——noomo 用显式模板属性复现 Vue scoped 的 `data-v-*` hash【noomo】；samsy 手动指定源站原版 `__scopeId` 使源站编译产出的 scoped CSS 零改写生效【samsy】。

## 8. 阶段通过判据

每个移植里程碑关闭前自查：

- [ ] 本轮全部改动都能写出 `pretty LNNNN` 归属（纪律 1.1）
- [ ] 没有新增任何"源站没有"的规则/逻辑；如有补偿性代码，已删除或已走偏差登记（纪律 1.2）
- [ ] 新遇到的怪写法已照抄并登记 §Q 带行号（纪律 1.3）
- [ ] 新产生的差异已四要素登记 §6，或已修复（纪律 1.4）
- [ ] 移植文件头有行号区间映射注释；GLSL/魔数/数据为逐字提取，数据类经脚本抽取且生成物未手改
- [ ] 新增 shim/stub 已标注"将被 phase N 取代"
- [ ] 浏览器全新加载实测通过、零控制台错误、既有验收门全绿
- [ ] 成对提交完成，日志含四要素，断点待办带精确行号

全部勾选后进入下一里程碑；全部里程碑完成后进入阶段 3（验证收口：三重验证 + 冷头评审）。
