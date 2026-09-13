---
name: website-rebuild
description: Rebuild a website from its client assets and recorded behavior, then compare the local result against the captured reference. Use for requested website reproduction, including WebGL, scroll animation, portfolio sites, and archived sites.
compatibility: Node 22+, npm/npx, local Chrome or Chromium for browser checks, and a POSIX environment with process groups and ps. Some scripts invoke pinned npm tools and require those packages to be cached for offline use.
metadata:
  version: "0.3.22"
---

# Website Rebuild

以源站 HTML、CSS、JavaScript、数据资产和运行结果为依据, 重建可独立运行的网站. 交付范围由用户目标决定: 保存镜像、恢复工程, 或整理可读源码. 验证结论必须说明覆盖的路由、状态、视口和允许差异; 检查通过不等于对所有行为的等价证明.

方法与案例来自仓库记录的 6 个初始项目、后续 22 个完整复刻、5 个存档恢复项目和 43 站范围探测. 这些记录用于说明具体机制与边界, 不作为其他项目的工期或成功率承诺. 入口案例见 [references/case-studies/skill.md](references/case-studies/skill.md).

## 使用前提与授权

处理用户自有、已获授权, 或在适用访问与使用条件下可研究的公开资源. 登录、付费墙、访问控制和真实交易不属于本 skill 的匿名采集范围.

先明确目标 URL、页面与功能范围, 再解释目标站的访问规则. `robots.txt` 按适用用户代理组和 URL 路径判断抓取规则, 不构成版权许可. 服务条款、资产许可和部署授权分别记录, 不能相互替代. 具体读法见 [references/legal-and-deploy.md](references/legal-and-deploy.md) §0.3.

未获发布授权时, 产物用于本地或已有授权的私有环境. `noindex` 仅约束搜索索引, 不能代替访问控制. 公开部署、再分发或新增外部服务操作需要相应授权; 已明确的授权在同一操作与影响范围内持续有效.

镜像完整性按已确定的采集范围计算. 未采集资源必须记录 URL、原因与影响; 不能把范围排除或访问受限的资源计为已获取. 具体资产归属与许可记录见 [references/legal-and-deploy.md](references/legal-and-deploy.md).

## 适用范围

分类依据是目标行为的实现是否可获得, 以及是否存在可复现的观察基准.

| 类别 | 可用依据 | 处理方式 |
|---|---|---|
| A | 客户端脚本与静态资产包含目标行为 | 镜像、溯源移植并验证 |
| B | 客户端行为可获得, 但依赖平台接口、外部存储或运行时数据 | 补充快照与平台适配, 记录无法恢复的服务行为 |
| C1 | 服务端组件源码不下发, 可获得 HTML 和 RSC/Flight 输出 | 从输出重建组件结构, 明确区分观测事实与推断 |
| C2 | React、Vue、R3F 等声明式组件的客户端实现可获得 | 按客户端代码处理; 框架名称不决定可行性 |
| D | 目标能力依赖不可获得的服务端逻辑或私有状态 | 说明无法恢复的能力, 仅继续已明确且可实现的范围 |
| X | 目标版本已失效, 存档可能保留其页面或资源 | 按资产层评估存档覆盖, 再确定可恢复范围 |

完整判定见 [references/scope-and-fingerprint.md](references/scope-and-fingerprint.md). C1 见 [references/rsc-reconstruction.md](references/rsc-reconstruction.md), X 见 [references/archival-rescue.md](references/archival-rescue.md). HTTP 200、框架指纹或少量截图都不能单独证明目标版本仍完整可用.

## User Input Tools

从对话、项目文件和现有证据补足常规信息. 只有无法合理推断的范围选择、关键缺口或新增授权需求才提问, 并继续其他已授权工作. 使用当前运行时可用的提问工具或简短文字, 说明待决定事项、已有证据和实际影响. 不要求固定问题数量或报告格式.

## 实现约束

1. `mirror/` 保存采集原件. 本地 URL、接口替身和探针注入在服务层或派生产物中处理; 保留原件以便复核.
2. 每个影响行为的实现决定应有源码位置、数据资产或运行记录支持. 版本与行号不足以唯一定位时, 同时记录文件摘要.
3. 保留目标范围内的源站行为, 包括影响结果的异常实现. 修正源站行为属于有意偏差, 需要单独说明原因与影响; 这不限制修复复刻工具自身的缺陷.
4. 镜像、移植结果与可读源码之间的变更应可追溯. 已确认的事实、推断、未解决项和有意偏差分别标记.
5. 根据具体变更选择验证. 检查应报告输入、覆盖数量、失败项与退出码, 并区分执行失败、前置条件不足和行为差异.
6. 文档随实际行为更新. 提交遵守项目约定与用户授权, 不因里程碑完成而自动提交.

## Workflow

### 交付层级

| 层级 | 交付内容 | 完成条件 |
|---|---|---|
| L1 镜像存档 | 原件、清单、本地服务配置与缺失记录 | 已声明范围可离线访问, 限制已明确 |
| L2 工程化复刻 | 可运行工程、来源映射与验证记录 | 目标行为在约定检查中满足验收条件 |
| L3 可读源码 | 模块划分、符号映射、必要注释与自包含运行资产 | 源码可构建或直接运行, 与已验收基线的比较通过 |

