# scripts/ — 零依赖工具脚本

全部为零依赖 Node 脚本（Node 22+ 内置 fetch / WebSocket 直连 CDP，不装任何 npm 包）——六项目一致的工具哲学："避免工具链自身版本漂移污染比对"。站点相关常量已提升为 CLI 参数或文件顶部 CONFIG 块（各文件头部有用法示例与传承注释）。

| 脚本 | 用途 | 典型用法 | 出处 | 成熟度 |
|---|---|---|---|---|
| `mirror-site.mjs` | BFS 爬虫镜像源站（页面/跨域资产/manifest，文本资产迭代到不动点；对要求同源 Referer 的资产域补齐 Referer 头、404 模板探测） | `node mirror-site.mjs --origin https://example.com --hosts cdn.x.com --probe-404 /no-such-page` | lando 版（rogier→noomo→lando 三代传承） | 高 |
| `netcapture.mjs` | 真实浏览器 CDP 抓包，记录实际同源请求与磁盘镜像 diff 对账（HAVE/GAP），补运行时拼接 URL | `node netcapture.mjs --origin https://example.com --routes /,/about --fetch` | kimi 版 | 高 |
| `serve.mjs` | 零依赖静态服务器：MIME 补全、Range、redirects.tsv 重定向回放、`/ext/<host>/` 服务层改写（镜像磁盘神圣不改）、`?__probe` 注入 probe-shim、404.html 回放 | `PORT=5175 SERVE_ROOT=legacy-mirror node serve.mjs` | noomo+lando 合并版（samsy→kimi→noomo→lando 四代传承；kimi 的 RSC 层需按项目自加） | 高 |
| `probe.mjs` | CDP 无头探针：console/异常/网络采集 + Log 域监听（SRI 拦截盲区修复）、`--eval/--evalAfter/--shot/--mobile`、CLEAN 判定退出码进 CI | `node probe.mjs http://localhost:5175/ --shot out.png --eval "document.title"` | lando 版（rogier 探针家族→samsy regression→lando） | 高 |
| `verify-routes.mjs` | 路由/重定向/head 契约门：head+`<main>` 全属性逐字段对镜像比、重定向断言状态码本身 | 编辑文件顶部 CONFIG 后 `node verify-routes.mjs` | kimi 版 | 高（CONFIG 需按项目填写） |
| `verify-ssr.mjs` | SSR 逐字节门：body DOM / 数据 payload / config / 序列化顺序四项对镜像 byte-equal（buildId 掩码） | `PORT=3100 node verify-ssr.mjs`（页面可自动发现） | noomo 版 | 高（提取器为 Nuxt 专用，换框架需替换） |
| `pixelcompare.mjs` | 双服务器 A/B 截图 + 64×40 网格量化（适合活体场景）+ 并排合成图 + metric.json；`--max-mean` 可作门 | `node pixelcompare.mjs --a http://localhost:5173/ --b http://localhost:5175/ --name home` | samsy 版为主 | 高（驱动到特定状态的逻辑属调用方） |
| `side-by-side.mjs` | 消费门产出的 mirror-/rebuild- PNG 对，合成 [镜像\|重建\|8× 差异热力图] + 汇总表 | `node side-by-side.mjs --dir docs` | kimi 版 | 高 |
| `probe-shim.js` | 约 90 行确定性驱动 shim：接管 rAF/timer/visibility，`__pump(dt,frames)` 手动泵帧，双侧同位注入（serve.mjs `?__probe` 自动注入） | 由 serve.mjs 注入；探针侧调 `window.__pump(16.7, 60)` | noomo 版 | 高 |
| `dump-timelines.mjs` | 手写 GLB 解析器，动画曲线 dump 成 JSON 数值账本——"数值基准先行"范例（先 dump 源数据再移植再数值验收） | `node dump-timelines.mjs legacy-mirror/timelines/cam.glb` | noomo 版 | 中（GLB 专用，范式可泛化） |
| `beautify-bundle.mjs` | 薄封装：钉死 `js-beautify@1.15.1` 展开 bundle 到 `legacy-mirror/_pretty/` 并自动生成含再生成命令的 `_pretty/README.md`（版本漂移作废行号坐标系） | `node beautify-bundle.mjs legacy-mirror/assets/cdn.x.com/bundle.js` | 新写薄封装（oryzo 引入流程、samsy 钉版本、kimi/noomo/lando 统一 1.15.1） | 中（新写，未经项目实战） |
| `lib/png.mjs` | 零依赖 PNG 编解码 + 图像统计/比对（恒输出 RGBA——kimi M7.3 colorType 事故的防呆） | `import { decodePng, encodePng, compare, imageStats } from "./lib/png.mjs"` | kimi 版 | 高 |

## TODO（未打包的缺口，需要时去源项目手工移植）

- **verify-mirror.mjs**（镜像验收门：断网可渲染 + GAP=0 对账 + sha256 清单核验）——与站点资产清单耦合深，未通用化。移植自 `careers-kimi-rebuild/scripts/verify-mirror.mjs`。
- **extract-i18n.mjs**（括号配平 + 隔离 vm 求值抽取 bundle 内数据成 JSON，键集交叉校验）——抽取式移植范式，但解析逻辑绑定具体 bundle 结构。移植自 `careers-kimi-rebuild/scripts/extract-i18n.mjs`。
- **regression.mjs**（状态全遍历 CDP 回归：localStorage 预种、逐状态截图断言）——状态机定义站点专用，probe.mjs 已覆盖单页探测。移植自 `samsyninja-rebuild/scripts/regression.mjs`。
- **gen-shells.mjs / gen_components.py**（DOM 外壳生成：零重写流水线 vs 保守切组件）——策略绑定站点类型（见 dom-shell-strategies 分支），不宜做成单一通用脚本。移植自 `landonorris-rebuild/scripts/gen-shells.mjs` / oryzo 的 `gen_components.py`。
- **rogier 的 capture.mjs / analyze-home-bands.mjs**（行亮度剖面分析）——依赖 sharp，违反零依赖哲学，未纳入；等价能力可用 `lib/png.mjs` + 自写剖面重做。
- **kimi 确定性冻结协议（八协议表）**——是文档/协议不是脚本，应进 references/，不在本目录范围。
