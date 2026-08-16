---
name: website-rebuild
description: 1:1 rebuild of award-winning creative websites (WebGL / scroll-animation / portfolio sites). Evidence-driven pipeline - mirror-first forensics, line-number-traceable reverse engineering of minified bundles, verbatim porting, quantitative verification gates. Use when user asks to "复刻网站", "重建网站", "1:1 rebuild", "clone this site", or provides a URL of a creative/award site to reproduce.
compatibility: Requires Node 22+ (bundled scripts use built-in WebSocket to talk to CDP), npx, and a local Chrome/Chromium for headless comparison. POSIX shell optional - the Step 0 probe protocol has a zero-dependency Node equivalent (scripts/fingerprint.mjs) for shells without curl/cmp/tr/perl (e.g. Windows PowerShell). Agent-agnostic - works in any Agent Skills-compatible runtime.
metadata:
  version: "0.1.13"
---

# Website Rebuild（获奖创意站 1:1 复刻）

把一个获奖创意网站（WebGL / 滚动叙事 / 作品集站）以**取证式方法**复刻为可独立运行、可验证还原度的工程。不是"看着像"的仿制——是以源站 bundle 为唯一规格书、以量化验收门收口的逐行为移植。

本方法论提炼自六个连续实践项目（工期从 6.5 周收敛到 1 天），并经 43 站边界探测实测校准适用范围。

## 使用前提与授权 ⛔ 必读

本 skill 面向**学习与研究目的**的保真复刻，用于研究获奖创意站的实现手法。适用对象是你**自有的、已获授权的，或公开可访问且允许学习临摹**的网站。它不是用于未授权地采集受保护内容、规避访问控制、或商业性盗用他人作品的工具。

执行时遵守下列边界：
- **尊重目标站规则**：遵守其 `robots.txt`、服务条款与版权；抓取保持低频、单会话，不对目标站施加异常负载。
- **不触碰受保护边界**：不采集需要登录态、付费墙或授权才能访问的内容；本 skill 只处理匿名可公开访问的资源。若目标站明确禁止此类复制，停止并告知用户。
- **产出默认私有**：默认 noindex、不公开部署。任何公开前必须完成逐资产版权取证，并显著标注"非官方复刻"与原作者归属（见 [references/legal-and-deploy.md](references/legal-and-deploy.md)）。

⛔ **法务判断归用户，skill 只取证与呈现**（三条，全程有效）：

1. **决定权在用户**：skill 收集事实（逐资产归属、许可状态、第三方权利人、源站是否仍在营业、产物内第三方标识符）、列出选项与各自的风险边界、给出建议与理由；凡涉及"能不能公开 / 部署 / 再分发 / 对外展示"，**必须用下文「User Input Tools」显式交回用户**，不许 agent 自行下法律结论后继续往下走。
2. **未获用户明确决定前按安全默认执行**：私有仓库 + `noindex` + 不公开部署 + 不再分发。写给用户时说明这是**默认动作**（"在你决定之前我不会把它发出去"），**不是** agent 已作出的法务结论——两者责任归属完全不同。agent 只能往保守侧执行默认，往公开侧走必须有用户的明确决定。
3. ⛔ **法务考量不得削减镜像完整性或门的覆盖面**：镜像是证据基座，**完整性是技术不变量**（四遍法、闭包门、GAP=0 全建立在它之上）。不抓只能有**技术性理由**（不是文件 / 服务端不提供 / 需授权或登录态 / 源站明令禁止），一律登记；**不得**以"反正不公开""不该多存一份"这类法务理由留洞。实证：某项目以"产出永不公开"为由对一类资产"登记、不补抓"，**缺了约 60% 的资产而五道门始终全绿**，藏了四个里程碑【objectarchive】。法务决定作用于**产出怎么被使用**，不是证据基座是否完整。

## 适用范围（v0.1）⛔ 必读

**主场（A 类）**：内容静态托管、签名行为（动画/交互）全部存放在客户端静态资产里的站——命令式 WebGL/Canvas 场景、GSAP 时间轴、烘焙数据文件（GLB/.buf/.riv）、minified 或未混淆的 bundle。绝大多数 Awwwards 风格创意站属于此类。