已明确的交付层级直接执行. 后续层级复用前序产物, 不重复采集或重做已有验证. 基于复刻产物开发新产品属于另一个目标, 交接参考 [references/beyond-the-rebuild.md](references/beyond-the-rebuild.md).

### Flow

**Step 0 / Step 1: 范围与架构分析.** 按 [references/scope-and-fingerprint.md](references/scope-and-fingerprint.md) 检查目标路径、版本与行为来源. 按 [references/recon-and-rating.md](references/recon-and-rating.md) 核实架构、数据依赖与可行性. 关键词命中只用于定位, 需要回到调用点确认实际使用.

**M0 / M0.5: 采集与离线基线.** 按 [references/mirroring.md](references/mirroring.md) 组合静态引用扫描、浏览器请求记录和运行时路径分析. 用 `verify-mirror.mjs` 检查 URL 映射、清单与磁盘一致性、类型与挑战页特征、已发现引用的完整性; 回源抽样是可选联网检查. `serve.mjs` 提供本地服务, `probe.mjs` 或 `sweep-routes.mjs` 检查实际加载. `GAP=0` 只针对已发现且纳入核对的资源, 不能代替引用发现覆盖检查.

**M1: 建立来源映射.** 按 [references/reverse-engineering.md](references/reverse-engineering.md) 区分平坦脚本、Flat-IIFE、scope-hoisted ESM 和模块化容器. 有 sourcemap 时优先检查 `sourcesContent`; 需要格式化时固定工具版本并保留原件. 建立必要的模块边界、依赖、版本和数据记录. [engine-notes 模板](assets/templates/engine-notes.md) 与 [rebuild-plan 模板](assets/templates/rebuild-plan.md) 按项目规模选用.

**M2+: 实现.** 按 [references/porting-discipline.md](references/porting-discipline.md) 依赖顺序移植. 优先验证包含输入、状态更新和输出的一条完整功能链. 数据、GLSL 与已确认代码片段采用脚本提取, 保留来源坐标. 平台适配按下表加载对应参考.

**M(n-1): 行为验证.** 按 [references/verification-gates.md](references/verification-gates.md) 选择资源、路由、DOM、载荷、数值、像素与交互检查. 多路由加载使用 `sweep-routes.mjs`, 单路由诊断使用 `probe.mjs`. 需要确定性驱动时读 [references/determinism.md](references/determinism.md); 差异归因读 [references/gate-failure-modes.md](references/gate-failure-modes.md). 像素容差依据可比状态下的重复采样制定, 不能在看到跨侧差异后任意放宽.

**M(n): 覆盖核对与交付.** 核对模块或声明清单的实际覆盖, 记录未恢复功能和有意偏差. 部署相关说明按已有目标与授权整理; 需要发布时使用 [references/legal-and-deploy.md](references/legal-and-deploy.md) 中与该用途相关的检查.

**M(n+1): 可读源码.** 按 [references/readable-source.md](references/readable-source.md) 整理模块与符号. 先保留已验收的 `port/` 基线, 再更改 `src/`. 保持共享闭包、求值顺序、可变绑定、随机数消费顺序和异步就绪条件. 结构重写超出单纯可读性整理时, 单独评估行为影响. 复用已有检查, 不放宽容差. scope-hoisted 产物可按原序切片并重组, 用 `verify-reassembly.mjs` 检查字节一致性.

### 场景参考

| 发现的机制 | 参考 |
|---|---|
| WebGL、Canvas、GLSL、场景图 | [webgl-scenes.md](references/webgl-scenes.md) |
| GSAP、烘焙动画、CSS 变量、输入状态机 | [animation-recovery.md](references/animation-recovery.md) |
| 自定义二进制、GLB、VAT、Rive | [binary-formats.md](references/binary-formats.md) |
| Shopify 平台接口与主题脚本 | [shopify-platform.md](references/shopify-platform.md) |
| Sanity CMS 数据与图片协商 | [sanity-platform.md](references/sanity-platform.md) |
| DOM 外壳、SSR 与布局依赖 | [dom-shell-strategies.md](references/dom-shell-strategies.md) |
| Flight、Nuxt 与长度前缀载荷 | [payload-gates.md](references/payload-gates.md) |
| 数值用例、跨侧比较与模块覆盖 | [gate-case-design.md](references/gate-case-design.md) |
| 大文件、资产清单与字体 | [asset-management.md](references/asset-management.md) |
| 浏览器节流、网络时序与环境差异 | [environment-traps.md](references/environment-traps.md) |

## Script Directory

可执行脚本的参数与用法见 `node scripts/<name>.mjs --help`, 版本见 `--version`. 未知长选项退出 2. 模板、库文件与浏览器注入脚本并非全部是独立 CLI. 脚本索引见 [scripts/README.md](scripts/README.md), 源码整理工具见 [tools/README.md](tools/README.md).

`scripts/` 使用 Node 内置模块和本地共享模块. 部分脚本通过子进程调用固定版本的 Acorn、js-beautify 等 npm 工具; 因此"无第三方 import"不等于"无需外部工具或下载". 离线运行前确认所需工具已缓存. `tools/` 的 AST 变换使用其 `package.json` 中的开发依赖.

验证脚本不应导入会重新生成被检查产物的入口. 可共享无副作用的路径、解析与格式约定, 但共享实现可能产生共同盲区, 仍需独立输入或反例验证. token 比较验证词法内容, 无法单独证明自动分号插入、控制流或所有运行状态等价.
