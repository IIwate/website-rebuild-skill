# DOM 层三策略选型指南

> **何时加载本文件**：完成镜像（M0）与逆向（M1）后、搭工程骨架（M2）前——需要决定"页面 HTML/CSS 外壳如何获得"时加载。本文件回答一个问题：DOM 层是零重写生成、脚本切分、还是框架内重建。

## 1. 选型决策树

选型判据只有一条：**原站 DOM 的生成方是谁**。先在镜像 HTML / bundle 里取证，再按下表分支。

```
原站 DOM 由谁生成？
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
- 分支可组合：lando 是"平台外壳（策略 A）+ 自定义 bundle 应用层手写重写"的混合——外壳与应用层可分别选策略【lando】。

**共同验收（三策略通用）**：产出 HTML 与镜像做"空白归一化 diff 为空"或逐字节 diff 为空【oryzo】【noomo】【kimi】。字节层的门要**最先建立、终身保持全绿**——"字节层先行使后续所有视觉 debug 都能排除 DOM/payload 差异"【noomo】。

**策略速查表**：

| 策略 | 适用 | HTML 来源 | 核心验收 | 出处 |
|---|---|---|---|---|
| A 零重写 shells | 平台导出物 | 镜像 HTML + 登记变换直接生成 | 仅登记变换处不同，其余逐字一致 | 【lando】 |
| B 脚本切组件 | 静态单页 | 切分脚本保守 pretty-print | 空白归一化后 diff 为空 | 【oryzo】 |
| C 框架内重建 | 框架编译产物 | 同栈同版本框架内重建 | SSR/payload 逐字节 diff 为空 + CSS 双向 diff | 【samsy】【kimi】【noomo】【rogier】 |

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

## 5. 常见坑（各策略通用）

1. **自创补偿性 CSS 会反转成 bug**：JS 机制没对齐时用 CSS 补观感，等 JS 对齐后补丁全部反转——rogier 十余个视觉 bug 全部源于此。"宁可先不像，也不要发明规则"【rogier】。
2. **门只断言想到的字段是盲的**：`<main>` 只比 3 个固定字段抓不到"shell 组件发明了源站没有的 DOM 属性"；修法是**并集全量比对**替代字段名单【kimi】。
3. **只测一种 URL 形态漏掉重定向链**：kimi 只测无斜杠形态，尾斜杠重定向链与源站相反没被抓到，R1 审查才发现【kimi】。
4. **构建器会悄悄改字节**：vite 对 srcset 内 URL 二次编码 `%20→%2520` 导致 7 张含空格文件名的图 404，自动门抓不到，靠目视兜底 + postbuild 还原 + 登记偏差；教训："srcset/style 内 URL 的编码保真需要纳入构建期对拍"【lando】。
5. **`<body style="opacity:0">` 这类 FOUC 防线是行为**，照抄，由 JS（preloader init）清除；"先显示再动画"必闪帧——"时序即视觉"【rogier】。
6. **路由换页只换该换的**：源站只替换 `.ui-main` 内视图，header/nav 是常驻组件——整块替换导致入场动画重放；修复后用 **DOM 身份测试**验证（跨多次导航断言 `.ui-header` 是同一个 JS 对象）【rogier】。
7. **坏链也要复刻**：源站 favicon.svg 404，重建应删除本地文件但保留 head 里的 link——补一个占位文件反而是偏离【rogier】。
8. **策略 C 忘记钉传递依赖**：框架小版本、传递依赖都会改变输出字节序，字节门红了先查依赖树再查代码【noomo】。
9. **策略 A/B 的生成脚本静默通过**：不加"零变换即 throw"防御，镜像结构变化后会静默产出坏 shells【lando】。
