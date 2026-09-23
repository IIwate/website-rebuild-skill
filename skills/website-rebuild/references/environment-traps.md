# 环境陷阱手册

> **何时加载本文件**:进入验证阶段, 编写任何无头探针/回归脚本之前; 以及每次准备把"假死 / 时序异常 / 状态不一致 / 像素差异 / **两侧相位不同** / **移动端走了桌面分支**"判定为源码 bug 之前. 先按本手册校准环境与探针, 再动代码(相位类差异先过 §7 的快检查比值).

## 0. 总约束: 环境因素先取证再动代码

**任何"bug"在归因到源码之前, 必须先排除环境与探针自身的嫌疑.**旧构建缓存, DNS 负缓存, 构建窗口期 fetch 失败都会伪装成产品 bug--先取证(computed style, DoH, 直连 IP),再动代码[rogier].

**误判的代价不是浪费时间, 而是引入一个偏离源站的假修复.**(反面案例即本手册存在的理由, 见 `case-studies/environment-traps.md` §0)

配套惯例: 探针超时要与产品缺陷显式区分--真机上调大探针等待时, 明确标注 "probe timing, not a product mismatch"[rogier](实证:`case-studies/environment-traps.md` §0).

---

## 1. 后台标签节流与停止更新现象

**现象**:页面在后台标签/无头环境里帧循环停摆, 启动链走不完, 动画不推进, 看起来像站点死锁. gsap 的 `lagSmoothing` 会进一步放大伪装效果[samsy].

**三个项目独立踩过**(实证:`case-studies/environment-traps.md` §1).

**对策(按彻底程度递增)**:
1. **无头脚本必带 anti-throttling 旗标**:起 headless Chrome 时加 `--disable-background-timer-throttling --disable-renderer-backgrounding`(samsy M2 教训, 写进 regression.mjs)[samsy].
2. 需要页内驱动时, 配合页内 gsap 泵 + `Page.addScriptToEvaluateOnNewDocument` 预种状态[samsy].
3. 滚动驱动站的 A/B 对比走 **probe-shim 路线**:约 90 行脚本接管 rAF/timer/visibility--rAF 换成手动泵 `__pump(dt, frames)`, `document.hidden/visibilityState/hasFocus` 固定为可见, setTimeout 接管进泵驱定时队列, 时间戳从 0 起[noomo].注入位置有讲究:"gsap 在模块求值期捕获 rAF,Nuxt 插件太晚, 必须 head 首脚本"[noomo].驱动配套:`__drive` 真时钟配速泵 + MessageChannel yield(不受节流的宏任务边界), 需要 isTrusted 的交互用真实点击触发, `smoother.scrollTo(y, false)` 反复钉扎消动量残留[noomo].

---

## 2. 陷阱: 开发环境幽灵状态

判定"状态不对"之前, 逐条排查:

1. **vite HMR `?t=` 幽灵模块**:HMR 的 `?t=` 查询会造出幽灵模块实例, 探针读到的是假状态[samsy].对策: 验证一律用全新加载, 不信 HMR 会话里的读数.
2. **探针时钟与页面时钟错位**:会伪装成"计时器时间被压缩"[samsy].断言时序前先确认双方时钟同源.
3. **旧构建缓存**:SPA 会话里旧构建的 JS/CSS 会让"已修复的 bug"复现[rogier].rogier 的对策是把 service worker 改为 network-first,保证 QA 时不会供出旧构建[rogier].
4. **DNS 负缓存**:代理工具的 DNS 负缓存会伪装成资源加载失败, 取证手段: DoH 查询, 直连 IP[rogier].
5. **构建窗口期 fetch 失败**:构建进行中的 fetch 失败不是产品 bug[rogier].
6. 框架挂载时序差也会造出假状态(框架挂载晚于引擎 IDLE, 全局句柄被 clone 覆盖成另一个对象)--探针读全局句柄前先确认句柄归属[samsy](实证:`case-studies/environment-traps.md` §2).

---

## 3. 陷阱: 部署拓扑差异竞态

本地检查未覆盖的网络延迟与加载次序可能触发竞态. 涉及部署时验证目标环境; 仅本地任务可用受控延迟测试相关机制, 见 samsy 案例[samsy].

