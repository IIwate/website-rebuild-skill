# Shopify 平台层剥离（B 类场景）

> **何时加载本文件**：Step 0 判级为 **B** 且指纹命中 Shopify（HTML 里 `cdn/shop`、`Shopify.theme = {...}`、`cdn.shopify.com`、`window.Shopify`、`myshopify.com`）时——在 M0 镜像动工前读完 §0/§3，在 M2 写构建/服务脚本时按 §1/§2 逐条对账。

## 0. 分层模型（本指南的组织逻辑）

一个 Shopify 店铺的产物必须拆成三层看，**三层的复刻策略完全不同**，混作一团是 B 类最常见的失控源：

| 层 | 归属 | 各店是否相同 | 复刻策略 |
|---|---|---|---|
| **平台层** | Shopify 厂商 | **相同**（版本漂移，形态不变） | 按 §1 清单**剥离**：加载期脚本换 no-op stub、运行期端点服务层 stub。本层是不变量，本指南给确定规格 |
| **主题层** | 店铺自己 | **各店不同** | 签名交互全部住这里。按 A 类手法**逐字移植**（`porting-discipline.md` + `dom-shell-strategies.md` 策略 A）。形态变量见 §4 |
| **应用层** | 店家装的第三方 App | **各店不同** | 逐个甄别，三分处置（见 §0.1） |

判层的机械判据（对每个 `<script src>` / 每条网络请求执行）：

- 路径含 `/cdn/shopifycloud/`、`/.well-known/shopify/`、`/checkouts/`、`/cart/*.js`、`/shopify_pay/`、`cdn.shopify.com/storefront/`、`shop.app`、`monorail-edge.shopifysvc.com` → **平台层**。
- 路径形如 `/cdn/shop/t/<主题号>/assets/*` → **主题层**（`racing.shop` 是 `t/17`、allbirds `t/4159`、pangram `t/52`、simply-chocolate `t/126`、mana `t/18`）。
- 路径形如 `cdn.shopify.com/extensions/<uuid>/<app>-<ver>/assets/*`，或指向第三方域（klaviyo / weglot / wunderkind / stape …）→ **应用层**。

### 0.1 应用层三分处置

| 类型 | 例 | 处置 |
|---|---|---|
| 改变视觉/内容 | Weglot 运行时翻译文案【probe】、rimix-product-badges 徽章【probe】、shoplift A/B（上传了主题在用的 GTStandard 字体）【racingshop】 | **必须复刻**：镜像其产物，且对拍前固定其状态（否则出文案级伪差异）【probe】 |
| 纯遥测/营销 | Klaviyo、stape、gtag、wunderkind-api【probe】 | stub 并登记为偏差（同 D5 一族） |
| 后端依赖型 | 年龄验证 avp-age-verification【probe】、hCaptcha 表单保护【racingshop】 | 资产照抄入库；其后端调用按 §1 服务层 stub |

---

## 1. 平台层清单（实测确定规格）

以下两张表逐条来自 `racingshop-rebuild` 的 `scripts/serve-rebuild.mjs` 与 `scripts/build-site.mjs` 实际代码 + 镜像 HTML 取证【racingshop】。**先照此表建 stub，再用探针反查你的目标是否有表外项**。

### 1.1 运行期端点（服务层 stub，`serve-rebuild.mjs` 的 STUBS 表，首个命中生效）