**有条件支持（B 类）**：管线成立但需要额外场景处理（Shopify 平台层剥离、第三方存储桶资产、运行时 API 快照、SSG payload 展开）。v0.1 提供的指南覆盖部分 B 类场景，遇到未覆盖的要向用户明示风险。

**明确拒绝（C/D 类）**：
- **C**：签名行为存放在声明式组件树里（React RSC flight 流、R3F + Theatre.js、重度 Vue/Nuxt 编译产物且客户端 chunk 不含行为源）——本 skill 的"转写式移植"对其失效，需要另一套"重构式逆向"方法论（未实现）。
- **D**：行为主体在服务端（CMS 内容站、电商 cart/库存、A/B 实验分桶、个性化注水）——客户端没有可移植的目标物，且确定性验收无基准。

**X 类**：原站已消失（域名易主 / 平台回收 / 路径移除 / 原地被替换）。引导用户提供 Wayback 快照或换目标。历年获奖站实测消失率约 29%——这也是"第一时间镜像"是本 skill 第一纪律的原因。

判级由 Step 0 指纹侦察决定，完整判定树见 [references/scope-and-fingerprint.md](references/scope-and-fingerprint.md)。**拒绝时要解释原因并说明该站属于哪一类**，不要硬跑。

## User Input Tools

需要向用户提问时（确认范围、**法务决定**、外部依赖决策）：优先使用当前运行时的内置提问工具（如 `AskUserQuestion`）；没有则输出编号问题清单让用户回复编号。支持多问合并时一次问完。法务类提问按 `legal-and-deploy.md` §0.1 的五段式写：事实 / 查不清的 / 选项 / 每个选项的风险边界 / 建议与当前默认动作。

## 宪法（六条纪律，全程有效）

以下六条在六个源项目中被称为"宪法级"，违反任何一条都会在后续阶段以 bug 形式偿还：

1. **镜像神圣不可污染**：`legacy-mirror/` 磁盘文件永不修改；一切本地化适配（CDN 改写、外链 stub）在服务层响应时动态完成。
2. **源站代码是唯一裁决，不凭观感修**：每个改动先在 bundle/CSS/镜像 HTML 里找到归属行号再落地。Do not tune visuals, motion, or interaction by eye.
3. **源站有的都要有，源站没有的不做**：不自创补偿性 CSS/JS。宁可先不像，也不要发明规则——自创补丁会在机制对齐后反转成 bug。
4. **bug / 死代码 / 怪写法照抄不修**：压缩代码里的每个怪写法都可能是行为本身。"好心修正" no-op bug 曾导致转场崩溃（实证见 porting-discipline.md）。
5. **有意偏差必须登记**：写清"源站怎么做 / 我们怎么做 / 为什么 / 什么条件下重新考虑"。**没登记的差异一律视为 bug**。
6. **代码与文档同一次提交**：每个里程碑成对提交（`Port xxx` + `Update rebuild plan: xxx`），日志固定含产出 / 验收 / 教训 / 下一步断点（带行号）。

## Workflow

### Progress Checklist

```
[ ] Step 0  指纹侦察与范围门 ⛔（判级 A/B/C/D/X；C/D/X 拒绝或引导，不进入下一步）
[ ] Step 1  开工评级（架构证否、分项难度打星、工期预估、与用户确认范围）
[ ] M0      镜像取证 ⛔（BFS 爬虫 + CDP 补录 + manifest 账本；GAP=0）
[ ] M0.5    镜像断网跑通 ⛔（零 404 / 零控制台错误 / 零外联；serve.mjs 伺服）
[ ] M1      逆向建坐标系 ⛔（_pretty 钉版本展开；engine-notes 先于任何代码；技术栈钉死；REBUILD_PLAN 建立）
[ ] M2+     严格溯源移植（依赖序里程碑推进；先竖切一条端到端链路；每里程碑冷启动实测 + CLEAN 门）
[ ] M(n-1)  对拍验收（按 verification-gates.md 决策树选门型；根因修复，不调参糊平）
[ ] M(n)    收口 ⛔（冷头评审 / 模块清单对账；版权取证 + 呈交用户决定——公开部署前必须完成）
```

⛔ = 阻塞门：验收标准未达成不得进入下一阶段。

### Flow