典型形态: 仅线上出现的构造期资源加载竞态, 用 CDP Fetch 对单文件注入延迟做**二分定位**,根因归"部署拓扑差异(单源 vs CDN 分域)"而非代码, 修复拆成"保真修正"与"登记偏差"两笔分开处理[samsy](实证:`case-studies/environment-traps.md` §3).

**指令**:部署后复测全部验收检查; 发现仅线上出现的问题时, 先用延迟注入复现, 再决定是修代码还是登记偏差.

---

## 4. 陷阱: 探针自身的盲区(通过结果不可全信)

**探针的覆盖面本身是需要迭代的对象**--**安全类报错走 CDP 的 `Log.entryAdded` 域**(如 SRI 校验静默拦截),只监听 Runtime/Network 的探针会让 "CLEAN" 带盲区; 修复方式是给探针补上 Log 域监听[lando](实证:`case-studies/environment-traps.md` §4).

写 CDP 探针时的工程红线(kimi 工具坑清单, 逐条照办)[kimi]:
- **CDP 调用必须带超时**,否则挂起的调用卡死整个脚本;
- **大 payload 分块取回**:单次多兆字节的 `Runtime.evaluate` 会卡死管道;
- **headless Chrome 无视 SIGTERM,收尾必须 SIGKILL**;
- **别用 `drawImage` 读无 `preserveDrawingBuffer` 的 WebGL canvas**(读到的是空的);
- **`Page.captureScreenshot` 的 `clip` 是文档坐标, 不是视口坐标**[shopifydesign]--见下.

**`clip` 陷阱: 固定布局的站点会拿到全白图**[shopifydesign].写滚动截图检查时为了降分辨率提速, 很自然会写 `clip: {x:0, y:0, width, height, scale:.5}`.**那个坐标系是文档, 不是视口**:滚到 `scrollY = 10810` 时它照样截**文档顶部**那一块. 而如果站点的画布与页头都是 `position: fixed`,文档顶部那一屏里什么都没有--整批滚动检查点会返回全白 PNG,肉眼看图才发现(实证:`case-studies/environment-traps.md` §4).

- **指令**:**带 `clip` 抓图前先问一句"这个页面有没有 fixed / sticky 元素"**;**滚动位姿一律用整视口抓图(不带 `clip`)**.代价是快检查变慢, 用 §7 的突发采样 + 事后取最近帧去接.
- **自检**:**同一会话不同滚动位姿的截图哈希必须互异**(`gate-failure-modes.md` §1.2 的老规矩, 正好也抓这个坑: 全白图的哈希全都一样).

WebGL 读回专属陷阱:`readRenderTargetPixels` 读回前必查 `gl.getError()`--**全零缓冲是读回假象**,不是场景真的全黑[noomo].

---

## 5. 陷阱: headless 盲区--必须留真机/人眼补充检查

自动检查之外必须保留人工目视与真机对比, 因为 headless 环境有结构性盲区:

- **授权字体不加载**:headless 下 Adobe Fonts 等授权字体缺失, 产生换行/排版差异, 属方法学噪声而非 bug[oryzo];
- **sRGB 色彩管理差异**:只有真机对比能暴露--最后一轮真机对比常在"噪声"里捞出真 bug(如纹理缺 sRGB→linear 解码导致整场景偏亮发灰)[oryzo];
- **编码保真类问题自动检查抓不到**:构建器对含空格文件名的二次编码(`%20`→`%2520`)造成的 404 靠用户目视才发现, 随后要补一次全站 URL×磁盘全量审计[lando].

(两条的实证出处:`case-studies/environment-traps.md` §5)

**指令**:交付清单里固定一条"真机 Chrome 对比 + 人工目视过一遍",重点看字体排版, 色彩, 以及自动检查未覆盖的资源加载.

---

## 6. 陷阱: 检查点覆盖不足

探针检查点没覆盖到的区间就是漏网区. 沉淀的教训是"**终检必须包含滚动两端**"[noomo].(漏网实例见 `case-studies/environment-traps.md` §6)

配套细则: seek 之后必须重新驱帧再截图, 否则截到的是 seek 前的残留帧[noomo].

