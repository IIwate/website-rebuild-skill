# DOM 层策略选型指南（A/B/C + 正交约束 D）

> **何时加载本文件**：完成镜像（M0）与逆向（M1）后、搭工程骨架（M2）前——需要决定"页面 HTML/CSS 外壳如何获得"时加载。本文件回答两个问题：DOM 层是零重写生成、脚本切分、还是框架内重建（策略 A/B/C）；以及 DOM 是否同时被 3D 引擎当坐标源读取（策略 D 的正交约束，它会锁死上一问的答案）。

## 1. 选型决策树

选型判据有两条，**按序问**：先问"DOM 被谁消费"（决定字节门的性质与选型自由度），再问"DOM 由谁生成"（决定 A/B/C）。两条都在镜像 HTML / bundle 里取证。

```
先问：原站 DOM 的消费方是谁？【shopifydesign】
├── 只有浏览器（DOM = 文档）
│     → 无额外约束，继续问下一条
└── 还有 3D 引擎：引擎用 getBoundingClientRect / getComputedStyle 把 CSS 排版结果读成世界坐标
      → 命中策略 D：DOM 即场景图（§5）。它是**正交约束**而非第四种外壳来源——
        外壳选型被锁死为策略 A，且字节门升格为几何门
        命中后追问一句：hydration 之后布局还会不会被客户端改写？（§5.2 ②）
        会 → SSR DOM 只是场景图初值，重排代码才是场景顺序的规格

再问：原站 DOM 由谁生成？
├── 平台导出物（Webflow 等：镜像 HTML 即最终产物，含 webflow.js、平台 data-* 体系）
│     → 策略 A：零重写 shells（镜像 HTML 经登记变换直接生成页面）【lando】
├── 静态单页（单个 index.html 巨页，构建器产物但结构可直接切分）
│     → 策略 B：脚本切组件（生成脚本保守切分，验收 diff 为空）【oryzo】
└── 框架编译产物（Vue SPA / Next RSC / Nuxt SSR 等，DOM 由运行时/服务端渲染）
      → 策略 C：框架内重建 + 字节对齐【samsy】【kimi】【noomo】【rogier】
```

**取证判据**（判断生成方时逐项核对）：
- Webflow 特征：`webflow.js` + jQuery、约 120 种 `data-*` 属性命名体系【lando】。
- Next 特征：`window.next={version:...}`、RSC flight payload（带 `RSC: 1` 头可取回另一份 body）【kimi】。
- Nuxt 特征：`__NUXT_DATA__` payload、响应头 `x-powered-by: Nuxt`【noomo】。
- Vue SPA 特征：scoped CSS 的 `data-v-xxxxxxxx` 属性【samsy】。
- Astro/静态特征：`_astro/` 资产目录、单页巨型 HTML【oryzo】【rogier】。
- **策略 D 特征**：同一个函数里同时出现 `querySelectorAll("[data-*]")` + `getBoundingClientRect()` + `getComputedStyle()` 三件套【shopifydesign】。命中后**必须再做运行时取证**：hydration 前后同一批节点的 `getBoundingClientRect()` 是否变化（§5.2 ②）——SSR DOM 常常只是场景图的初值。
- 分支可组合：lando 是"平台外壳（策略 A）+ 自定义 bundle 应用层手写重写"的混合——外壳与应用层可分别选策略【lando】。

**共同验收（三策略通用）**：产出 HTML 与镜像做"空白归一化 diff 为空"或逐字节 diff 为空【oryzo】【noomo】【kimi】。字节层的门要**最先建立、终身保持全绿**——"字节层先行使后续所有视觉 debug 都能排除 DOM/payload 差异"【noomo】。

**策略速查表**：

