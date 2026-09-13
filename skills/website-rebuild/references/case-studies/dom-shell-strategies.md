# case-studies/dom-shell-strategies.md - DOM 层策略选型指南(A/B/C + 正交约束 D) 的实证记录

> **何时加载本文件**:不在必经集合里. 只在想知道 `dom-shell-strategies.md` 某条规则**为什么存在**, 或要核对它的实证强度时读; 章节号与 `dom-shell-strategies.md` 一一对应.

## 2. 策略 A:零重写 shells(平台导出物)[lando]

规则见 `dom-shell-strategies.md` §2 步骤 3(防御按逐条下限写).

- **按变换分别计数**: objectandarchive 的五条变换命中数为 15 / 5 / 2,540 / 20 / 5. URL 本地化的 2,540 次命中足以使总数大于零, 即使原本命中 5 次的 noindex 注入失效, 总数检查仍通过. 每条必需变换应按目标文档分别验证[objectarchive].

- **输入内容变化**: M0b 中 `T-WPM` 命中 4 次, 低于预期 5 次. 原因是 43 份目标文档被挑战页替代, 其中没有相应平台脚本. 当时 `verify-mirror` 的摘要检查与五项下游检查均通过. 变换命中数暴露了该问题, 但不能替代针对响应类型和挑战页的检查, 见 `mirroring.md` §5.1[objectarchive].

## 4. 策略 C:框架内重建 + 字节对齐(框架编译产物)

### 4.4 CSS 层: 双向 diff[rogier]

规则见 `dom-shell-strategies.md` §4.4.

- **反向扫描**:枚举重建侧**源 bundle 里没有的全部规则**(rogier:118 条 (media, selector)),逐条判定"必要机制 / 等价别名 / 多余发明"--rogier 揪出 3 条真发明(`.ui-header-bg` 桌面渐变, `.ui-work-a` 的 transform transition, 移动端 text-shadow)并删除[rogier].

- Tailwind 站的 grep 陷阱: 产物可能走 server-inline 通道, grep .css 文件会误判 utility 是否存在[noomo];noomo F2(大字偏小)根因就是 19 个 `text-sans/serif` `@utility` 整族缺失, 从源站 CSS 逐条重建[noomo].

## 5. 策略 D:DOM 即场景图(DOM/CSS 是 3D 引擎的坐标源)[shopifydesign]

### 5.2 取证判据(怎么认出自己遇到了策略 D)

规则见 `dom-shell-strategies.md` §5.2.

只做前者会漏掉后者--shopifydesign 的策略 D 结论出自逆向期的**静态观察**,第二问是纵向功能切片之后的**运行时观察**才补上的[shopifydesign].

> **实证[shopifydesign]**:M2 把镜像 SSR 外壳原样端起来(只摘掉框架运行时, 换上移植引擎),场景图数值检查立刻红, 且可逐个归因--
> - hero 三栏**贪心砌砖**(`z5` L45192–L45204,由 `H5` L45309–L45350 驱动, 栏高权重 `1/aspect`),而输入 `aspect` 由 `<video onLoadedMetadata>` L45225–L45229 **异步回填**,每回填一次重排一次 → 24 张卡换栏(`worldX`/`worldZ` 变, 尺寸/`depth`/`src` 不变), `.hero-grid` 4078 vs 4175px, `docHeight` 13798 vs 13895, 其后所有对象统一 **+97.078**;
> - 倒计时舞台 `.countdown-stage-sticky > .manifesto` 的客户端定位 → `manifesto-*` **−3321.602**, `countdown-headline`/`cd-ring` **−1829.4**.

### 5.3 三条推论(每条都改变工程决策)

规则见 `dom-shell-strategies.md` §5.3 推论 2(`readLayout()` 的副作用要连同还原顺序一起抄).

**实测漏掉这一步: 镜像与线上出现统一 158px 的 Z 偏移**--那正是被 `transform=""` 抹掉的入场位移.

### 5.4 弱化形态: 没有 3D 引擎, 但块在运行时量矩形, 据此写内联样式[objectarchive]

规则见 `dom-shell-strategies.md` §5.4.

**1) 识别判据的命中实证:**

> **实证[objectarchive]**:一个判 B 的 Shopify 站, 指纹侦察明确"3D / WebGL:**无**"(`three` 弱匹配全部来自 `three_col` 类名, 已证伪),但三块命中本形态--hero 分层轮播的 `calcBgScale()`(`max(panelW/cardW, panelH/cardH) × 1.15`,地板 1.7 → 写 `transform: scale()`), PDP 画框合成器的 `getDisplaySize()`(读 `compositor.getBoundingClientRect()` → `refDim × 0.85 / max(fw,fh)` → 写画框台像素尺寸), PDP 面板块(容器高 = 活动面板 `scrollHeight`, 描述区 `max-height = lineHeight × 5`).**站级判据说"不命中策略 D",块级约束照样在**--两件事要分开问.

**2) 建检查方法--实测量级, 以及"同一个盒子三个判定标准"的正反两面:**

- **实测量级**(同一批公式两侧都对得上; 量本身就说明"1px 会显形"):**桌面 1728×1080**--画框台 **734px**, 无框 **518px**(`refDim 864 × 0.60`), 面板容器**内联** **221px**(== 活动面板 `scrollHeight`), 描述区截断 **121.77px**(`lineHeight 24.35 × 5`);**移动 390×844**--画框台 **332px**, 面板容器**内联 179px** 而**计算值 650px**(同一个盒子两个判定标准差 471px,原因见下条), 描述区截断 **108.24px**;房间视图小墙 / 大墙 **156 / 404px**(**这一组当初没记视口, 按下条只能当形态证据读**);

> **实证**:上面那块面板在 390×844 下**内联 179px, 计算值 650px**--主题 CSS 在 `<750px` 用 `.pdp-card__panels { height: auto !important }` 把这套高度算术**整条盖掉**(同一段代码在桌面完全是活的).检查的第一版断计算值,**红在镜像侧**--按分诊表即"检查错"(`verification-gates.md` §0.1),而它真正撞见的是这条 CSS;改断**内联产物**后两侧齐平, 另记 `mobileStacked` / `computedFollowsInline` 两个派生判定.

> **反面实证(本节自己的旧记录)**:上一版这一行写的是"面板容器高 **221 / 564px**",既没写视口也没写判定标准, 更没写它取自哪一个活动面板. 下一个里程碑在固定视口下复测:221 对上了,**564 一个判定标准都对不上**(桌面 221 / 移动内联 179 / 移动计算 650)--**无法判断是视口不同, 判定标准不同还是活动面板不同, 只能作废重测**.裸数字连"它错了"都证明不了.

## 6. 常见坑(各策略通用)

规则见 `dom-shell-strategies.md` §6 坑 9.

 **但下限管的是"这条变换还活着",不是"它达成了目的"--这两件事会分家.** 实证[objectarchive]:一条清除第三方标识符的变换 `T-IDENT` 跑满 **25 次**, 过了下限, 外壳字节检查全部通过, 而它要清的那个 Storefront token **仍然躺在全部 5 份产出里**--同一个 token 还有第二种写法(`"accessToken":"…"` 之外还有 `<meta name="shopify-checkout-api-token">`),而规则清单是照着一份**散文描述**写的, 从没人枚举过这一类.