**指令**:设计对比检查点时, 滚动 0% 与 100% 两端必须在列; 每个可交互终态(footer, 最后一屏, 404)都要有检查点.**这只是覆盖面的下限**--完整的枚举规则(位置**按内容分段** × **状态**两维取笛卡尔积)在 `verification-gates.md` §1.3.1:只覆盖两端仍会漏掉中段的整段内容(实证:`case-studies/environment-traps.md` §6).

---

## 7. 陷阱: 快检查比被测运动慢--采样偏差伪装成"两侧相位不同"[shopifydesign]

**命题**:任何"**按状态对齐抓帧**"的检查(轮询到某个进度量再截图, 按 `spreadT`/`progress`/`t` 对齐同帧对比),开工前先测一个比值:

> **单次截图耗时 / 被测运动全长**.**比值不小于约 1/10,就不要相信抓到的相位.**

比值超标时, 快检查落点由 CDP 往返耗时决定, 不由页面状态决定--而**两侧的往返耗时是不一样的**(每帧开销不同),于是仪器自己造出一个稳定的, 可复现的相位差.

实证链条(软件渲染 → 单次截图 1–2s → 被测运动全长 2000ms → 两侧稳定差出 0.1 以上的相位, 差点被写成"复刻侧动画更快"):`case-studies/environment-traps.md` §7.

> **可复现的偏差最像真 bug.**"每次都一样"不是"是真差异"的证据--恒定的仪器开销给出的就是恒定的偏差.

**走过的弯路(别重走)**:把判据搬进页面做 in-page watcher(用站点自己的 rAF 检测阈值穿越, 穿越瞬间再请求截图).**那修的是判据延迟, 不是快检查延迟**,瓶颈在 `captureScreenshot` 上, 数字一点没变好. 同理, 提高轮询频率也无效.

**正确解法: 把快检查变快, 而不是把判据变准.**

1. **先修快检查**:删掉软件渲染 flag(`--use-gl=swiftshader --enable-unsafe-swiftshader`)后, 同一段运动可采的帧数提升一个量级(实证:`case-studies/environment-traps.md` §7). 删/加这类 flag 会改变被测程序本身, 必须同时读 `references/determinism.md` §2.9 并把画质档固定登记--见本文件下一段.
2. **再改采样策略**:把"轮询到阈值再截一张"改成 **整段突发采样 + 每帧标注拍摄前读到的相位 + 事后取最接近目标的一帧**.实测 Δ 因此收紧一个数量级(`case-studies/environment-traps.md` §7).
3. **报告里写实际相位, 不写目标相位**:对比产物旁边记两侧各自的实测相位与 Δ,让下一个人能判断残差里有多少是相位造成的.

** 这条与能力探测熵源是同一个坑的两面**:`--use-gl=swiftshader` / `--disable-gpu` 既让快检查变慢, 又会命中站点的 GPU 名黑名单把被测程序切到低画质分支(`determinism.md` §2.9).**先量比值, 再决定 flag;flag 定了必须连画质档一起固定并登记.**

### 7.1 更强一档: 把驱动的时间表也注入页面[shopifydesign]

上面的解法(突发采样 + 事后取最近帧)修的是**快检查**.还剩一项同量级的仪器误差没修:**驱动步骤本身的时刻**.凡是"先驱动到状态 X 再抓图"的检查,"什么时候滚的 / 什么时候按下去的"由 CDP 往返决定, 而两侧的往返耗时**不一样**--这与 §7 是同一个病灶的两个器官.

**做法**:把驱动动作搬进页面--**整张时间表(滚动位置序列 / 交互序列)以各自站点的就绪事件为原点注入**(本例 `site-ready`),由**页面自己的定时器**执行; 探针只负责突发抓图与事后配对. 注入的记录器只登记事件时间戳, 不读也不改站点任何状态, 两侧注入字节完全相同.

**收益(两层, 第二层才是关键)**:

1. **直接对齐**:跨侧 Δ 相位收到毫秒级(实证:`case-studies/environment-traps.md` §7.1).
2. ** 顺带对齐了下游的派生锚点**:外部轮询式驱动会让两侧的倒计时相位差一个随机量,**注入式时间表让这条派生链整体同相**--这类二级锚点你通常不会想到要去对齐它.