| 策略 | 适用 | HTML 来源 | 核心验收 | 出处 |
|---|---|---|---|---|
| A 零重写 shells | 平台导出物 | 镜像 HTML + 登记变换直接生成 | 仅登记变换处不同，其余逐字一致 | 【lando】 |
| B 脚本切组件 | 静态单页 | 切分脚本保守 pretty-print | 空白归一化后 diff 为空 | 【oryzo】 |
| C 框架内重建 | 框架编译产物 | 同栈同版本框架内重建 | SSR/payload 逐字节 diff 为空 + CSS 双向 diff | 【samsy】【kimi】【noomo】【rogier】 |
| **D DOM 即场景图**（正交约束） | DOM/CSS 被 3D 引擎当**坐标源**读取 | 同 A（约束一旦命中，A 是唯一正确解；但 A 只保证初值，见 §5.2 ②） | 场景图**逐字段数值全等**（几何门，基准取**运行时静止态**），字节门是它的前提 | 【shopifydesign】 |

## 2. 策略 A：零重写 shells（平台导出物）【lando】

核心判断（写在生成脚本头注释里）："**平台生成的 DOM/CSS 就是字节级规格书**"——页面 HTML 一律不重写，从镜像直接生成。

操作步骤：
1. 写 `gen-shells.mjs` 类生成脚本，对镜像 HTML **只做登记在案的变换**。lando 全部只有 4 项：
   - ① 剥离遥测脚本（登记为偏差：私有部署不应上报）；
   - ② 外部 host URL 重写为 `/ext/<host>/` 本地路径（登记为偏差）；
   - ③ 把源站 bundle 的 `<script>` 标签替换为自己的模块入口（`<script type="module" src="/src/app/main.ts">`）——这一处替换就是"重建本体"；
   - ④ 仅当 parser 无法解析时做最小修复（lando 修一处畸形 SVG 属性边界让 parse5 能解析，浏览器 DOM 等价，登记为偏差）。
2. **其余一切逐字保留**——包括注释掉的历史脚本块（登记为怪癖 Q1）【lando】。
3. **脚本内置防御：找不到 bundle 标签、或没有任何变换发生，直接 throw**——镜像布局变了会立刻暴露，而不是静默产出错误 shells【lando】。
4. 配套路由/资产层（lando 的 vite 两个自定义插件）：
   - `extAssets()`：dev 下把 `/ext/<host>/` 映射回 `legacy-mirror/assets/`（重资产永不复制进源码树）；
   - `shellRouter()`：干净 URL 映射到 shells，未知 URL 回落源站 404 模板并返回 HTTP 404（复刻 Webflow 语义）【lando】。
5. **平台运行时当行为契约逆向**，写进逆向笔记（lando 的 `05-webflow-html.md`）：
   - 哪些模块必须保留："必须保留 webflow 三连（jQuery→schunk→entry）"，因为 taxi 换页后要调 `window.Webflow.destroy()+ready()`；
   - 页面骨架顺序、head 契约（异步双 CSS 的 preload 技巧）、`data-*` 属性命名体系【lando】。
6. 构建产物侧的字节保真也要盯：lando 的 postbuild 把 vite 对 srcset 二次编码的 `%2520` 还原为 `%20`（登记为偏差 6.12）【lando】。

验收 checklist：
- [ ] 每项变换均有偏差登记条目；变换数与登记数一致。
- [ ] 生成脚本"零变换即 throw"的防御在位。
- [ ] shells 与镜像 diff：仅登记变换处不同，其余逐字一致。
- [ ] 未知路径 404 语义与源站一致。
- [ ] 全路由 × 双端探针 CLEAN（lando：7 路由 × 桌面/移动 = 14/14 PASS）。

## 3. 策略 B：脚本切组件（静态单页）【oryzo】

适用：镜像里有一个可直接切分的静态 HTML（oryzo：单页 46,000px），目标框架能容纳原始标记。

操作步骤：
1. 写切分脚本（oryzo：`gen_components.py`）把镜像 `index.html` 按 section 切成组件文件（oryzo 切成 18 个 Astro 组件）。
2. 切分必须**保守 pretty-print**，三条规则【oryzo】：
   - 只在原有空白间隙处换行（不引入新空白）；
   - 非空白文本字节级保留；
   - 目标框架的特殊字符转义（oryzo：花括号转义防 Astro 语法冲突）。