| 端点 / 前缀 | 作用 | 处置 | 依据 |
|---|---|---|---|
| `/.well-known/shopify/monorail/**`（实见 `unstable/produce_batch`） | web-pixels-manager 的同源遥测批量上报口（HTML 内联配置 `monorailEndpoint`） | 服务层 200 `{}` | D5 |
| `/api/collect` | `shopify-perf-kit-3.8.0` 的 RUM beacon 口（脚本属性 `data-shs-beacon-endpoint`），sendBeacon + fetch 双通道 | 服务层 200 `{}` | D5；allbirds 亦见此端点【probe】 |
| 路径含 `web-pixels` 或 `/wpm@` | Web Pixels manager 沙箱与 loader | 200 `export {};`（JS） | D5 |
| `/cdn/shopifycloud/shop-js/**` | shop-js loader 及其运行时 chunk 图。loader 文件内静态列出 `./chunk.*.esm.js` 约 37 个 + `client.*.esm.js`；HTML 的 `window.Shopify.featureAssets['shop-js']` 声明 **22 个 feature**（cart-sync、follow-button、login、toast-manager、avatar、windoid、fed-cm、cash-offers、checkout-modal、pay-button、payment-terms、lead-capture、user-recognition、customer-accounts…） | 整前缀 200 `export {};` | D6 |
| `/cdn/shopifycloud/storefront/assets/storefront/{load_feature,event_observer_reporter}*` | 特性加载器与其动态 import 的遥测 reporter chunk | 200 `export {};` | D5 |
| `/cart.js` | Ajax Cart 读取（theme.js L1122 / L2237） | 200 空车 JSON | D2 |
| `/cart/{add,update,change,clear}(.js)?` | 加购 / 改量 / 清空（theme.js add L2199·L2222、change L1248·L1275、update L1165·L1230·L1377） | 200 空车 JSON | D2 |
| `/search/suggest*` | predictive-search（theme.js L3003 拼 `${Shopify.routes.root}search/suggest?q=…&section_id=predictive-search`） | 200 —— **形状须核，见坑 2** | D4 |
| `/recommendations/products*` | product-recommendations（theme.js L4357-4364） | 200 空 section —— **形状须核，见坑 2** | D2 |
| `/cdn/shopifycloud/portable-wallets/**` | Shop Pay 加速结算按钮资源 | 200 空 `<svg/>` | D3 |
| `/cdn/shopifycloud/checkout-web/**` | 结算 web 运行时 | 200 `export {};` | D3 |
| `/shopify_pay/**`（含 `accelerated_checkout`） | Shop Pay 会话 / 钱包 | 200 `{}` | D3 |
| `/checkouts/**`（含 `internal/preloads.js`） | 结算流程 | 200 `export {};` | D3 |
| `/cdn-shopify/storefront/web-components/account/**` | 客户账号 web components 懒加载 chunk | 200 `export {};` | D6 |
| 未命中任何静态文件 | —— | 回落 `404.html` 且**真返回 HTTP 404**（复刻 Shopify 语义，不要 200） | —— |

空车 JSON 用 Shopify Cart 对象的完整字段形状（`token/note/attributes/original_total_price/total_price/total_discount/total_weight/item_count/items/requires_shipping/currency/items_subtotal_price`），不要只回 `{}`——调用方会读字段。

### 1.2 加载期 `<script src>`（构建层换 no-op stub，`build-site.mjs` 的 STUB_SCRIPTS）

按**改写后**的 src 做子串匹配，命中则整个 `<script>` 标签替换为 `/stubs/noop.js` 并保留 `type="module"`（保住 importmap / 模块图合法）：

`/cdn/shopifycloud/shop-js/`（D6）· `/cdn/shopifycloud/storefront/assets/shopify_pay/`（D3）· `/cdn/shopifycloud/storefront/assets/storefront/load_feature`（D5）· `/checkouts/internal/preloads.js`（D3）· `/cdn-shopify/storefront/web-components/account.js`（D6）· `googletagmanager.com/gtag/js`（D5，外部）· `shop.app/checkouts/internal/preloads.js`（D6，外部）。

### 1.3 **不要**一并 stub 的平台脚本（verbatim 保留清单）

过度 stub 会改变 DOM 与时序，本身就是未登记偏差。racingshop 显式留下且实测无害的 11 项【racingshop】：

`theme.js`、`vendor.min.js`（主题层本体）· `importmap-polyfill/es-modules-shim.2.4.0.js` · `storefront/assets/storefront/origin_trials-*.js` · `cdn.shopify.com/storefront/standard-actions.js` · `shopifycloud/perf-kit/shopify-perf-kit-3.8.0.min.js`（beacon 由 §1.1 `/api/collect` 兜）· `shopifycloud/privacy-banner/storefront-banner.js` · `storefront/assets/shop_events_listener-*.js` · `storefront/assets/storefront/autosizes-*.js`（内联条件注入的 polyfill）· `storefront-forms-hcaptcha/*.iife.js`（内联 `captcha-bootstrap` 注入）· `cdn/s/trekkie.storefront.<40hex>.min.js`（内联 analytics 块注入——**留着它反而更安全，见 §3**）。