**两条配套约束**:

- **注入按仪器类偏差登记**(该项目 D19),与 probe-shim 同规格: 无开关时输出字节不变.
- **时间表必须是真实的走查, 不许"跳"到目标屏**:闩锁型状态要把对应区段**整段滚过去**才置位(实证:`case-studies/environment-traps.md` §7.1).直接 `scrollTo` 到时钟屏的检查会发现引擎是哑的--**那时量到的是自己的驱动步骤, 不是被测程序**.

**指令**:
- 写任何"按状态抓帧"的脚本之前, 量一次快检查耗时(连拍 5 次取中位数)与运动全长(从事件时间戳算),把比值写进脚本头注释;
- 比值 ≥ 1/10:先修快检查(真 GPU, 降视口, 去掉软件渲染),修不动就换突发采样 + 取最近帧;**不许**靠"把判据搬进页面"糊过去;
- **报"两侧相位不同 / 复刻侧动画更快"之前, 先证明你的快检查比被测运动快**,否则默认归因为仪器.

---

## 8. 陷阱: 移动视口仿真的 `<meta viewport>` 布局切换[objectarchive]

**命题**:`Emulation.setDeviceMetricsOverride({mobile:true})` 落地了,**不等于页面已经按移动宽度排版**.每一个**新文档**的 document-start 时刻,`window.innerWidth` 都是 **980**--传统默认值, 因为此刻还没解析到 `<meta name="viewport">`;真实宽度**异步**落地在其后.

**为什么它咬人**:任何在 `<body>` 里**同步读 `innerWidth`** 并据此选分支的代码, 跑在切换之前就永久停在错的那一边. 最常见的形态是"只在值变化时才重算"的守卫:

```js
const cols = () => (innerWidth < 750 ? 1 : 3);
buildColumns();                       // Synchronous initialization observes the current layout width.
addEventListener('resize', () => { if (cols() !== columnCount) buildColumns(); });
```

**实测**:移动档会间歇地被拍成**桌面布局**,而事后读到的 `innerWidth` / `screen.*` 一切正常--**"覆盖没落地"这个直觉是错的, 覆盖一直是落地的**(实证:`case-studies/environment-traps.md` §8).

**识别信号(命中任一条就按本节处置, 不要去查移植)**:

- 同一条命令, 同一个视口档,**分钟之隔跑出两种布局**(实证:`case-studies/environment-traps.md` §8);
- 失败**同时出现在两侧**且**不确定**--这是仪器竞态的签名, 不是移植缺陷(`gate-failure-modes.md` §3.1.1);
- 事后读 `innerWidth` 一切正常,**只有 document-start 探针**才看得见 980.

**取证手段(这是本节唯一的"先量"动作)**:用 `Page.addScriptToEvaluateOnNewDocument` 在**任何页面脚本之前**记 `window.innerWidth` / `screen.width`,成功与失败的会话各看一遍.**它一次就能把候选机制砍到一种**(实证:`case-studies/environment-traps.md` §8).

**三种补救, 逐条实测(别重走前两条)**:

| 试的办法 | 实测 | 为什么 |
|---|---|---|
| 停在自带 `<meta viewport>` 的 `data:` 页, 等 `innerWidth === 390` 再导航 | **0/6** | 跨源那一跳把瞬态又带回来了 |
| 反复重新导航(最多 6 次) | **0/6** | 目标一旦以桌面态 parse 过, 错误的排版是**稳定的**,不是偶发的--这也解释了为什么"重载一次"那一版把红从 2/8 变成 **5/8** |
|  **把宽度抖一下(W → W+1 → W),驱动页面自己的 resize 重建** | **5/5** | 页面自己注册了防抖 resize 监听, 列数与当前值不符就重建--**真机旋转走的就是这条路**,重建产物与全新 parse 的 DOM 一致 |

 **抖动有第二种用法: 不只是"拍照前预防",也是"发现已排错版之后的定向修复"**[objectarchive].(第二种用法的来历:`case-studies/environment-traps.md` §8)改法不是把 sleep 加长(那是把偶发红换成偶发慢),而是:

