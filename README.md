# website-rebuild-skill

一个网站复刻技能（skill）：输入一个获奖创意网站的网址，按取证式方法论完成 1:1 复刻——全站镜像作证据、逆向 minified bundle 建立行号溯源、逐行为移植、量化验收门收口。

遵循 [Agent Skills 开放规范](https://agentskills.io/)，为**任何支持 skills 的智能体**设计——Claude Code / Claude Desktop 只是其中之一，任何实现该规范的 agent runtime 均可加载使用（skill 内的提问、脚本调用均按运行时能力自适应，不绑定特定产品）。

方法论提炼自六个连续实践项目（rogierdeboeve → oryzo → samsyninja → careers-kimi → storytellingnoomo → landonorris，工期从 6.5 周收敛到 1 天），适用边界经 43 站实测探测校准（9 个异质基准站 + 3 个 Shopify Editions + 31 个 Awwwards Sites of the Year 全量）。

## 能做什么

**主场：获奖创意站**——内容静态托管、动画/交互全部存放在客户端静态资产里的站：

- 命令式 WebGL / Canvas 场景（three.js、自研引擎、GLSL/TSL）
- GSAP 时间轴、滚动叙事、烘焙动画数据（GLB / .buf / .riv）
- Webflow 导出壳 + 自定义 bundle、静态构建器产物（Astro / Nuxt SSG 等）
- minified、混淆或未混淆的 bundle 均可（js-beautify 行号坐标系 / sourcemap 直取）

实测参照：31 个历年 Awwwards 年度站中，存活可探测的站点全部落在本方法论适用范围内（A/B/C 三级，无一 D 级）。

## 不能做什么（明确边界，实测得出）

| 类型 | 原因 | 例子（实测） |
|---|---|---|
| 声明式架构站（C 类） | 签名行为在 React RSC flight 流 / R3F+Theatre 组件树里，"转写式移植"失效，需要另一套"重构式逆向"（roadmap 中） | Linear、Duolingo、Next App Router + RSC 站 |
| 服务端行为站（D 类） | 行为主体在服务端（CMS、电商 cart/库存、A/B 分桶、个性化），客户端无可移植目标、验收无确定性基准 | TechCrunch（WordPress）、Airbnb |
| 已消失的站（X 类） | 无镜像对象。历年获奖站实测消失率约 29%（域名易主/平台回收/原地替换） | darknetflix.io、umamiland |

技能会在第 0 步对目标站做指纹判级，超范围会明确拒绝并解释原因，不会硬跑产出垃圾。判定规则见 [skills/website-rebuild/references/scope-and-fingerprint.md](skills/website-rebuild/references/scope-and-fingerprint.md)。

**注意**：能不能做和该不该公开是两回事。本 skill 定位学习用途，产出默认私有部署 + noindex；公开前必须完成逐资产版权决断（详见 skill 内 legal-and-deploy 指南）。

## 安装与使用

前提：Node 22+、本机 Chrome/Chromium（无头对拍用）、`npx` 可用。

把 `skills/website-rebuild/` 整个目录放到你的 agent 的 skills 目录即可。以 Claude Code 为例：

```bash
# 用户级（或项目级 .claude/skills/）
cp -R skills/website-rebuild ~/.claude/skills/website-rebuild
```

其他支持 Agent Skills 规范的 runtime 按其各自的 skills 目录约定放置同一目录。

使用：给你的 agent 一个网址，说"复刻这个站"/"1:1 rebuild 这个网站"。技能会自动走：指纹判级 → 开工评级与范围确认 → 镜像取证（⛔ 门）→ 逆向建坐标系（⛔ 门）→ 溯源移植 → 量化验收 → 冷头评审与版权决断。

## 方法论一页纸

四阶段管线：**镜像取证**（第一时间全站镜像作只读证据，断网跑通为验收门）→ **逆向建坐标系**（js-beautify 钉版本展开，行号是全项目唯一溯源坐标系，逆向笔记先于任何代码）→ **严格溯源移植**（每个改动先找到 bundle 归属行号；bug 与怪写法照抄不修）→ **验证收口**（五类量化验收门按站点特性选型，冷头评审兜底）。

六条宪法：镜像神圣不可污染；源码唯一裁决不凭观感修；源站有的都要有、没有的不做；bug 照抄不修；偏差必须登记（没登记的差异一律视为 bug）；代码与文档同 commit。

## 仓库结构

```
skills/website-rebuild/    # 技能本体，目录结构遵循 agentskills.io 规范
├── SKILL.md               #   主流程 + 判级门 + 宪法纪律（激活时整体加载）
├── references/            #   15 份分场景指南（按需加载）
├── assets/templates/      #   REBUILD_PLAN / engine-notes 文档模板
└── scripts/               #   15 个零依赖 Node 工具 + lib/ 4 个共用模块
README.md                  # 本文件
```

## Roadmap

- **v0.1.1（已合并）**：首个实战项目（racing.shop，B 类 Shopify 店）的回流——Shopify 平台层指南、HLS 流媒体阶梯补录、爬虫协议相对 URL 修复、零外联门断言面补全、stub 双模式规则、localhost 语义分叉策略
- **v0.1.2（已合并）**：第二个实战项目（shopify.design，A 类 WebGL 单页）的回流。三处**出厂脚本与出厂文档自相矛盾**已修（爬虫违反自己的 `redirect:manual` 红线、manifest 缺 sha256、抓包只录同源会静默报假 GAP=0）；新增**场景图数值门**（比像素门更早建、更可归因）、**第九种冻结协议：能力探测**（GPU 基准把画质档烘进 shader 源码）、**镜像第四遍静态闭包校验**、**DOM 策略 D：DOM 即场景图**；判定树升级为"框架模式 × 引擎范式"二维；Step 0 计数硬约束（`grep -c` 数的是行数不是次数 + vendor 归属剔除）
- **v0.1.3（已合并）**：同一项目走完 M2 竖切与 M3 后的回流。最重要的一条是**冻结的盲区**——冻掉的分支上挂着的子系统会以"通过"的形式从验收门消失（一个缺失子系统就这样跨越两个里程碑、数值门全程报绿，最后靠不冻结的截图抓到），据此新增第七种门失效模式，并否定了"数值门优于像素门"的排序。另有：场景图门补"两侧须同程序"前提与竖切期分组关账、竖切期桩与删桩纪律（缺失清单要两本）、字节切片式逐字移植（打包 `extract-source.mjs`）、策略 D 补"hydration 后布局是否被改写"判据
- **v0.1.4（已合并）**：同一项目走完 M4a（文字子系统，单轮切 13,147 行）后的回流。最重要的一条是**快门速度**——"按状态对齐抓帧"的门开工前必须先量"单次截图耗时 / 被测运动全长"，比值 ≥ ~1/10 时抓到的相位由 CDP 往返决定，仪器会造出**稳定可复现的**假相位差（差点被写成"复刻侧动画更快"）。顺带解掉 skill 自身的一处自相矛盾：`--use-gl=swiftshader` 既是推荐旗标、又命中 §2.9 能力探测表里的 GPU 名黑名单——它属于**能力探测熵源**，会静默把被测程序切到 low 档 shader，现已在三处交叉标注适用边界与配套动作。另有：冻结盲区枚举补**产物粒度**（产物不写 DOM → 数值门覆盖率为 0）、绝对断言补**期望值来源纪律**（期望值必须从镜像基线 + 源站计数规则推导，否则只是自比）、字节切片补**粒度指引**（大 vendor 岛整块切，边界按语句不按行）
- **v0.1.5（已合并）**：shopify.design 复刻收官（M4b/Mn/M4c）的 13 条回流。核心是一族三条互相印证的门失效模式：**检查点有位置和状态两维**（四道门全绿而一半状态零覆盖——每道门都按自己的定义正确；取证法是读引擎主绘制函数的早退分支）、**冷头评审的 decline 粒度必须等于"能整块缺失的东西"的粒度**（对账脚本第一版报 PASS 时正缺三个 React effect，因为它把整棵树按一条 range 判为 declined）、**把差异所在的区域扣掉就是掩盖缺陷**（"扣掉指针象限后逐像素相同"扣掉的正是唯一真 bug）。配套仪器：残差三分类器（最锋利的是"跨侧数字在参照侧自比分布里排第几"，而非"在带内"）、自比带宽须 3–4 次独立会话且先判可比、settle 必须是页面状态而非固定毫秒。脚本侧修了一个会同时造假红和假绿的真 bug：家族脚本随机调试端口区间重叠会串台，现改为按工作区/角色/侧别确定性分配 + 身份闸（`scripts/lib/ports.mjs`）
- **v0.1.6（已合并）**：新项目 objectandarchive（Awwwards Shopify 合集里的 Dawn fork 定制店）M0/M1 的回流。最重要的一条把"门是绿的而东西是错的"推到了**证据基座**：图片 CDN 是查询参数化的变换接口，`x.jpg?width=320/600/1200` 是三份不同字节，而 url→路径映射只看 pathname 时它们**坍缩成一个文件**——serve 端每个尺寸都回同一个文件、页面照常渲染，**零 404 门于是在一个错的镜像上变绿**。据此新增 `verify-mirror.mjs`（映射单射性／账本 sha256 一致／闭包／可选抽样回源），并把查询感知映射 `lib/urlpath.mjs` 做成镜像·服务·抓包·验收**四方共用**（三方映射不一致本身就是 bug 源）。同族另修：`srcset` 逐候选提取（旧正则让约 270 个变体对第一遍隐形）、裸主机基址常量改写（漏改导致 6 处外联与回源取图）、自指重定向回放死循环。方法论侧：Shopify 分层模型**三层升四层**（被 fork 的上游主题存量必须独立成层，否则移植任务表虚高 65%），主题矩阵补 Dawn 格；`reverse-engineering.md` 新增**无 bundle 站平行分支**（行为住在 Liquid 内联块、且是带作者注释的未压缩源码，beautify 与别名表整套不适用），其坐标系改用**内容哈希**——朴素的"行号建在镜像 HTML 上"实测不成立（跨 CDN 缓存条目时块会换序）；并把**坐标稳定性列为 M1 必答题**：本项目在 Step 0 预登记该风险、M1 开头验证、在写任何移植代码之前就换掉了方案
- **v0.2+（剩余 B 类缺口，按需求频率排序）**：第三方存储桶/manifest 驱动资产发现、运行时 API 与 headless CMS 快照、Nuxt/Vue SSG payload 展开、多 chunk 大型 bundle 切片、Wayback 抢救流程
- **远期（C 类分支）**：声明式架构的"重构式逆向"方法论。实测显示大厂创意页正在向该形态漂移（Shopify Editions 三代 B→B→C），此分支迟早需要
- 每完成一个新的复刻项目，将其新经验合并回本 skill

## 致谢

- 结构范式参考 [JimLiu/baoyu-skills](https://github.com/JimLiu/baoyu-skills) 的 baoyu-comic skill
- 方法论版权属于实践本身：六个源项目的 REBUILD_PLAN、engine-notes 与工具脚本是本 skill 的全部来源