---

## 2. 构建层登记变换清单

对每个镜像 HTML 只做**登记在案**的变换，其余逐字保留（策略 A）【lando】【racingshop】：

1. **D1a 同源绝对/协议相对 → 根相对**：`https://<host>/`、`http://<host>/`、`//<host>/` → `/`。**必须同时处理 JSON 转义形式** `https:\/\/<host>\/` → `\/`（内联 JSON-LD / 配置块里全是这种写法，漏了就留下真实外域引用）。
2. **D1b 外部 Shopify CDN → 本地目录**：`https://cdn.shopify.com/` 与 `//cdn.shopify.com/` → `/cdn-shopify/`（含转义形式），对应镜像的 `assets/cdn.shopify.com/` 树。
3. **D5b 内联遥测块移除**：按 `data-source-attribution="shopify.event_observer.bootstrap"` 属性、以及 `<script>(function(){var wpmLoader=` 起始字面量定位删除。这两块是纯分析、无视觉/行为角色；wpmLoader 在其后端模块被 stub 后还会 `.init` on undefined 抛错，不删则污染 CLEAN 门。
4. **D3/D5/D6 脚本 stub**：§1.2 清单。
5. **SRI 剥离**：被改写的标签响应字节已变，`integrity="..."` 必须去掉——否则 Chrome **静默拦截**该资源，且报错只走 CDP Log 域，探针不监听 Log 就会误报 CLEAN【lando】。
6. **D8 注入 noindex + 非官方声明**：`<head>` 后立刻插 `<meta name="robots" content="noindex,nofollow">` 与一段声明注释（"非官方学习复刻 / 与 Shopify Inc. 及店主无关 / 不得公开部署"）。版权红线，不可省。
7. **Q1 dev-port 探测片段 verbatim 保留**：见 §5。

**"零变换即 throw"防御（硬规则）**：`applyTransforms` 统计变换次数，`n === 0` 或产物与输入相同 → 直接抛错终止构建【lando】【racingshop】。意义：镜像/主题结构一变（换主题、Shopify 改 head 契约），脚本会**立刻大声失败**，而不是静默产出一批引用真实外域、没有 noindex 的坏 shells。没有这道防御的生成脚本不许合入。

---

## 3. 零外联的完整断言面（本次实测发现的门盲区）

**`零外联` 不等于"资源级探针没抓到外部请求"。** racingshop 的全页型 probe 报告零外联、零缺失资产，但构建产物里实际残留三类联网面【racingshop】：

**① 连接意图（无资源请求，探针天然抓不到）** —— 实测残留两条：

```html
<link rel="preconnect" href="https://shop.app" crossorigin="anonymous">
<link href="https://monorail-edge.shopifysvc.com" rel="dns-prefetch">
```

浏览器一联网就会为这两条做 DNS 解析 / TLS 握手。资源级探针只看 `Network.requestWillBeSent`，完全看不见。→ **必须清理并登记，或至少登记为已知潜伏。**

**② 内联自包含遥测块（潜伏 beacon）** —— 每页内联着两处打外部域的代码：

- **弃单 beacon**：`pagehide` 监听器 → `navigator.sendBeacon("https://monorail-edge.shopifysvc.com/v1/produce", {schema_id:"online_store_buyer_site_abandonment/1.1", …})`。它自带 guard「performance 条目里没有 monorail 记录才发」——**离线复刻恰好满足该条件，所以是必发不是可能发**。load-time 探针从不触发 `pagehide`，一次都抓不到。
- **trekkie 加载失败兜底**：内联的完整 Monorail 实现（`Monorail.produce(monorailDomain, schemaId, payload)` → sendBeacon → XHR 兜底），挂在 `script.onerror → scriptFallback.onerror` 路径上，上报 `trekkie_storefront_load_errors/1.1` 到 `monorail-edge.shopifysvc.com`。trekkie 文件在盘时不触发；**被广告拦截器按文件名 `trekkie.storefront.*` 拦掉时会触发**——这正是"§1.3 建议把 trekkie 文件留在盘上"的理由，也是它必须登记为潜伏外联的理由。