1. **用被测块自己的产物当探测器**--取样后先问"列数是 1 吗".它比 `innerWidth` 诚实: 事后读 `innerWidth` 永远是 390,而列数会老老实实说这份文档是按 980 排的版.
2. **命中就抖, 抖完重采**,等的是块自己的重建产物(防抖 resize 监听),不是墙钟.
3. **把"抖了几次"写进记录**(约束 2 的核对凭据),并**保留断言原样失败**:抖动次数用完仍不是 1 列, 就照常按最后一次真实采样判--修复手段绝不能把持续失败通过.

 **不要把重试写成"重新导航"**:上表第二行已经量过,0/6.**回流写下的实测, 只有在下次动手前被读到才算数.**(这条是怎么被抓住的:`case-studies/environment-traps.md` §8)

 **验证范围**: 上表的 5/5 来自取样前调整视口的实验. 后续检查中的 "检测 + 调整后重采"只用 fixture 执行过一次, 竞态在随后 6 轮未复现, 因而该修复对自然发生错误布局的效果仍未确认, 见 `case-studies/environment-traps.md` §8.

**三条约束**:

1. **等的是渲染器承认新视口, 读 `screen.*` 而不是 `innerWidth`**:`about:blank` / identity 页没有 `<meta viewport>`,移动仿真下一律按 980 排版,**在文档外面等不出来**.
2. **抖动是"不给一份已知排错版的文档拍照",不是调容差**.判据一字不动, 仍然失败; 容差与带宽常数早于本轮任何数字冻结(§7 与 `verification-gates.md` §1.3.2).**每次抖动实际触发了几处要打进日志**,它是这条仪器偏差的核对凭据.
3. **按仪器类偏差登记**,与 probe-shim / 焦点仿真同规格, 写清"换真实设备驱动时回退".

**输入能力仿真**: 视口尺寸与 `matchMedia("(hover:none)")`、`maxTouchPoints` 是不同条件. `setDeviceMetricsOverride({mobile:true})` 不能单独证明已进入触摸分支. 按目标设备配置触摸能力, 并读取页面实际选中的分支, 见 `determinism.md` §2.9.

---

## 9. 陷阱: 驱动无限期挂起--**"挂住了"和"跑得慢"长得一模一样**[objectarchive]

**命题**:CDP 驱动的检查在等页面时, 如果外部条件消失(**断网**是最常见的一种),它会**一直等下去**,而不是失败. 终端上看到的是"还在跑",与"这轮比较慢"无法区分.

**实证**:断网期间的一次挂死, node 进程 0% CPU, S 状态卡在等 CDP 响应超过一小时零输出,**网络恢复后它也不会自己醒**--那次连接已经死了, 没有人在超时; 而同一进程组里的 headless Chrome 还活着, 从进程表看一切"正常"(实证:`case-studies/environment-traps.md` §9).

**为什么断网会打到一个本地检查**:两侧都在 `127.0.0.1`,但页面本身仍会尝试解析/连接外部主机(预连接, 被 stub 的域名在 DNS 层仍要走一遭),而**代理隧道断掉时这些请求既不成功也不失败**,`readyState === 'complete'` 于是永远不来.

**识别信号**:

- 进程 CPU ≈ 0, 状态 S, 无输出, 而它本该每几十秒打印一行;
- 耗时超过同命令历史时长的 2–3 倍;
- `route -n get default` / `ping 网关` / `curl` 三层里有任意一层不通(判据见下).

**做法**:

1.  **每个"等页面"的循环都要有硬上限, 且超时是明确报错并非零退出**:`open()` 之类的 settle 轮询必须带 deadline 并 `throw`("page never came up within Ns"),**不允许无上限的 `for(;;)`**.**检查可以红, 可以慢, 但不可以无声地不结束.**(同一族的旧例:`case-studies/environment-traps.md` §9)
2. **外层给整条命令套 `timeout N`**,让挂死变成一个非零退出码而不是一个没人看的终端.
3. **分层诊断, 不要只 ping 一个地址**:网关 → 公网 IP 直连 → DNS 解析 → HTTP.代理隧道(`utun*` + `198.18.0.0/16` 的 fake-IP 段)断掉时前两层全通, 后两层全挂, 只测第一层会得出"网络没问题"的错误结论.
4. **恢复之后不要指望进程自愈**:按进程组收掉(`kill -TERM -<pgid>`,见 `determinism.md` 的进程回收约束),确认 headless 残留为 0 再重跑.
5.  **挂死期间产生的任何数据都不可信**:**慢, 会把两侧的采样时刻拉开到足以跨过某个状态边界**,制造出 §4.10 型的误报(实证:`case-studies/environment-traps.md` §9).挂死不只是浪费时间, 它是一台**残差制造机**.

