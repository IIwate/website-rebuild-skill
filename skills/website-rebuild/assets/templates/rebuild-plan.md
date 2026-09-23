# 重建计划模板

按项目规模选用本模板, 记录已约定的目标、依据、差异与验证结果. 已有项目记录能承载这些信息时直接复用. `{...}` 为占位符, HTML 注释为填写说明.

---

# {项目名} 重建计划

- 源站: {URL 与目标版本}
- 目标: {页面、功能、交付层级及验收范围}
- 采集与使用条件: {已确认条件和未解决项}
- 工具依据: {实际使用的脚本或 skill 版本; 需要区分同版本修改时附摘要}

## §0 实现约束

<!-- Use constraints that affect this project. Milestone completion does not authorize a commit, publication or deployment. -->

- 实现依据来自源码、数据资产或运行记录; 推断单独标明.
- 保留目标范围内的行为. 有意改变行为时记录原因和影响.
- 原始采集内容与派生产物分离, 变换可追溯.
- 验证对应具体风险, 并报告覆盖范围与未完成项.

## §1 镜像与外部依赖

<!-- Keep detailed URL records in the mirror manifest. This section summarizes scope, coverage and unresolved dependencies. -->

- 采集时间: {时间}
- 清单: {路径}; 文件数与体积: {数值}
- 发现方式: {静态引用、浏览器请求、运行时路径分析}
- 已验证范围: {路由、视口、状态、离线条件与结果}
- 缺失或排除项: {数量、原因与影响}

| 外部依赖 | 用途 | 处置 | 依据与影响 |
|---|---|---|---|
| {CDN / 字体 / 平台接口} | {用途} | {本地资源 / 已授权服务 / 未恢复} | {说明} |

## §2 技术栈证据

<!-- Pin versions when output or API compatibility depends on them. For WebGPU/TSL pipelines, note compute shader complexity and headless CPU rasterization baseline. Version strings, package paths and API signatures can support identification. -->

| 组件 | 版本或范围 | 来源证据 | 相关约束 |
|---|---|---|---|
| {框架或库} | {版本} | {位置或记录} | {影响} |

## §3 资源发现覆盖

<!-- Runtime workers, lazy assets and responsive variants can be absent from a static crawl. Record how each relevant class was examined. -->

| 资源或类别 | 发现依据 | 状态 | 缺失影响 |
|---|---|---|---|
| {路径或类别} | {引用 / 请求 / 路径推导} | {已获取 / 待处理 / 已排除} | {说明} |

## §4 阶段计划

<!-- Order work by dependencies and define observable completion conditions. Reuse previous captures and checks when their inputs remain valid. -->

| 阶段 | 范围 | 完成条件 | 状态 |
|---|---|---|---|
| M0 | {采集与基线} | {范围内资源及缺口可核对} | {状态} |
| M1 | {分析与来源映射} | {关键行为有可追溯依据} | {状态} |
| M{n} | {实现范围} | {具体行为或检查条件} | {状态} |

## §5 风险与待确认事项

<!-- Note high-risk platforms such as WebGPU compute shaders under headless CPU rasterization (rate compatibility risk at ★★★★☆ and plan dynamic CDP timeout). -->

| 问题 | 已有证据 | 影响 | 下一步 |
|---|---|---|---|
| {技术或使用条件} | {事实} | {受影响范围} | {可验证操作或必要决定} |

## §6 有意偏差

<!-- Examples include platform API substitutes, telemetry removal and comparison instrumentation. Record observable effects, not only the changed code. -->

| 编号 | 源站行为 | 本地行为 | 原因与影响 | 重新评估条件 |
|---|---|---|---|---|
| 6.1 | {依据} | {实现} | {说明} | {条件} |

## §Q 源站特殊行为

<!-- lando Q13 changed scene.remove(Q.name), a no-op in that source, into real removal and broke traversal during transitions. Check dependencies before changing unusual source behavior. -->

| 编号 | 现象 | 依据 | 处置与验证 |
|---|---|---|---|
| Q1 | {源站行为} | {文件位置或观测} | {保持行为 / 已说明的偏差} |

## §7 阶段记录

<!-- Record material outcomes and enough evidence to resume. Include a commit reference only when a commit exists. -->

### M{n} {阶段名称}, {日期}

- 产出: {文件或功能范围}
- 验证: {输入、覆盖、结果与限制}
- 未完成项: {阻塞或下一步入口}
