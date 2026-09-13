# 逆向分析笔记模板

在需要记录来源坐标、架构与行为依据时, 按项目规模选用本模板. 只保留相关章节, 填入已确认的事实、推断与未解决项. `{...}` 为占位符, HTML 注释为填写说明.

---

# {项目名} 逆向分析笔记

- 目标范围: {路由、功能与版本}
- 原始依据: {镜像文件、响应或运行记录}
- 源码坐标: {文件、格式化工具版本与再生成命令; 必要时附文件摘要}

<!-- Formatting changes can move line references. Retain the source identity and regenerate affected citations when the coordinate basis changes. -->

## 第一部分: 源站事实

### 1. Bundle 区段与模块

<!-- Record application/vendor boundaries with source coordinates. For scope-hoisted chunks, census-bundles can supply dependencies and import aliases. -->

| 来源位置 | 区段或模块 | 归属依据 |
|---|---|---|
| {文件与行号} | {名称} | {vendor / 应用代码 / 未确认} |

### 2. 技术栈证据

<!-- Version literals, package paths and recognizable APIs are evidence candidates. Confirm them at their definitions or call sites. -->

| 依赖 | 版本或范围 | 证据 |
|---|---|---|
| {three} | {0.179.0} | {例如 REVISION = "179", 文件与行号} |

### 3. 符号对照

<!-- Preserve the original identifier beside the proposed meaning. Import aliases can keep source and port citations traceable. -->

| 原符号 | 含义 | 定义与使用位置 |
|---|---|---|
| {nn} | {RenderingPipeline} | {文件与行号} |

### 4. 启动与生命周期

<!-- Follow entry, preloader, route initialization and first render. Record prerequisites that affect their order. -->

{步骤、条件与来源位置}

### 5. 渲染与布局

<!-- WebGL examples: scene hierarchy, render targets, materials and postprocessing. DOM examples: CSS variables, layout dependencies and Canvas constants. -->

{相关结构与来源位置}

### 6. 协议与数据

<!-- Record binary layouts, worker messages and data schemas. The oryzo .buf example uses a uint32 header length, JSON metadata and ordered attribute payloads. For baked animation, link the exported numeric baseline. -->

{格式、字段、解码方式与数据路径}

### 7. 路由与状态

{路由表、状态字段、守卫与影响目标行为的调用关系}

### 8. Shader 清单

<!-- A marker such as #define GLSLIFY 1 can locate shader text. Record both the source span and extraction destination. -->

| Shader | 来源位置 | 提取路径 |
|---|---|---|
| {名称或用途} | {文件与行号} | {路径} |

### 9. 动画与输入参数

<!-- Record values that affect behavior: easing control points, ScrollTrigger ranges, delays and wheel/touch thresholds. Examples include wheelEaseCoeff=12 in oryzo. Mark inferred values explicitly. -->

| 参数 | 值 | 依据 |
|---|---|---|
| {名称} | {值} | {源码位置或运行记录} |

### 10. 平台与 HTML 约定

{平台模块、脚本顺序、head 内容、data-* 属性及其运行用途}

### 11. 内联资产

<!-- Record extracted base64 textures, LUTs and tables with provenance. The noomo colorsMap case changed glass appearance when the asset was absent. -->

{原始位置、提取路径与缺失影响}

### 12. 页面初始化与销毁

| 页面 | 初始化 | 销毁 |
|---|---|---|
| {路由或页面标识} | {函数与位置} | {函数与位置} |

### 13. 已核对的假设

<!-- Record useful counterevidence. In prior cases, leva/swr were substring matches and dispatchWorkgroups calls belonged to three.js internals. A dependency name alone did not establish the page's rendering architecture. -->

| 假设 | 状态 | 证据 |
|---|---|---|
| {内容} | 已确认 / 已证伪 / 未确认 | {位置或观测} |

## 第二部分: 源站特殊行为

<!-- Record behavior that another implementation might accidentally change. Existing examples include noomo Q1-Q14, 26 kimi entries and 13 samsy entries. Keep the observation separate from the chosen treatment. -->

| 编号 | 现象 | 依据 | 处理及影响 |
|---|---|---|---|
| Q1 | {源站行为} | {位置或观测} | {保持行为或有意偏差} |

## 第三部分: 实现依据与未解决项

<!-- Derive implementation order and scope from the evidence above. Code present in a bundle may not be active; verify reachability before excluding it. -->

- 依赖顺序: {先决条件及其依据}
- 范围边界: {目标内外能力及确认方式}
- 关键数据: {资源、载荷或数值基线}
- 未解决项: {缺口、影响与下一步可验证操作}