3. 临时补位样式（shim）显式标记生命周期：oryzo 的 `phase1-shims.css` 每条注明"将在 phase 2 被引擎逻辑取代"，后续如期删除【oryzo】。

验收 checklist：
- [ ] 构建产物 body 与源站 HTML **空白归一化后 diff 为空**【oryzo】。
- [ ] 浏览器几何一致（oryzo：scrollHeight 46410px 与源站相同）。
- [ ] shim 清单中每条都有取代计划，收官时清零。

## 4. 策略 C：框架内重建 + 字节对齐（框架编译产物）

适用：DOM 由框架运行时/SSR 生成，无法"直接搬 HTML"，必须在同栈同版本框架内重建，然后**用字节对齐门证明重建输出与源站编译产物等价**。按框架分四条子路线：

### 4.1 Vue SPA：指定原版 `__scopeId`【samsy】
- Vue 组件写成 options + template 字符串，**手动指定源站编译产出的原版 `__scopeId`**（如 `data-v-da121a04`）——这使源站编译好的 scoped CSS（`main.css` 原样拷贝）**零改写生效**。
- 代价要登记：vue 需 alias 到含运行时编译器的 esm-bundler 构建【samsy】。
- DOM/应用层 1:1 覆盖（samsy：13 组件、router 守卫怪癖照抄），文本细节到码点：自研 SplitText 移植时不可见字符逐码点核对（U+200B/U+00A0/U+202F）【samsy】。
- noomo 的等价做法：Vue scoped style 的 `data-v-*` hash 用显式模板属性复现，登记为偏差【noomo】。

### 4.2 Nuxt SSR：逐字节 payload 对齐【noomo】
- 验收标准是 SSR 输出与镜像**逐字节一致**：`__NUXT_DATA__` payload（noomo：1804 字节全等）、body DOM、config script（掩掉 buildId），**连 `<html  lang="en">` 的双空格都要对齐**【noomo】。
- 建立可重复执行的门 `verify-ssr.mjs`：9 路由 body/payload/config 与镜像逐字节 diff + 尾部脚本顺序 + 未知 slug 404 行为，**每 commit 必跑**（noomo 的 commit message 几乎每条以 "SSR gates green" 结尾）【noomo】。
- Pinia store 全签名移植（30 state + 29 getters + 33 actions，**死代码照抄**）——payload 字节对齐会暴露任何字段缺漏【noomo】。
- **传递依赖也要钉死**：同一 Nuxt 版本不等于同一输出——unhead 2.0.17 vs 2.1.17 会反转 bodyClose 脚本顺序，破坏尾部字节序，用 overrides 钉死【noomo】。
- 无法配置的框架行为用等价机制对齐并登记偏差（noomo：device 模块用 `modules:done` hook 裁剪 runtime config）【noomo】。

### 4.3 Next RSC：从 flight payload 读段树形状【kimi】
- **段树/路由结构从 RSC flight payload 读出，不凭框架惯例猜**：kimi 的根 layout 放在 `app/(lang)/layout.tsx` 而非 `app/layout.tsx`，因为源站 `<html>/<body>` 挂在 `"(lang)"` 边界【kimi】。
- RSC payload 单独镜像到 `_rsc/`；其中含逐请求随机 nonce，**diff 前必须 mask**【kimi】。
- 服务端行为在客户端产物里零留痕：redirects 必须逐 URL 实测状态码；Next `permanent: true` 发 308 而源站发 301——**门必须断言状态码本身**，差异登记为偏差【kimi】。
- 契约门覆盖面（kimi `verify-routes.mjs`，81 项经审查扩到 94 项）：head 8 字段 × 5 路由、12+8 条重定向含状态码与尾斜杠链、怪癖可达性、assetPrefix、favicon【kimi】。

