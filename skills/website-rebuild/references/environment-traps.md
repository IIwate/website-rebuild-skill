# 环境陷阱手册

> **何时加载本文件**：进入验证阶段、编写任何无头探针/回归脚本之前；以及每次准备把"假死 / 时序异常 / 状态不一致 / 像素差异"判定为源码 bug 之前。先按本手册校准环境与探针，再动代码。

## 0. 总纪律：环境因素先取证再动代码

**任何"bug"在归因到源码之前，必须先排除环境与探针自身的嫌疑。**旧构建缓存、DNS 负缓存、构建窗口期 fetch 失败都会伪装成产品 bug——先取证（computed style、DoH、直连 IP），再动代码【rogier】。

反面案例（本手册存在的理由）：samsy 项目曾把"启动链冻结假死"误判为源码 bug 并做了错误"修复"，事后取证发现真凶是后台标签页 rAF 节流 + gsap `lagSmoothing`，撤销了那次修复【samsy】。**误判的代价不是浪费时间，而是引入一个偏离源站的假修复。**

配套惯例：探针超时要与产品缺陷显式区分——rogier 在真 GPU tier 3 机器上把探针等待调到 `PROBE_WAIT=25000/45000`，并明确标注 "probe timing, not a product mismatch"【rogier】。

---

## 1. 陷阱：后台标签节流伪装站点假死（发生率最高）

**现象**：页面在后台标签/无头环境里帧循环停摆、启动链走不完、动画不推进，看起来像站点死锁。gsap 的 `lagSmoothing` 会进一步放大伪装效果【samsy】。

**三个项目独立踩过**：
- oryzo：人肉盯屏验收不可靠，这是引入无头浏览器回归的直接起因【oryzo】；
- samsy：误判为源码 bug、错误修复、取证后撤销（见 §0）【samsy】；
- noomo：M0 镜像阶段亲历，后台标签 rAF/timer 节流使滚动驱动的 WebGL 站不可确定性驱动【noomo】。

**对策（按彻底程度递增）**：
1. **无头脚本必带 anti-throttling 旗标**：起 headless Chrome 时加 `--disable-background-timer-throttling --disable-renderer-backgrounding`（samsy M2 教训，写进 regression.mjs）【samsy】。
2. 需要页内驱动时，配合页内 gsap 泵 + `Page.addScriptToEvaluateOnNewDocument` 预种状态【samsy】。
3. 滚动驱动站的 A/B 对拍走 **probe-shim 路线**：约 90 行脚本接管 rAF/timer/visibility——rAF 换成手动泵 `__pump(dt, frames)`、`document.hidden/visibilityState/hasFocus` 钉死为可见、setTimeout 接管进泵驱定时队列、时间戳从 0 起【noomo】。注入位置有讲究："gsap 在模块求值期捕获 rAF，Nuxt 插件太晚，必须 head 首脚本"【noomo】。驱动配套：`__drive` 真时钟配速泵 + MessageChannel yield（不受节流的宏任务边界）、需要 isTrusted 的交互用真实点击触发、`smoother.scrollTo(y, false)` 反复钉扎消动量残留【noomo】。

---

## 2. 陷阱：开发环境幽灵状态

判定"状态不对"之前，逐条排查：

1. **vite HMR `?t=` 幽灵模块**：HMR 的 `?t=` 查询会造出幽灵模块实例，探针读到的是假状态【samsy】。对策：验证一律用全新加载，不信 HMR 会话里的读数。
2. **探针时钟与页面时钟错位**：会伪装成"计时器时间被压缩"【samsy】。断言时序前先确认双方时钟同源。
3. **旧构建缓存**：SPA 会话里旧构建的 JS/CSS 会让"已修复的 bug"复现【rogier】。rogier 的对策是把 service worker 改为 network-first，保证 QA 时不会供出旧构建【rogier】。
4. **DNS 负缓存**：代理工具的 DNS 负缓存会伪装成资源加载失败，取证手段：DoH 查询、直连 IP【rogier】。
5. **构建窗口期 fetch 失败**：构建进行中的 fetch 失败不是产品 bug【rogier】。
6. 框架挂载时序差也会造出假状态：samsy 记录过 Vue 挂载晚于引擎 IDLE 的时序差、以及 `window.camera` 被 ReflectorNode clone 覆盖成镜像相机——探针读全局句柄前先确认句柄归属【samsy】。

---

## 3. 陷阱：部署拓扑差异竞态