**③ 出站 `<a href>` 锚点** —— 如页脚的 `https://www.shopify.com/legal/privacy`。这是**源站内容**，按宪法第 3 条（源站有的都要有）**保留，不算外联**。断言脚本必须按元素类型判定，不能"字符串里含外部域即红"，否则会逼出删内容的错误修法。

**因此零外联门的断言面 = 四项，缺一不可：**

- [ ] **资源级**：全路由 × 桌面/移动，probe 记录的请求 host 只有本地；带 `--scroll` 走完懒加载。
- [ ] **静态 grep 级**（对构建产物，不是对镜像）：`rel="preconnect"|rel="dns-prefetch"|rel="preload".*//` 无外部域；`sendBeacon\(|new Image\(|fetch\(["'`]https` 无外部字面量；残存 `https?://` 白名单只剩命名空间（schema.org / w3.org / json-schema.org）与出站锚点，逐条点名。
- [ ] **交互 / 生命周期态**：探针内 `window.dispatchEvent(new Event('pagehide'))`（或真导航离开）后再采一次网络；另外打开 cart drawer、在搜索框输入、进商品页触发 recommendations。
- [ ] **拦截器模拟**：把 trekkie（及其他"在盘才安全"的脚本）临时改名/返回 404，确认不触发外联；不可消除的写进偏差表"已知潜伏"。

---

## 4. 主题层变量矩阵（已观察形态，非确定规格）

> **置信度声明**：§1 平台层是**实测确定规格**（同一套 Shopify 运行时，各店一致）。本节是**已观察形态的样本集**，不是穷举——Shopify 主题生态没有上界。遇到表外形态：现场按 §4.1 判据核验，处置完成后**回填本表**。

| 目标 | 主题（`schema_name` / 版本） | 前端栈 | 出处 |
|---|---|---|---|
| racing.shop | **Stretch 1.13.0**，主题商店 #1765，实例名 "V1 Launch 022626" | 原生 Web Components ×78（`class extends HTMLElement` ×71、IntersectionObserver ×13）+ `vendor.min.js` 72KB。**无** three / gsap / lenis / react / vue | 【racingshop】 |
| allbirds | 未取 schema 名，主题号 `t/4159` | **ESM + Vite**（bundle 头 `__vite__mapDeps`）+ **GSAP ScrollTrigger** + **Swiper**；section 粒度切分共 20 个脚本（header / cart-drawer-section / full-bleed-hero / category-row …） | 【probe】 |
| mana-yerba-mate | 定制主题（非 Dawn），`t/18` | 单 bundle `global.js` **1.16MB**：**three.js 整库内联**（`THREE`×203、自写 shader）+ **GSAP**（×322）+ **lottie-web** + Swiper；Weglot 运行时翻译 | 【probe】 |
| pangram-pangram | 定制主题 `pp.com` 3.0.0，**`theme_store_id: null`** | **Alpine.js**（`x-data` 组件 40+：customFont / parallax / carousel / tabs）+ **Swiper**，Vite 单 bundle `index-<hash>.js` 488KB。无 gsap/three/react/vue | 【probe】 |
| simply-chocolate | **Prestige 10.11.0**（Maestrooo 商业主题），`t/126` | Web Components（effect-carousel / scroll-carousel / marquee-text / cart-*，esbuild 产物）+ PhotoSwipe 5.4.4 / focus-trap / tabbable。**动画库指纹为 0**。`theme.js.map` **公网可取** | 【probe】 |
| ch.maswitzerland | **Dawn**（Shopify 官方开源） | Dawn 全家桶 16 脚本：`global.js` / `cart-drawer.js` / `predictive-search.js` / `pubsub.js` / `quantity-popover.js` / `animations.js` … 带 sourceMappingURL | 【probe】 |
| koox.co.uk | **Ella 6.5.4**（商业主题） | 未取样 | 【probe】 |

**读法**：`theme_store_id: null` = 为该站定制开发的主题（创意站常见，逆向价值最高）；命中官方/商业主题（Dawn、Prestige、Ella、Stretch）= 主题层不是店主原创，**逆向可能退化为读上游源码**，且引入主题版权问题——立项前就要向用户讲清。

### 4.1 现场判定序列（按顺序执行，四步定型）