### 4.4 CSS 层：双向 diff【rogier】
框架内重建时 CSS 无法整体照搬的，用双向 diff 收口：
- **正向 diff**：解析双方样式表，共享选择器**逐属性**比对，抓"差一点"的值（letter-spacing、字号阶梯 `.ts-1` 2rem/2.25rem@1000/2.625rem@1280、根字号作用域）【rogier】。
- **反向扫描**：枚举重建侧**源 bundle 里没有的全部规则**（rogier：118 条 (media, selector)），逐条判定"必要机制 / 等价别名 / 多余发明"——rogier 揪出 3 条真发明（`.ui-header-bg` 桌面渐变、`.ui-work-a` 的 transform transition、移动端 text-shadow）并删除【rogier】。
- **级联顺序即语义**：源站把布局工具类（`.grid`、`.col-*`）放在样式表**末尾**，重建放开头会让同特异性冲突全部反向解析、栅格坍塌——连"规则出现顺序"一起复刻【rogier】。
- 死规则照抄：`.ts-split` 在 JS bundle 和镜像 HTML 里零引用，确认死代码后仍原样保留【rogier】。
- Tailwind 站的 grep 陷阱：产物可能走 server-inline 通道，grep .css 文件会误判 utility 是否存在【noomo】；noomo F2（大字偏小）根因就是 19 个 `text-sans/serif` `@utility` 整族缺失，从源站 CSS 逐条重建【noomo】。

## 4.5 环境门控分支：localhost 语义分叉

源站发布产物里常内联**按 host 判定环境**的分支，最典型是主题/框架的 dev 逃生门：

```js
if (location.hostname === 'localhost') { /* 探测 vite dev 端口、连 HMR */ }
else { /* 生产路径 */ }
```

复刻工程在本地跑 = hostname 就是 `localhost`，于是**被迫走进一条线上永不执行的分支**，产生源站从不发出的 dev 端口探测噪声。这类分支在 Shopify/Webflow 等平台主题里很常见【racingshop】。

两条路线，按项目目标选，**都必须登记**：

| 路线 | 做法 | 代价 | 何时选 |
|---|---|---|---|
| **保持 verbatim**（默认） | 一字不改，把分叉登记进 §Q 怪癖表 | 本地跑会有 dev 探测噪声；需在 CLEAN 门白名单里放行并写明理由 | 追求字节级忠实；噪声无外联、无副作用（racingshop 选此，登记为 Q1）【racingshop】 |
| **强制生产分支** | 改写条件使其恒走 else 分支 | 属于**自创改动**——违反"源站有的都要有"的字面纪律，必须登记进 §6 偏差表并说明"何时重新考虑" | 噪声会污染验收门信噪比、或探测行为有真实副作用（外联/报错/阻塞渲染） |

判定顺序：先看这条分支**有没有副作用**（外联？抛错？阻塞？）。无副作用 → 一律 verbatim + 怪癖登记，这是纪律的默认答案。有副作用 → 才动它，且按偏差登记，不要顺手"清理干净"。

反模式：把分支**删掉**而不登记。这会让后续任何人无法从复刻侧还原源站真实行为，属未登记偏差 = bug。

## 5. 策略 D：DOM 即场景图（DOM/CSS 是 3D 引擎的坐标源）【shopifydesign】

不是第四种"外壳来源"，是一层**正交约束**：它不改变 DOM 由谁生成，只改变 DOM 层出错的**后果**——从"文档不像"变成"3D 物体位置错"。

### 5.1 准确形态：不是"DOM 被标注了场景数据"，是"浏览器的 CSS 排版结果本身就是场景图"

预想的形态是 SSR HTML 上挂 `data-webgl-src`/`data-depth`，引擎读属性建场景。逆向后的真实形态强一档（shopify.design 场景解析器 `QL(n)` `_pretty/_index-c3dAurQC.js` L30737–L30899、布局读取器 `mG.readLayout` L46372–L46385）——引擎取的**第一手数据不是属性，是排版结果**：