**Step 0 — 指纹侦察与范围门**。加载 [references/scope-and-fingerprint.md](references/scope-and-fingerprint.md)，对用户给的 URL 执行探测协议（GET 到路径粒度、最终 URL 同一性、双抓 diff、物种/年代校验、bundle 初检），输出判级与依据。A/B 类继续；C/D/X 类向用户解释后停止或引导。

**Step 1 — 开工评级**。加载 [references/recon-and-rating.md](references/recon-and-rating.md)。架构假设先证否（依赖表会撒谎），分项难度打星（素材/3D/滚动编排/私有格式/平台层），向用户确认复刻范围（整站或指定页面）与预期。

**M0 / M0.5 — 镜像取证**。加载 [references/mirroring.md](references/mirroring.md)。用 `scripts/mirror-site.mjs` BFS 爬取 + `scripts/netcapture.mjs` 真实浏览器补录，manifest 逐文件登记 sha256，`redirect: manual` 纪律，外部依赖逐项决策。`scripts/serve.mjs` 伺服镜像，断网验收。**这一步永远最先做**——原站随时可能消失或改版，镜像是全项目唯一证据基准，也是后续一切对拍的参照服。

**M1 — 逆向建坐标系**。加载 [references/reverse-engineering.md](references/reverse-engineering.md)。`scripts/beautify-bundle.mjs`（js-beautify 钉 1.15.1）展开 bundle 到 `_pretty/`，此后行号是全项目唯一溯源坐标系。先写 `docs/engine-notes.md`（模板：[assets/templates/engine-notes.md](assets/templates/engine-notes.md)）再写任何代码。技术栈从 bundle 取证钉死精确版本。数据驱动动画先 dump 数值账本。建立 `REBUILD_PLAN.md`（模板：[assets/templates/rebuild-plan.md](assets/templates/rebuild-plan.md)）。

**M2+ — 严格溯源移植**。加载 [references/porting-discipline.md](references/porting-discipline.md)，并按分支路由表加载对应场景指南。每个移植文件头部注明源行号区间；GLSL/魔数/数据逐字提取；数据资产脚本抽取入库不手抄。

**M(n-1) — 对拍验收**。加载 [references/verification-gates.md](references/verification-gates.md) 与 [references/determinism.md](references/determinism.md)。门型选择：有 SSR/静态 HTML 产物先建字节门 → DOM 静态场景冻结熵源走 byte-equal → 活场景（WebGL/视频/随机相位）降级量化指标 + 噪声归类 → 数据驱动动画补数值探针门 → CLEAN 门全程兜底。判定时序 bug 前先校准探针（[references/environment-traps.md](references/environment-traps.md)）。

**M(n) — 收口**。冷头评审：对 bundle 顶层类/模块清单逐一核对落点（功能测试测不出整块遗漏，只有清单式核对能）。加载 [references/legal-and-deploy.md](references/legal-and-deploy.md) 完成版权**取证**并把决定**呈交用户**——在用户决定之前按安全默认执行（**私有 + noindex + 不部署**），公开前必须逐资产取证、显著标注非官方复刻。

### 分支路由表

Step 1 侦察结果决定加载哪些场景指南（按需，不要全量加载）：

| 侦察发现 | 加载 |
|---|---|
| WebGL / Canvas 场景（three.js、自研引擎、GLSL） | [references/webgl-scenes.md](references/webgl-scenes.md) |
| GSAP / 烘焙动画数据 / CSS 变量动画 / 自研输入状态机 | [references/animation-recovery.md](references/animation-recovery.md) |
| 私有二进制格式（.buf / .sog / VAT / GLB 时间线 / .riv） | [references/binary-formats.md](references/binary-formats.md) |
| Shopify 店铺（指纹见 `cdn/shop`、`Shopify.theme`、`cdn.shopify.com`） | [references/shopify-platform.md](references/shopify-platform.md) |
| DOM 层策略选型（所有站必经；Webflow 导出 / 静态单页 / 框架 SSR 分支不同，另有"DOM 被 3D 引擎当坐标源读"的正交约束） | [references/dom-shell-strategies.md](references/dom-shell-strategies.md) |
| 大体量资产（百 MB 级媒体 / 授权字体） | [references/asset-management.md](references/asset-management.md) |
| 无头探测行为异常 / 疑似环境问题 | [references/environment-traps.md](references/environment-traps.md) |