1. **取主题身份**：从 HTML 抠 `Shopify.theme = {...}`，读 `schema_name` / `schema_version` / `theme_store_id`（null=定制）/ 实例 `name`（运营迭代痕迹）。
2. **列主题资产**：`/cdn/shop/t/<N>/assets/` 下所有 js/css 全量下载；同时看是"单 bundle"还是"section 粒度多脚本"——这决定 M1 的坐标系粒度。
3. **栈判定 grep 序列**（对下载的 bundle）：`customElements.define|class extends HTMLElement`（Web Components）· `x-data=|alpine:init|\$persist`（Alpine）· `gsap|ScrollTrigger|GreenSock`（GSAP）· `THREE|WebGLRenderer|gl_FragColor`（three + 自写 shader）· `Swiper|swiper` · `lottie|bodymovin` · `__vite__mapDeps`（Vite 分块）· `sourceMappingURL`。
4. **抄近路检查**：有 sourcemap 就先 curl `.map` 验证可取（simply-chocolate 的 432KB map 带完整 `sourcesContent`）；是 Dawn 就直接读 `github.com/Shopify/dawn`——这两种情况下 M1 的 beautify 环节近乎免费。

---

## 5. localhost 语义分叉（Shopify 主题的 dev 逃生门）

Shopify 主题（尤其 Vite 工作流的定制主题）常在页面尾部内联按 host 分叉的 dev 探测。racing.shop 每页至少 1 处（首页 2 处：carousel-3d 与 pixel-footer），实测原文【racingshop】：

```js
if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') {
  const ports = [5173, 5174, 5175];            // 另一块是 [5176, 5177]
  (async () => {
    for (const port of ports) { try { await import(`http://localhost:${port}/src/main.ts`); return; } catch {} }
    console.warn('[Carousel3D] Vite dev server not found, falling back to asset');
    import('//<host>/cdn/shop/t/17/assets/carousel-3d.js?v=…');
  })();
} else {
  import('//<host>/cdn/shop/t/17/assets/carousel-3d.js?v=…');   // 与上面回落路径同一个文件
}
```

复刻工程本地跑 = hostname 就是 localhost → **被迫走进一条线上永不执行的分支**。两条路线，**都必须登记**：

| 路线 | 做法 | 代价 | 适用条件 |
|---|---|---|---|
| **保持 verbatim**（默认，racingshop 选此 = Q1） | 一字不改，登记进 §Q 怪癖表 | 每页产生 2-5 个 `ERR_CONNECTION_REFUSED` 到 localhost dev 端口 + `console.warn` 噪声；**probe 的 `Network.loadingFailed` 会计入 failures，CLEAN 门必须为其开白名单并写明理由**，此后该门的信噪比永久下降 | 追求字节级忠实；且已确认探测**无外联**（目标是 localhost，不出机器）、无副作用、不阻塞渲染 |
| **强制走 production 分支** | 改写条件使其恒 false | 属**自创改动**，违反"源站有的都要有"的字面纪律，必须登记进 §6 偏差表并写"何时重新考虑" | 噪声污染验收门到无法判读；或探测有真实副作用（打外部域、抛错、阻塞首屏） |

**Shopify 特有的成本判据**：注意上面两条分支**最终 import 的是同一个主题资产**——dev 分支只是多了一段探测前奏。这意味着强制走 production 的**行为后果为零**，代价纯粹是"多了一条自创改动记录"。所以这里的取舍是纪律取舍，不是功能取舍：默认仍选 verbatim（无副作用 → 一律不动），只有当 CLEAN 门被噪声淹没时才翻。**绝不允许直接删掉分支而不登记**——那是未登记偏差 = bug。通用规则见 `dom-shell-strategies.md` §4.5。

---

## 6. 常见坑

1. **内联遥测比 `<script src>` 难删，且极易漏**：src 能按 URL 前缀批量 stub，内联块只能按 `data-source-attribution` 属性或唯一起始字面量正则定位。racingshop 删了 2 块（event_observer.bootstrap、wpmLoader），**漏了 analytics/trekkie 块与 pagehide 弃单块**（§3②）。做法：先枚举全部无 src 的 `<script>`（racing.shop 首页 **38 个**），逐个分类为"配置 / 结构化数据 / 主题逻辑 / 遥测"，再删——不要凭印象删。
2. **stub 的响应形状必须按调用方的解析路径确定，不是"回 200 就行"**。racingshop 实测两处形状不匹配：`/recommendations/products` 回 `<div class="product-recommendations">`，而 theme.js L4364 用 `querySelector("product-recommendations")`（**标签名**）→ null → 读 `.childElementCount` 抛错；`/search/suggest` 回 JSON，而 theme.js L3003 走 `DOMParser` + `querySelector(".shopify-section")` → null → `importNode(null)` 抛错。**这类错只在交互态出现，load-time 探针全绿**——所以 §3 的交互态断言不是可选项。写 stub 前先去 bundle 里读一遍调用方怎么解析响应。
3. **no-op stub 必须同时是合法的 classic script 与 module**：racingshop 曾用 `export {}` 导致 classic script SyntaxError，改为纯注释文件才对。硬规则与判定方法见 `porting-discipline.md` §6.1。
4. **协议相对 URL 会被爬虫拼错**：`//<host>/x` 被误拼成 `https://<host>//<host>/x`，racingshop M0 因此产生 77 个假 404。修法是**旁路 gapfill 归一重解**（确认 76 个真实路径已在盘、1 个是目录基址属预期 404），**不要改共享爬虫脚本**。
5. **HLS 视频阶梯是静态爬取的盲区**：`.m3u8` 的 renditions 与 segments 不在 HTML 里，只有运行时才拉取——需单独补录（racingshop 补 3 renditions + 12 segments）。
6. **nonce 类字节不是内容差异，别判 D**：`<meta name="shopify-y">` 每请求变 UUID（racingshop、simply-chocolate 均实测），`__st` 里的 `reqid` / 用户 token `u` 也逐请求变（koox 实测）【probe】。冻结镜像值 + 对拍掩码即可。
7. **`section_id` 查询参数请求会命中静态页的假 200**：facets-form 发 `/collections/x?section_id=…` 期待 section 片段，静态服务器忽略 query 返回整页——**200 但内容错，探针不报错**。要么在服务层为带 `section_id` 的请求单独 stub，要么登记为已知降级。
8. **过度 stub 平台脚本**：perf-kit / privacy-banner / hcaptcha / origin_trials / standard-actions / es-modules-shim 该留则留（§1.3）。一律 stub 会改变 DOM 与加载时序，本身即未登记偏差。
9. **后端 stub 区的像素差是预期噪声，别用自创 CSS 去补**：racingshop 静态页对拍 FAQ 99% / Terms 96.9%，worstCell 精确落在 header 的账号头像（`shopify-account` 由被 stub 的 `account.js` 渲染）。归因到 stub 就结案，动 CSS 就是发明。