## 9.5 陷阱: npm 生命周期钩子不跟人走--`npx next build` 不触发 postbuild[basement]

**症状**:构建后某类资源间歇性 404,"上一轮明明修好了".同一台机, 同一份代码,
有时好有时坏, 坏的那几轮全是直接 `npx next build` 构建的.

**机理**:`pre*`/`post*` 钩子只在 `npm run <script>` 时执行;`npx next build`
直调 CLI,钩子静默跳过. 凡钩子负责重建的产物(basement:`.next/static/` 里的
镜像 immutable 软链--`next build` 每次清空该目录)就悄悄消失, 而构建本身
零警告全部通过. 下游症状还会变形: worker 脚本 404 产生**空字段 error 事件**,
被误判成跨域脱敏错误(porting-discipline §2.5.1 第 6 条).

**对策**:
- 关键产物的重建挂**多个**生命周期点(`postbuild` + `prestart` 双保险),
  或干脆并进 build 命令本体(`"build": "next build && node …"`);
- 无人值守脚本与文档里统一写 `npm run build`,不写 `npx next build`;
- 自查: 坏境复现前先 `ls` 一遍钩子负责的产物在不在.

## 9.6 npx 子进程与进程组清理[samsy]

检查脚本用 `spawn('npx', ['vite', …])` 起开发服务器, 退出时 `child.kill('SIGKILL')`.杀掉的是 npx,真正监听端口的 vite 是它 fork 的孙进程, 被过继给 pid 1 继续活着. 这样的孤儿可以提供服务一棵早就不存在的旧树好几天, 而后来的每一次"端口被占"都被当成新问题(实证:`case-studies/environment-traps.md` §9.6).

对策与 `lib/chrome.mjs` 同款:`spawn(…, { detached: true })` 让子进程自成进程组, 退出路径上 `process.kill(-pid, 'SIGKILL')` 回收整组; 起服务前先探一次端口,**有东西应答就明确退出并指路 `lsof -i :<port>`**--静默换端口只会把孤儿留给下一个人.

## 9.7 WebGPU 与 TSL 计算管线无头软光栅编译耗时

在无物理 GPU 直通的无头环境 (如 Linux 容器, WSL2 使用 SwiftShader 或 llvmpipe 纯 CPU 软件模拟) 下, 包含 WebGPU Compute Shader, TSL (Three Shading Language) 节点网络, 频域 FFT 海洋波浪仿真或体素噪声生成的复杂管线, 其首次着色器分析, 抽象语法树构建与驱动层编译的客观物理耗时常达 60~120 秒.

常见误判表现:
- 探针或 CDP 客户端在 60s 默认超时处断连, 报 `CDP timeout after 60000ms`, 被判为页面死循环或渲染器崩溃;
- 执行方转而修改被测代码, 移除异步预编译 (`compileAsync`), 或改动原本正确的计算着色器节点.

判据与处理顺序:
1. **CPU 占用是必要判据**: 先测无头 Chromium 进程状态. 只有 Chrome 渲染与计算线程的 CPU 利用率持续处于高负载 (≥ 80%) 时, 才能判定为软光栅编译等待; CPU 利用率接近 0% (进程处于 S 睡眠态) 说明是死锁, 上下文丢失或网络挂起, 编译耗时的解释不适用.
2. **排查原站降级开关**: 检查原站是否自带后备渲染路径 (如 `localStorage.setItem("forceWebGL", "true")` 或配置参数中的降级开关), 优先验证兼容分支.
3. **参数化放宽探针预算**: 确认属于软光栅编译耗时后, 通过环境变量 `CDP_TIMEOUT_MS=180000` 或 CLI 参数 `--cdp-timeout 180000` 放宽仪器的等待预算. 被测代码不因仪器超时而修改.