本地全绿不等于线上无竞态：**真实网络延迟会触发本地永不出现的竞态**，所以"部署即验证"是流程的一部分【samsy】。

samsy M12 实例：部署后暴露一个源站永不触发的构造期纹理加载竞态，用 CDP Fetch 对单文件注入延迟做**二分定位**，锁定到两张纹理；根因判定为"部署拓扑差异（单源 vs CDN 分域）"而非代码，修复拆成"保真修正"与"登记偏差"两笔分开处理【samsy】。

**指令**：部署后复测全部验收门；发现仅线上出现的问题时，先用延迟注入复现，再决定是修代码还是登记偏差。

---

## 4. 陷阱：探针自身的盲区（绿灯不可全信）

**探针的覆盖面本身是需要迭代的对象**——lando 的教训：镜像 CSS 被 Chrome 因 SRI 校验静默拦截，而**安全类报错走 CDP 的 `Log.entryAdded` 域**，探针只监听了 Runtime/Network，导致 M0.5 的 "CLEAN" 存在盲区；修复方式是给探针补上 Log 域监听【lando】。

写 CDP 探针时的工程红线（kimi 工具坑清单，逐条照办）【kimi】：
- **CDP 调用必须带超时**，否则挂起的调用卡死整个脚本；
- **大 payload 分块取回**：单次多兆字节的 `Runtime.evaluate` 会卡死管道；
- **headless Chrome 无视 SIGTERM，收尾必须 SIGKILL**；
- **别用 `drawImage` 读无 `preserveDrawingBuffer` 的 WebGL canvas**（读到的是空的）。

WebGL 读回专属陷阱：`readRenderTargetPixels` 读回前必查 `gl.getError()`——**全零缓冲是读回假象**，不是场景真的全黑【noomo】。

---

## 5. 陷阱：headless 盲区——必须留真机/人眼兜底

自动门之外必须保留人工目视与真机对比，因为 headless 环境有结构性盲区：

- **授权字体不加载**：headless 下 Adobe Fonts 等授权字体缺失，产生换行/排版差异，属方法学噪声而非 bug【oryzo】；
- **sRGB 色彩管理差异**：只有真机对比能暴露——oryzo 最后一轮真机对比在"噪声"里捞出真 bug：8 处纹理缺 sRGB→linear 解码导致整场景偏亮发灰【oryzo】；
- **编码保真类问题自动门抓不到**：lando 收官后靠用户目视才发现头盔墙 7 张含空格文件名的图 404（vite 对 srcset 二次编码 `%20`→`%2520`），随后补了一次全站 URL×磁盘全量审计【lando】。

**指令**：收官清单里固定一条"真机 Chrome 对拍 + 人工目视过一遍"，重点看字体排版、色彩、以及自动门未覆盖的资源加载。

---

## 6. 陷阱：检查点覆盖不足

探针检查点没覆盖到的区间就是漏网区。noomo 实例：探针检查点没测滚动终点 t=20，导致 HomeFooter 揭示动画**整段缺失**漏网，收官后靠用户直连源站对比才发现；沉淀的教训是"**终检必须包含滚动两端**"【noomo】。

配套细则：seek 之后必须重新驱帧再截图，否则截到的是 seek 前的残留帧【noomo】。

**指令**：设计对拍检查点时，滚动 0% 与 100% 两端必须在列；每个可交互终态（footer、最后一屏、404）都要有检查点。

---

## 7. 判定 bug 前的自查清单

把问题归因到源码之前，逐项打勾：

- [ ] 是全新加载复现的吗？（不是 HMR 会话 / 手动切换后的状态）【samsy】【kimi】
- [ ] 无头环境带了 anti-throttling 旗标吗？页面在前台吗？【samsy】
- [ ] 探针时钟与页面时钟同源吗？【samsy】
- [ ] 排除了旧构建缓存 / DNS 负缓存 / 构建窗口期吗？【rogier】
- [ ] 探针监听了 CDP Log 域吗？（安全报错不走 Runtime/Network）【lando】
- [ ] 读回 WebGL 数据前查过 `gl.getError()` 吗？【noomo】
- [ ] 差异是不是 headless 盲区（字体 / 色彩管理）？真机上还在吗？【oryzo】
- [ ] 检查点覆盖了滚动两端吗？【noomo】
- [ ] 只在部署环境出现？先用延迟注入复现再归因【samsy】

全部排除后，才允许开始在 bundle 里找源码归属。反之，如果是环境问题：**修环境或修探针，不动复刻代码**。