---

## 7. 关账 checklist（B 类 Shopify 平台层）

- [ ] 三层已分清：每个 `<script src>` 与每条运行时请求都归了平台 / 主题 / 应用层（§0 判据），应用层每项有三分处置结论
- [ ] §1.1 运行期端点逐条有 stub 或"确认本站无此端点"的记录；空车 JSON 用完整字段形状
- [ ] §1.2 加载期脚本逐条换 no-op stub，`type="module"` 保留；stub 文件双模式合法（`porting-discipline.md` §6.1）
- [ ] §1.3 verbatim 保留清单逐条核对过，无过度 stub
- [ ] 构建层变换 = 偏差表条目数（D1a/D1b/D5b/D3·D5·D6/SRI/D8），一一对应；**"零变换即 throw"防御在位**
- [ ] 内联 `<script>` 已逐个分类，遥测块处置有据（删 / 留 / 登记为潜伏）
- [ ] **零外联四项断言全绿**（§3）：资源级 / 静态 grep 级 / 交互与 pagehide 态 / 拦截器模拟；出站锚点已点名豁免
- [ ] 交互态无控制台异常：cart drawer、predictive-search 输入、product recommendations 均实跑过（坑 2）
- [ ] noindex + 非官方复刻声明在**每一页**产物中（不只是首页）
- [ ] localhost 分叉的路线已选定并登记（Q 表或 D 表），CLEAN 门白名单写明理由
- [ ] 主题层身份钉死进 `docs/engine-notes.md`：`schema_name` / 版本 / `theme_store_id` / 主题资产目录 / 栈判定 grep 结果；**若为 §4 表外新形态，已回填本文件 §4 矩阵**