## 10. 判定 bug 前的自查清单

把问题归因到源码之前, 逐项打勾:

- [ ] 是全新加载复现的吗?(不是 HMR 会话 / 手动切换后的状态)[samsy][kimi]
- [ ] 无头环境带了 anti-throttling 旗标吗? 页面在前台吗?[samsy]
- [ ] 探针时钟与页面时钟同源吗?[samsy]
- [ ] 排除了旧构建缓存 / DNS 负缓存 / 构建窗口期吗?[rogier]
- [ ] 探针监听了 CDP Log 域吗?(安全报错不走 Runtime/Network)[lando]
- [ ] 读回 WebGL 数据前查过 `gl.getError()` 吗?[noomo]
- [ ] 差异是不是 headless 盲区(字体 / 色彩管理)?真机上还在吗?[oryzo]
- [ ] 检查点覆盖了滚动两端吗?[noomo]
- [ ] 差异是"相位不同"吗? 量过**单次截图耗时 / 运动全长**了吗?(≥1/10 先判仪器)[shopifydesign]
- [ ] 驱动步骤的**时刻**对齐了吗?(外部轮询驱动 vs 注入页面的时间表,§7.1)[shopifydesign]
- [ ] 抓图带了 `clip` 吗? 页面有 fixed/sticky 元素吗?(`clip` 是**文档坐标**,滚动位姿会拍成全白,§4)[shopifydesign]
- [ ] 无头 flag(`--use-gl=swiftshader` / `--disable-gpu`)有没有把被测程序切到另一条画质/能力分支?(`determinism.md` §2.9)[shopifydesign]
- [ ] 生命周期钩子负责的产物还在吗? 这轮构建走的是 `npm run` 还是直调 CLI?(§9.5)[basement]
- [ ] **WebGPU/TSL 计算场景**: 超时期间 Chrome 进程 CPU 利用率是否持续 ≥ 80%? (是则通过 `CDP_TIMEOUT_MS` 或 `--cdp-timeout` 放宽仪器预算, 不把编译等待当作死循环去改被测源码, §9.7)
- [ ] **移动视口档**:用 document-start 探针量过 `innerWidth` 吗?(`<meta viewport>` 落地前它是 **980**,页面可能已经按桌面排好了版,§8)[objectarchive]
- [ ] 准备改仪器了--**有没有先用一个探针把候选机制砍到一种**?(凭症状猜修法实测把 2/8 红变成 5/8 红,`gate-failure-modes.md` §3.1.1)[objectarchive]
- [ ] 只在部署环境出现? 先用延迟注入复现再归因[samsy]

全部排除后, 才允许开始在 bundle 里找源码归属. 反之, 如果是环境问题:**修环境或修探针, 不动复刻代码**.

## 11. 调度边界与评估约束

### 11.1 Browser Task Boundary:先量时序, 再解释时序

Webpack 动态 Chunk 与 ESM `import()` 都可能跨越加载, 微任务和宏任务边界, 但它们不是同一种调度机制.`MessageChannel` 只提供下一宏任务, 不能拿它证明框架内部的加载或执行时序相同.

 **取证要求**:需要比较时, 分别记录请求发出, 脚本执行, Promise continuation 和目标状态的可观测时刻; 不要把一次 `setTimeout` 或一张截图当成两种机制的等价证据. 只有被测入口确实使用对应机制时, 才启用相应探针.

### 11.2 两阶段评估: 先证明仪器, 再判断产物

先用独立冷启动建立参照侧自己的重复性基线, 再在相同视口, DPR, 字体, 输入事件和采样时刻下测修改产物. 双重冷启动的粗网格对比只能说明稳定性范围, 不能替代状态, 几何, 渲染和资源边界的专检查检查; 本小节不规定统一的采样器或基线文件格式.

- [ ] CDP 连接, 目标创建, Runtime/Network/Log 域启用, 输入注入, 重载和清理均有生命周期记录;
- [ ] 基线与修改产物分两阶段采集, 未用被测侧结果反推期望值;
- [ ] 微任务/宏任务的 settle 判据已写明, 超时和未判定状态不会伪装成通过.
