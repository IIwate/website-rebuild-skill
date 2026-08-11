# 逆向建坐标系（阶段 1：Reverse）

> **何时加载本文件**：镜像已完成且本地断网跑通（M0/M0.5 阻塞门通过）之后、写下任何复刻代码之前，进入逆向阶段时加载。本阶段产出 `_pretty/` 行号坐标系、`docs/engine-notes.md` 逆向笔记、技术栈取证表、数值基准——它们是移植与验证的全部地基。

## 0. 预检：bundle 形态判定

先判定 bundle 形态，再决定是否需要 beautify：

```bash
head -c 600 legacy-mirror/<path-to-bundle>.js          # 看开头形态
awk '{ if (length($0) > m) m = length($0) } END { print m }' <bundle>.js   # 最长行
grep -c 'sourceMappingURL' <bundle>.js                 # 有无 sourcemap 指针
```

| 形态 | 判据 | 流程分支 |
|---|---|---|
| minified/混淆产物（常态） | 单行或数万字符长行；标识符压成 1–2 字符 | 走 §1 beautify 流程 |
| **未混淆 esbuild 产物** | 标识符全保留、自带换行缩进——开头即 `var __defProp = Object.defineProperty;`、内部函数名（如 `copyAttributeData`）原样可读 | **跳过 beautify**，直接以原文件行号为坐标系（边界探测实录：bruno-simon 4.86MB 产物、star-atlas 均属此类） |
| 带公开 sourcemap 且 sourcesContent 完整 | map 可下载且含完整源码 | 直取 sourcesContent 替代 beautify（边界探测实录：orano） |

无论走哪个分支，**"行号 = 全项目唯一溯源坐标系"的制度不变**，只是坐标系落在哪份文件上不同。

## 1. 建立 `_pretty/` 行号坐标系

### 1.1 展开命令（版本钉死 1.15.1）

```bash
mkdir -p legacy-mirror/_pretty
npx --yes js-beautify@1.15.1 legacy-mirror/<path>/<bundle>.js \
  -o legacy-mirror/_pretty/<bundle>.pretty.js
```

- 多 chunk 站（Next 等）把**全部 chunk 逐个展开**（kimi 展开 21 个 chunk 共 57,068 行）【kimi】。
- 版本沿革：samsy 首次把版本钉死制度明文化（当时 2.0.3），kimi/noomo/lando 三代统一 1.15.1——本 skill 钉 **1.15.1**，不要用别的版本【samsy】【kimi】【noomo】【lando】。

### 1.2 `_pretty/README.md`（必写，与展开同一次完成）

内容必须包含：

1. beautifier 精确版本（`js-beautify@1.15.1`）；
2. 逐文件的**再生成命令**（照抄上面的命令行，可直接复制执行）；
3. 警告原文级别的红线声明：**换 beautify 版本行号会漂移，整套引用作废**【samsy】【noomo】；
4. 原件纪律：镜像原件目录（`_nuxt/`、`assets/` 等）保持字节纯净，`_pretty/` 是分析产物，二者永不混淆【noomo】。

### ⛔ 红线

**beautifier 版本漂移 = 整个溯源体系作废。** 行号一漂，全项目所有 `LNNNN` 引用（逆向笔记、移植文件头注释、里程碑待办、怪癖/偏差登记表）一次性失效且无法自动修复。任何人重新生成 `_pretty/` 只许用 README 里登记的命令与版本。

### 1.3 行号引用格式（全项目唯一坐标系）

- 单 bundle 站：`pretty LNNNN`（如 "BufItem，pretty 行 29722–29809"【oryzo】）。
- 多 chunk 站：`<chunk-hash> Lnnnn`（如 `_pretty/7020daab554f970c` L13231）【kimi】。
- 行号引用**贯穿四处**，不允许第二套坐标系：
  1. 逆向笔记 `engine-notes.md` 的每条结论；
  2. 每个移植文件的头注释（阶段 2 使用，见 porting-discipline.md）；
  3. 里程碑日志的"下一步断点待办"——如 samsy M7a 待办直接写 "字体管理器 **pretty L60740-L60844（未读）**"，跨会话交接靠它【samsy】；
  4. 怪癖表与偏差表的每条证据。
- 实践规模参考：oryzo 107 处 / samsy 276 处 / noomo 161 处 / lando 400+ 处行号引用【oryzo】【samsy】【noomo】【lando】。

## 2. 逆向笔记 `docs/engine-notes.md` 先行

**独立里程碑，产出并提交这份笔记之前不写任何复刻代码**——oryzo 把它列为 M2.0，"文档先行显著降低了后面每轮的返工"【oryzo】；后四代全部沿用【samsy】【kimi】【noomo】【lando（6 份笔记 00-05）】。