| 引擎读什么 | 得到什么 |
|---|---|
| `getBoundingClientRect()` × 全局缩放因子 | 世界坐标 `worldX` / `worldZ` / `worldWidth` / `worldHeight` |
| `getComputedStyle()` 的 `fontSize`/`textAlign`/`fontFamily`/`fontWeight`/`lineHeight`/`letterSpacing` | SDF 文字的全部排版参数 |
| `getComputedStyle()` 的 `border-radius` | 图片圆角 / pill 圆角 |
| `getComputedStyle()` 的 `transform: matrix(...)` | 形状旋转角（`Math.atan2` 反解） |
| CSS 自定义属性 `--card-width` / `--card-height` / `--card-gap` | 轮播卡片几何 |
| `data-*` 属性 | **只补 CSS 表达不了的维度**：Z 景深、切片数、SDF 模式、形状类型、颜色 |

一句话记法：**HTML 与 CSS 不是外壳，是场景的坐标源。**

### 5.2 取证判据（怎么认出自己遇到了策略 D）

**两问并列，都要做**：静态取证认出"DOM 是坐标源"，运行时取证认出"**哪一份** DOM 才是坐标源"。只做前者会漏掉后者——shopifydesign 的策略 D 结论出自逆向期的**静态观察**，第二问是竖切之后的**运行时观察**才补上的【shopifydesign】。

**① 静态取证：三件套。** 在 bundle 里搜：**`querySelectorAll("[data-*]")` + `getBoundingClientRect()` + `getComputedStyle()` 同时出现在同一个函数里**——命中即按策略 D 处理。（三者单独出现不算数：测滚动位置、判响应式断点都会用到前两个。）

**② 运行时取证：hydration 后布局是否被改写？——SSR DOM ≠ 场景图。**

在镜像上用**同一份场景解析探针**采两次，比对同一批节点的 `getBoundingClientRect()`：① **纯 SSR 排版**（摘掉框架运行时，或在 hydration 接管前量）；② **hydration 后的静止态**（框架 effect 跑完、所有异步回填结束）。两次有差 → 服务端下发的 HTML 只是场景图的**初值**，改写后的结果才是引擎读到的坐标。竖切期会自然撞上这个形态：把 SSR 外壳原样端起来、只换引擎，数值门第一次跑就红。

> **实证【shopifydesign】**：M2 把镜像 SSR 外壳原样端起来（只摘掉框架运行时、换上移植引擎），场景图数值门立刻红，且可逐个归因——
> - hero 三栏**贪心砌砖**（`z5` L45192–L45204，由 `H5` L45309–L45350 驱动，栏高权重 `1/aspect`），而输入 `aspect` 由 `<video onLoadedMetadata>` L45225–L45229 **异步回填**，每回填一次重排一次 → 24 张卡换栏（`worldX`/`worldZ` 变，尺寸/`depth`/`src` 不变）、`.hero-grid` 4078 vs 4175px、`docHeight` 13798 vs 13895、其后所有对象统一 **+97.078**；
> - 倒计时舞台 `.countdown-stage-sticky > .manifesto` 的客户端定位 → `manifesto-*` **−3321.602**、`countdown-headline`/`cd-ring` **−1829.4**。

**三条后果（判据命中后立即生效）**：

1. **镜像 HTML 的 DOM 顺序不能当作场景顺序的规格。** 规格在**重排代码**里（那段砌砖/定位函数），SSR 结果只是它某一次的输出。把 SSR 顺序抄成固定表 = 把一个中间态钉死成规格，等真移植了重排层，这张表要么删掉要么变成掩盖 bug 的补偿层。
2. **对拍基准必须取自运行时，不是静态 HTML。** 采基准要等到重排的输入齐了（本站 = 最后一次 `onLoadedMetadata` 回填、静止态达成）再抓；镜像侧与复刻侧都按同一个"静止态判据"抓，不按墙钟等待时长。
3. **框架布局层从"某个里程碑的一个模块"升格为场景正确性的前置依赖**，排期必须提前——不移植它，数值门在原理上就不可能变绿（shopifydesign M2 因此延后 102 个字段，M3 移植布局层后全部归零）。这也说明**策略 A 是必要条件而非充分条件**：零重写外壳只保证初值逐字正确，不保证场景正确。

### 5.3 三条推论（每条都改变工程决策）

