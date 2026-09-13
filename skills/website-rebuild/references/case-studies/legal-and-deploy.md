# 访问条件、资产许可与部署案例

按需核对历史项目的证据与限制. 章节编号对应 [legal-and-deploy.md](../legal-and-deploy.md). 历史项目的决定不构成其他项目的授权或许可结论.

## 0. 范围与授权

### 0.2 完整性必须有明确范围

objectarchive 曾以私有保存为由, 对一类资产只登记而未采集. 用户要求补充采集后, 镜像从 1,591 文件 / 587 MB 增至 4,131 文件 / 1.4 GB. 按补采后的文件数计算, 此前缺少约 60%, 而五项检查持续通过四个里程碑. 这个案例说明原检查的发现集合与覆盖范围不足; 它不能证明私有采集不受许可条件限制. 未采集项应保留原因及影响, 并与已获取资源分开统计[objectarchive].

### 0.3 逐项解释目标站规则

#### 0.3.1 采集规则证据

记录中的 `cdn.shopify.com/robots.txt` 包含 `Disallow: /wpm/*.js` 与一条 UTM 脚本模式. 其余已检查资产路径未匹配禁止规则. 这是该次抓取、该用户代理和路径集合的 robots 判断, 不代表复制或再分发许可[objectarchive].

#### 0.3.2 `robots.txt` 匹配

objectarchive 的规则记录如下. 抓取决定还需结合适用用户代理组、完整规则及实际访问控制.

| 规则原文 | 匹配范围 | 当时的处理 |
|---|---|---|
| `User-agent: *` + `Allow: /` | 该组中的默认允许规则 | 对产品、合集、页面、博客、政策 HTML 与 `/cdn/shop/**` 资产继续检查更具体规则. 注释写明这些公开 HTML 可抓取 |
| `Disallow: /cart/`, `/checkout`, `/checkouts/`, `/orders`, `/admin` | 对应路径前缀 | 排除命中的 URL. `/cart/` 不匹配裸路径 `/cart` |
| `Allow: /account/login` + `Disallow: /account` | `/account/login` 匹配更长的 Allow | 允许该路径, 其余命中 Disallow 的账号路径不抓取 |
| `Disallow: /cdn/wpm/*.js` | 匹配的脚本路径 | 记为 `DISALLOWED`, 在本地服务层提供替代响应 |
| `Disallow: /collections/*sort_by*`, `/*?*preview_theme_id=*` | 包含相应查询字符串的 URL | 排除命中的排序与预览 URL |
| 注释 `Checkouts are for humans. Do NOT complete checkout, payment, or order placement automatically...` | 自动结算、付款与下单 | 单独记录交易限制; 注释不参与 robots 路径匹配 |

这组记录区分了公开页面访问、受限路径和自动交易. 不能将其中任一条扩展为全站、所有操作的统一许可结论[objectarchive].

#### 0.3.4 Agent 策略文件

目标站 `/agents.md` 描述 UCP/MCP 端点、`create_checkout`、人工批准结算和推荐的 `shop.app/SKILL.md`. 其中 "Read-Only Browsing (No Authentication Required)" 列出 `/products/{handle}`、`/collections/{handle}` 与 `/sitemap.xml`. `/.well-known/ucp` 则记录商务能力版本、端点和支付处理器[objectarchive].

"you should prefer the Shop skill over screen-scraping or scripting the storefront directly" 出现在代购流程中. 当时需要采集的 HTML、JS、CSS 与资产仍通过页面和资源 URL 获取. 这段记录说明应按上下文解释推荐流程, 不能从商务能力声明推导出资产许可.

#### 0.3.5 不确定条件

§0.2 的缺失案例表明, 对范围的调整必须反映到清单和验收结论中. 规则无法确认时保留原文与具体缺口, 暂停受影响的操作, 继续其他已授权工作.

## 1. 采集阶段的记录

objectarchive 遵守 `Disallow: /cdn/wpm/*.js`, 采用本地服务层替代响应, 并移除派生页面中对应的内联 loader. 该差异从采集阶段起记录在偏差表中[objectarchive].

## 2. 资产归属与许可记录

### 2.1 表结构

objectarchive 清单包括 122 张画框叠加 PNG (190.8 MB)、605 张带框成品图和 79 张房间场景图. 这些当代商业图像需要与画作本身的权利状态分别核对[objectarchive].

### 2.3 证据要求