### 2.1 三段式内容结构

**第一段：源站事实**（全部带行号）

- **bundle 区段地图**：vendor 边界逐段标行号——lando 给 47k 行画了全区段地图（GSAP 5043-6743、three 10334-30143、Lenis 46469-47010、应用代码各段），"先画地图再挖矿"【lando】；samsy 同样逐段标 vendor 边界【samsy】；
- 启动链 / 路由 / store（逐字段用途）；
- 渲染管线、RenderTarget 清单、材质清单（samsy 26 项 TSL 材质、后处理链逐步拆解）【samsy】；
- 协议与数据 schema（VAT worker 协议、PartyKit 协议全量【samsy】；i18n/数据 schema【kimi】）；
- 混淆名对照表（noomo：`nn`=RenderingPipeline、`X`=Root…）【noomo】；
- 页面 init/destroy 矩阵（每个页面的初始化/销毁函数及行号）——它直接变成移植阶段的任务清单【lando】。

**第二段：怪癖清单（照抄不修）**：源站 bug / 死代码 / 怪写法逐条登记并带行号，移植时逐字照抄。规模参考：noomo Q1–Q14、samsy 13 条、kimi 26 条【noomo】【samsy】【kimi】。

**第三段：对复刻的直接结论**：如 noomo 的 10 条（"先实现三个元系统再写任何材质"、"缺 colorsMap 玻璃会变灰白"）【noomo】；samsy 的"不要发明"清单（engine-notes §16）【samsy】。

### 2.2 笔记纪律

- **只陈述源站事实，不做"应该怎么改"的判断**——决策写进 REBUILD_PLAN，不写进笔记【kimi】【noomo】；
- **未坐实的一律标注"未确认"，不猜**【kimi】；
- 事实与决策分离，防止"边看边写"导致的臆造【samsy】。

## 3. 技术栈从 bundle 取证、精确钉死【6/6】

### 3.1 取证指纹类型（每个版本号都要有出处）

| 指纹类型 | 实例 |
|---|---|
| bundle 内版本字符串 | `hN="3.5.25"`（Vue）、`versions:{get nuxt(){return"4.2.1"}`、GSAP `version:"3.13.0"` ×6【noomo】 |
| 全局变量 | `window.next={version:"16.1.6",appDir:!0}`、`window.__THREE__="184"`【kimi】 |
| pnpm 路径泄漏 | 一条路径一次性钉死 next/react/babel/sass 四个版本【kimi】 |
| wasm/CDN URL | Rive 版本从 bundle 内 wasm URL 取证【lando】 |
| API 指纹 | zustand `getInitialState` 无 `destroy` ⇒ v5【kimi】 |
| CSS 特征 | `@property --tw-drop-shadow-alpha` ⇒ Tailwind v4.1.0+【kimi】 |
| 响应头 | `x-powered-by: Nuxt`【noomo】 |

### 3.2 钉死落地

- 安装用 `npm i --save-exact`，`package.json` 不带 `^`【kimi】【lando】；
- **传递依赖也要钉**：noomo 用 `overrides` 钉 unhead 2.0.17——2.1.17 会反转 bodyClose 脚本顺序、破坏与源站的尾部字节序，"同一 Nuxt 版本不等于同一输出，传递依赖也要对齐"【noomo】；
- 源站用 dev 分支时取最接近正式版并**登记为偏差**（samsy：源站 three r182dev → 复刻 0.182.0）【samsy】；
- 逐项证据写成技术栈取证表（REBUILD_PLAN §2 格式：项 / 版本 / 取证方式）【noomo】。

## 4. 证伪流程：假设必须先证否

### 4.1 signature grep 只提假设，不当结论

grep 命中只是假设，**每条必须回上下文确认**：kimi 站 grep 到 `leva` 实为 React SVG 属性列表里 `…decelerate|descent…` 的子串误命中，`swr` 同类；`zustand` 反而真实存在只是被内联【kimi】。samsy 早期指纹误判"有 GPU compute"，M1 证伪——`dispatchWorkgroups` 字符串全部来自 three 内部；KTX2/meshopt 能力在 GLTFLoader 里但从未挂载【samsy】。

### 4.2 架构假设先证否再动工

最强案例【kimi】：依赖表里有 three.js + r3f，但**这不是 WebGL 站**——视觉主体是 DOM + 18 个 CSS 自定义属性 + `clip-path` 擦除 + 三个 2D canvas 软件渲染器；`<Canvas>` 只有两个且都懒加载，唯一真 3D 是正交相机 + 32 个 plane、零着色器。"这个误判如果没在动手前发现，会把绝大部分力气花在极小部分画面上"。

操作化：

