# archival-rescue.md — X 类抢救:从 Wayback Machine 重建死站

X 类(原站已消失)占历年获奖站约 29%。站死了,但 Internet Archive 里往往躺着捕获——
本指南把它们变成**标准镜像**:`scripts/wayback-mirror.mjs` 产出与 `mirror-site.mjs` 同构的
`mirror/` + 账本,下游全部门(verify-mirror / serve / sweep / 外壳 / 对拍自比)原样工作。

## 0. 三个决定,缺一个产出就是汤不是证据

1. ⭐ **只取原始字节**:一切抓取走 `id_`(identity)回放旗——
   `https://web.archive.org/web/<ts>id_/<原URL>` 返回捕获的原始字节,无改写、无工具条。
   **永远不要镜像回放 HTML**(它被注入了 archive 的脚本与 URL 改写,是另一个站)。
2. ⭐ **一个连贯的时刻**:`--anchor`(默认 auto:根页 200 捕获最密的年代取中位)+
   `--window-days` 逐 URL 选窗口内离锚点最近的 200 捕获。**从任意年代乱缝的镜像是一个
   从未存在过的站**;抢注者时代的 301 洪水(实测某死站 CDX 里 2025 年垃圾与 2020 年真身
   同列)靠状态码 + 窗口天然出局。
3. ⛔ **洞是既成事实,只能诚实记账**:活站的闭包门要求 ∅、补爬可以填洞;死站的洞
   **永远补不回来**。`mirror/wayback-holes.txt` 逐条登记(URL + 引用者),它同时就是
   `verify-mirror --allow-missing` 的清单——门对**已登记**的洞保持绿,对未登记的照红。
   账即交付物的一部分。

## 1. 别名回填:档案可能用另一个名字认识这个洞

实测:站点用缓存穿透前缀引用资产(`/version/<ts>/js/menu.svg`),该拼写从未被捕获——
而 `/menu.svg` 在窗口内有 200 捕获。`wayback-mirror` 对每个洞做一次 CDX 同名(basename
精确匹配)查询,窗口内命中则抓取并**存到被引用的路径**上,让引用得以解析。

⛔ **别名回填是推断,不是捕获**:"同名异路 ⇒ 同一文件"可能错(同名不同文件存在)。
所以它在 `wayback-holes.txt` 里单列 **FILLED BY ALIAS** 段(referencedAs ⇐ archivedAs
@timestamp),provenance 记 `aliasOf`,**逐个目验**,永不冒充原路径的真捕获。

## 2. 礼貌是功能

web.archive.org 对高频访问限流(429/503)。默认 2 worker + 350ms 间隔 + 指数退避;
**抢救不是竞速**——档案馆是公共资源,一次被封整跑作废。CDX 枚举也要间隔。

## 3. 死站特有的门语义

- **抽样回源(--resample)无意义**:没有源可回。真实性(AUTHENTICITY)检查**照跑且更重要**
  ——archive 存的是当年爬虫看见的任何东西,**被存档的挑战页/拦截页是真实存在的危险**
  (魔数对声明类型、拦截正文模式,全部照常)。
- **provenance 取代"源站说的"**:`mirror/wayback-provenance.json`(锚点、窗口、逐文件
  捕获时间戳 + CDX digest)是死站复刻的坐标系;逆向笔记引用它,不引用不存在的源站。
- **救不回来的,登记**:从未捕获的运行时 API 响应、档案外的第三方 CDN(off-host census
  会点名,逐主机决策——死站的 CDN 可能也死了,也可能活着还能直抓)、POST 端点。
  与活站同一条纪律:不抓只能有技术性理由,一律登记。

## 4. 版权:站亡,权利不亡

站点下线**不改变**其内容的版权状态——作者/公司的权利在站死后继续存在。
抢救产物照旧:私有 + noindex + 不部署,逐资产取证,决定呈交用户
(`legal-and-deploy.md` 全套适用)。存档价值(防止创作永远消失)与再分发权是两件事。

## 5. 流程(与活站的差异点)

```
Step 0   判 X 类(域名易主/回收/路径移除/原地替换)→ CDX 覆盖侦察(有几条?哪些年代?)
M0       wayback-mirror(anchor auto → 人工确认年代合理)→ verify-mirror --allow-missing mirror/wayback-holes.txt
M0.5     serve + sweep-routes 照常(断网门语义不变:回放伺服的是本地字节)
M1+      逆向/外壳/对拍自比/源码化,全部标准 —— 参照系是镜像自身与 provenance
交付     DEPLOY.md 增加「存档抢救」一节:锚点、窗口、洞的账、别名回填清单
```