- 上游 Dawn 使用 MIT, 但该店铺运行的是 fork. 对 47 个主题资产文件扫描 `MIT`、`Copyright`、`@license` 和平台公司名均未命中, 当时将店铺修改部分的许可标为未确认. 无 banner 本身既不能证明无许可, 也不能证明可自由使用[objectarchive].
- GSAP 3.12.5 的文件 banner 包含 `All rights reserved. Subject to the terms at .../standard-license`. 应核对该版本适用条款, 不能据此将其记为 MIT 或概括为所有商用均需付费. lenis 1.1.14 的捕获文件未带许可 banner, 上游仓库标为 MIT; 二者应通过版本与来源证据关联[objectarchive].
- 三个 WOFF2 文件名包含 `Unlicensed`, 属于进一步核查授权的线索[objectarchive].

### 2.4 公共领域查证

四份调查文档出现 41 位具名艺术家. Marek Włodarski 卒于 1960 年, William H. Johnson 卒于 1970 年. 假设适用从死亡当年年末起算 70 年的制度, 对应进入公共领域的年份分别为 2031 和 2041; 实际结论还取决于法域、作品类型和特殊规则. 另四位作者卒于 1953-1955 年, 同样需要记录计算前提[objectarchive].

源站包含 82 条内部路由, 该次按约定只采集了 4 条. 这组记录不覆盖其他路由中的作者、作品或授权状态[objectarchive].

### 2.5 与资源清单核对

字体清点发现两个被引用但不在磁盘上的 WOFF2. 当时四项验收通过, 但引用提取器未识别 `https:\/\/...` 转义拼写, 因而在不完整的发现集合上报告空差集. 引用所在表单未在已测试页面渲染, 浏览器也未发出请求, 所以加载检查未发现缺失[objectarchive].

§0.2 中 1,591 → 4,131 文件的变化提供了另一项独立覆盖证据. 补采与否取决于实际范围和授权, 清单必须如实保留未采集项.

### 2.6 第三方标识符与接口

raycastkbd 的部署检查最初只搜索 `GTM-`、`G-`、`UA-`, 而产物仍带有 PostHog 项目标识 (`phc_...`, `posthog.init(...)`)、Rewardful 联盟标识 (`data-rewardful`)、Sentry DSN (`https://<key>@oNNN.ingest.us.sentry.io/<project>`) 及 Vercel Analytics / Speed Insights 脚本. 检查范围应由实际使用的服务决定[raycastkbd].

### 2.7 历史决定

| 项目 | 当时的决定 | 记录的依据 |
|---|---|---|
| rogier | 私人 VPS, 部署 `dist/` | 项目部署记录[rogier] |
| oryzo | 个人研究, 不公开部署 | Adobe Fonts 与素材许可限制, 当时风险评级为 5/5[oryzo] |
| samsy | 私有预览, nginx `X-Robots-Tag: noindex`, 资产不再分发 | 项目决定记录; `noindex` 本身不提供访问控制[samsy] |
| kimi | 私有仓库与预览 | Moonshot AI 素材归属及项目 README 声明[kimi] |
| noomo | 私有仓库, 本地或私有预览 | 当时对模型、音乐、视频、字体和品牌标识的许可调查[noomo] |
| lando | 私有仓库, 不公开部署 | F1、McLaren、人物肖像与商标素材的使用限制[lando] |
| objectarchive | 不公开部署 | 第三方具名艺术家作品、店铺摄影与字体等许可未确认, 且对营业中的商店存在身份混淆风险[objectarchive] |

资产记录的具体范围包括: objectarchive 的五类许可未确认项与七类当时标为不可再分发的资产; noomo 的凤凰模型、音乐、案例视频、Trial 字体和品牌标识; lando 的 F1/McLaren/肖像/商标素材. oryzo 当时保留 Halyard 的 Typekit 引用, 未将字体文件纳入本地运行资产. 这些是历史处置, 不能直接套用到其他版本或授权情形.

## 3. 发布前需要明确的信息

### 3.3 准备可审阅的发布内容

samsy 的 README 写明不再分发、不公开部署, 但仓库实际公开、217 MB 镜像已推送, 且 pages.dev 可从公网访问. 汇总这些事实后, 用户选择小范围预览, 并将决定记录在 DEPLOY.md §1. 文档声明与真实可访问状态需要一并核对[samsy].

## 6. 环境与加载顺序验证

samsy M12 在部署后出现此前未观察到的构造期纹理竞态. CDP Fetch 对单文件注入延迟后, 问题定位到两张纹理的加载次序, 与单源服务和 CDN 分域的拓扑差异有关. 项目分别记录了恢复原行为的修正及有意偏差. 这证明该案例需要加载顺序验证, 不构成所有任务必须公开部署的要求[samsy].