1. 写下架构假设（"这是 WebGL 站 / GSAP 时间轴站 / …"）；
2. 列出"若为真必然成立"的可检验推论（Canvas 实例数、着色器数量、视觉主体由什么驱动）；
3. 逐条到 bundle / 运行时验证，**先找证否证据**；
4. 证否成本远低于沿错误方向移植的成本。

## 5. grep 混淆代码：搜值不搜名

- **常量名会被混淆重命名**：three 的 `REVISION` 在 noomo 的 bundle 里搜不到，最终靠常量值 `const nv="179"`（`_pretty` L19973）锁定版本【noomo】。
- 比标识符可靠的锚点：**版本号字符串值、十进制颜色字面量**（`15064825` = 0xE5DEF9）、**GLSL 特征串**【noomo】。
- 实操：MB 级单行文件先 `tr` 注入换行再 grep，防有界量词正则卡死（边界探测协议教训）。

## 6. 数据驱动动画：先 dump 成数值账本

原则："**compare recorded values, not screenshots**"（noomo `dump-timelines.mjs` 注释，显式引用 careers-kimi 教训）【noomo】【kimi】。凡被数据驱动的动画，逆向阶段就把数据源 dump 成 JSON 数值基准入库，之后验收用数值全等而非截图目测：

- **GLB 烘焙曲线**：手写解析器 dump 全部动画曲线（noomo `docs/timeline-baseline/` 2.4MB：dev.glb 38 条参数轨道 ×481 帧、cam.glb 相机 601 帧）；后续验收即"相机位置在 t=0/5/10/19 与基准插值小数点后三位全等"【noomo】；
- **CSS 变量时间序列**：探针在镜像上录基准（kimi `probe-deck-vars.mjs` → `docs/deck-baseline/source-*.json`）【kimi】；
- **bundle 内联 base64 资产**提取到 `legacy-mirror/_extracted/`（noomo：colorsMap 1024×2 光谱 LUT、SMAA 纹理——缺 colorsMap 玻璃会变灰白）【noomo】。

**基准覆盖面判据**：录之前先确认"观感由哪些量驱动"，把全部驱动量采进基准——kimi 只采 `<main>` 上 18 个变量，位置 3.2 之后变量饱和、场景 3-7 实由容器 opacity 驱动，基准"完全失明"；补采 opacity 后覆盖立刻到 8.2【kimi】。

## 7. 常见坑（逆向坑）

1. **beautifier 版本不钉死 → 行号漂移 → 整个溯源体系作废**【samsy】【noomo】。对策：§1.2 的 README 制度，任何再生成只用登记的命令。
2. **signature grep 子串误命中**（`leva` 命中 SVG 属性列表）【kimi】。对策：每条命中回上下文确认后才能写进笔记。
3. **依赖表撒谎**（three.js 在依赖里但不是 WebGL 站）【kimi】；指纹误判"有 GPU compute"【samsy】。对策：§4.2 架构假设先证否。
4. **搜名搜不到**：REVISION 等常量被重命名【noomo】。对策：§5 搜值不搜名。
5. **数值基准覆盖不全导致后段失明**（18 变量在 3.2 后饱和）【kimi】。对策：§6 先确认全部驱动量。
6. **正则假阳性污染 diff/取证**：`.15` 无前导零、十六进制色值记法差异造成两轮假阳性，samsy 改用"数字字面量多重集 + 结构对比"才收敛出真实增量【samsy】。对策：数值比较先归一化记法。
7. **逆向笔记混入改进判断**导致移植阶段"顺手修 bug"。对策：§2.2 事实/判断分离 + 怪癖单列"照抄不修"。

## 8. 阶段产出物与通过判据

- [ ] `legacy-mirror/_pretty/`：全部 bundle/chunk 已展开（或按 §0 预检登记"无需 beautify，坐标系 = 原文件行号"）
- [ ] `_pretty/README.md`：含 js-beautify@1.15.1 版本声明 + 逐文件再生成命令 + 版本漂移警告
- [ ] `docs/engine-notes.md`：三段式齐全（事实带行号 / 怪癖清单 / 复刻直接结论），全文无"应该怎么改"，未坐实处标"未确认"
- [ ] 技术栈取证表：每个依赖版本都有 bundle 内证据，`package.json` 计划为 `--save-exact`，传递依赖风险已评估
- [ ] 架构假设已做过一轮显式证否（记录证否手段与结论）
- [ ] 数据驱动动画的数值基准已 dump 入库（`docs/*-baseline/`），驱动量覆盖已确认
- [ ] bundle 内联资产已提取到 `_extracted/`（如有）
- [ ] 阶段计划（REBUILD_PLAN）已按 engine-notes 的"复刻直接结论"排出依赖序里程碑

全部勾选后才进入阶段 2（加载 `porting-discipline.md`）。