### Step Summary

| 阶段 | 关键动作 | 阻塞门验收 | 产出物 |
|---|---|---|---|
| Step 0 | 指纹探测判级 | 判级明确且已告知用户 | 判级结论与依据 |
| Step 1 | 证否 + 评级 + 确认范围 | 用户确认 | 难度评级表、范围共识 |
| M0/M0.5 | 镜像 + 账本 + 断网跑通 | GAP=0；零 404/零错误/零外联 | `legacy-mirror/`（只读）、manifest、`serve.mjs` 参照服 |
| M1 | 展开 bundle、逆向笔记、钉栈 | engine-notes 完成；版本钉死表完成 | `_pretty/`、`docs/engine-notes.md`、`REBUILD_PLAN.md` |
| M2+ | 溯源移植、里程碑成对提交 | 每里程碑冷启动实测 + CLEAN 门绿 | 带行号注释的源码、三张登记表滚动更新 |
| M(n-1) | 对拍验收 | 所选门型全绿或差异全部登记 | 验证脚本 + 对拍产物入库（`docs/compare/`） |
| M(n) | 冷头评审 + 版权取证 + 呈交用户 | 清单对账零缺口；用户已作出部署决定（未决则维持安全默认） | 审计记录、DEPLOY.md |

## Script Directory

全部为零依赖 Node 脚本（Node 22+），路径相对本 skill 目录。用法与成熟度详见 [scripts/README.md](scripts/README.md)。

| 脚本 | 用途 | 使用阶段 |
|---|---|---|
| `scripts/fingerprint.mjs` | Step 0 六步探测协议的跨平台等价实现（GET 存活 + 重定向链与终点域同一性、双抓 diff、物种/年代、HTML 技术指纹、bundle 初检；出现次数计数与 <1KB Referer 重试内置）。**只采证据不出判级**——判级仍走 scope-and-fingerprint.md §3 判定树 | Step 0（无 POSIX 工具链时） |
| `scripts/mirror-site.mjs` | BFS 爬虫镜像（资产白名单 + 迭代到不动点；`redirect:manual` + 三本账，含逐文件 sha256） | M0 第一遍 |
| `scripts/netcapture.mjs` | 真实浏览器 CDP 抓包对账补录运行时资源（**CDN 站必须传 `--hosts`**，否则只观测同源流量、会报假 GAP=0） | M0 第二遍 |
| `scripts/gapfill-video.mjs` | HLS/DASH 流媒体阶梯补录（master → rendition → 分片），静态爬虫的结构性盲区 | M0（有流媒体时） |
| `scripts/serve.mjs` | 零依赖静态服务器（MIME/Range/服务层改写/重定向回放），兼任源站参照服 | M0.5 起全程 |
| `scripts/beautify-bundle.mjs` | js-beautify@1.15.1 钉死展开 bundle 到 `_pretty/` 并生成再生成说明 | M1 |
| `scripts/extract-source.mjs` | 字节切片器：按钉死行号区间切 `_pretty/` 拼成生成文件（sha256 守卫 + 切片表 + 别名/桩表，`--check` 进门），逐字移植首选形式（§2.2；配置样例 `scripts/slices.config.example.mjs`） | M2+（逐字移植期） |
| `scripts/probe.mjs` | CDP 无头探针（console/异常/网络 CLEAN 判定，退出码进 CI；`--no-external` 断言零外联、`--walk` 全滚动走查） | M0.5 起每 commit |
| `scripts/verify-routes.mjs` | 路由/重定向/状态码契约门 | M2+ |
| `scripts/verify-ssr.mjs` | SSR/DOM 逐字节门 | M2+（有 SSR 产物时最先建） |
| `scripts/pixelcompare.mjs` | 量化像素对拍（粗网格相似度 + metric 输出）。**视口 ≳ 1500×900 时 PNG 过不了 CDP 载荷硬顶**，改 `--format jpeg --quality 92`（撞顶时响亮失败并给降级清单，不再无声超时） | M(n-1) |
| `scripts/side-by-side.mjs` | 双侧截图并排合成图（对拍产物留证） | M(n-1) |
| `scripts/probe-shim.js` | 确定性驱动 shim（接管整个熵面：rAF/timer/`performance.now`/`Date.now`/定种 `Math.random`，手动泵到任意 t，双侧同位注入） | M(n-1) |
| `scripts/dump-timelines.mjs` | GLB 动画曲线 dump 成 JSON 数值账本 | M1（数据驱动动画时） |
| `scripts/lib/png.mjs` | 零依赖 PNG 编解码 | 对拍脚本依赖 |
| `scripts/lib/chrome.mjs` | 无头浏览器生命周期（**进程组**收割 + 全退出路径 + 启动前孤儿自检；漏子进程会抬高参照侧自比带宽，把像素门调松）与 CDP 载荷硬顶常量。`node scripts/lib/chrome.mjs --all/--reap` 可查/回收残留 | 所有 CDP 脚本依赖 |