1. **字节门升格为几何门。** 现有三策略把 DOM 层当"外壳"，字节门是**文档保真**的门；策略 D 站上 **CSS 差 1px，3D 物体就位移 1px × 全局缩放**，字节门变成 **3D 正确性**的门。于是策略 A（零重写 shells）从"可选的省事做法"升级为**唯一正确做法**——任何重写、切分、框架内重建都是在往坐标源里注入误差，且误差会以"3D 位置不对"的形态显现，不会被当成 DOM 问题去查。（同时注意 §5.2 ②：A 只保证 SSR 初值逐字正确，若 hydration 后布局被改写，还得把那段重排代码也逐字移植，几何门才可能变绿。）
2. **读取器自带副作用，必须逐字复刻。** `readLayout()` 在解析前把根节点改成 `transform:""; position:fixed; height:100vh`，读完立刻还原并 `window.scrollTo(0, a)`。语义是：清 `transform` 把**入场动画的位移排除在场景坐标之外**；`position:fixed` 让 `scrollY` 归零，使场景坐标成为**与滚动无关的绝对快照**。**实测漏掉这一步：镜像与线上出现统一 158px 的 Z 偏移**——那正是被 `transform=""` 抹掉的入场位移。移植时连同还原顺序一起抄，不许"优化掉"。
3. **它顺带带来一个比像素门更该先建的门**：把引擎读 DOM 的那个函数逐字转写成探针，两侧逐字段比数值。判据与建门方法见 `references/verification-gates.md`。

## 6. 常见坑（各策略通用）

1. **自创补偿性 CSS 会反转成 bug**：JS 机制没对齐时用 CSS 补观感，等 JS 对齐后补丁全部反转——rogier 十余个视觉 bug 全部源于此。"宁可先不像，也不要发明规则"【rogier】。
2. **门只断言想到的字段是盲的**：`<main>` 只比 3 个固定字段抓不到"shell 组件发明了源站没有的 DOM 属性"；修法是**并集全量比对**替代字段名单【kimi】。
3. **只测一种 URL 形态漏掉重定向链**：kimi 只测无斜杠形态，尾斜杠重定向链与源站相反没被抓到，R1 审查才发现【kimi】。
4. **构建器会悄悄改字节**：vite 对 srcset 内 URL 二次编码 `%20→%2520` 导致 7 张含空格文件名的图 404，自动门抓不到，靠目视兜底 + postbuild 还原 + 登记偏差；教训："srcset/style 内 URL 的编码保真需要纳入构建期对拍"【lando】。
5. **`<body style="opacity:0">` 这类 FOUC 防线是行为**，照抄，由 JS（preloader init）清除；"先显示再动画"必闪帧——"时序即视觉"【rogier】。
6. **路由换页只换该换的**：源站只替换 `.ui-main` 内视图，header/nav 是常驻组件——整块替换导致入场动画重放；修复后用 **DOM 身份测试**验证（跨多次导航断言 `.ui-header` 是同一个 JS 对象）【rogier】。
7. **坏链也要复刻**：源站 favicon.svg 404，重建应删除本地文件但保留 head 里的 link——补一个占位文件反而是偏离【rogier】。
8. **策略 C 忘记钉传递依赖**：框架小版本、传递依赖都会改变输出字节序，字节门红了先查依赖树再查代码【noomo】。
9. **策略 A/B 的生成脚本静默通过**：不加"零变换即 throw"防御，镜像结构变化后会静默产出坏 shells【lando】。
10. **策略 D 站上按常规选型**：把 DOM 当外壳去切分/重建，等于改 3D 坐标源；症状显现为"物体位置不对"，排查方向天然跑偏。同类错误还有漏抄 `readLayout()` 的三处副作用（§5.3 推论 2，实测统一 158px Z 偏移）【shopifydesign】。
11. **把 SSR HTML 的 DOM 顺序当成场景顺序的规格**：hydration 后若有客户端重排，SSR 结果只是初值；照它钉死顺序会在重排层落地时反转成补偿层，而对拍基准取静态 HTML 则一开始就量错了对象。判据与取证方法见 §5.2 ②【shopifydesign】。