## 复刻工程目录结构

```
<site>-rebuild/
├── legacy-mirror/        # 只读镜像（源站 URL 空间的字节级还原）
│   └── _pretty/          # beautify 展开产物 + 再生成说明 README
├── docs/
│   ├── engine-notes.md   # 逆向笔记（事实/怪癖/复刻结论三段式）
│   └── compare/          # 对拍产物留证
├── REBUILD_PLAN.md       # §0 纪律 / 阶段计划 / §6 偏差表 / §Q 怪癖表 / §7 里程碑日志
├── mirror-manifest.json  # 镜像账本（sha256 逐文件）
├── scripts/              # 从本 skill 拷入并按站点配置的工具脚本
└── src/ 或框架工程        # 复刻实现（DOM 策略见 dom-shell-strategies.md）
```

## References

按需加载（Step 0/1 与分支路由表决定），不要开局全量读入：

- [scope-and-fingerprint.md](references/scope-and-fingerprint.md) — 第 0 步判级与路由（必经）
- [recon-and-rating.md](references/recon-and-rating.md) — 开工侦察与难度评级（必经）
- [mirroring.md](references/mirroring.md) — 镜像取证全流程（必经）
- [reverse-engineering.md](references/reverse-engineering.md) — 行号坐标系与逆向笔记（必经）
- [porting-discipline.md](references/porting-discipline.md) — 溯源移植纪律（必经）
- [verification-gates.md](references/verification-gates.md) — 验收门选型与失效模式（必经）
- [determinism.md](references/determinism.md) — 确定性冻结协议与 probe-shim
- [dom-shell-strategies.md](references/dom-shell-strategies.md) — DOM 层策略选型（A/B/C + 正交约束 D）
- [webgl-scenes.md](references/webgl-scenes.md) — WebGL/GLSL 场景逆向
- [animation-recovery.md](references/animation-recovery.md) — 动画/输入逆向路径
- [binary-formats.md](references/binary-formats.md) — 私有二进制格式
- [shopify-platform.md](references/shopify-platform.md) — Shopify 平台层剥离（B 类）
- [asset-management.md](references/asset-management.md) — 资产不复制策略与字体决策
- [environment-traps.md](references/environment-traps.md) — 环境陷阱手册
- [legal-and-deploy.md](references/legal-and-deploy.md) — 版权取证与部署决断（取证归 skill，决定归用户）
- [assets/templates/rebuild-plan.md](assets/templates/rebuild-plan.md)、[assets/templates/engine-notes.md](assets/templates/engine-notes.md) — 文档模板

## Notes

- **版权红线**：本 skill 用于学习目的的复刻。产出默认私有 + noindex（安全默认，不是法务结论）；公开部署前必须完成逐资产版权取证、把决定交回用户、并显著标注非官方复刻与原作者归属。最大风险是法务不是技术——但**法务判断由用户作出，且永不用于削减镜像完整性或门的覆盖面**。
- **工期预期**：方法论成熟形态下，单页创意站 1-3 天（数十个 commit）；多场景 WebGL 作品集站按周计。向用户给预估时参考 Step 1 的难度评级。
- **对拍失败先怀疑环境**：后台节流、HMR 幽灵模块、探针时钟、headless 字体缺失都会伪装成代码 bug。判定源码问题前先过 environment-traps.md 的校准清单。
- 遇到本 skill 未覆盖的场景（B 类缺口），明确告诉用户"这一段没有既成指南，按通用纪律推进"，并把新经验记入项目文档——它们是 skill 下一版的输入。
