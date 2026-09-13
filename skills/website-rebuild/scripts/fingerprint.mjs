#!/usr/bin/env node
/**
 * Collect website reconnaissance evidence using Node APIs.
 * Records GET redirect chains, two response samples, HTML markers and bundle
 * statistics. Counts occurrences rather than matching lines. Classification is
 * left to the caller; markers and two equal samples are not conclusive evidence.
 * Small bundles are retried with Referer, then still require content inspection.
 * Cases: kprverse had different HEAD/GET results; landonorris returned a 32-byte
 * refusal; darknetflix redirected to netflix.com. These are observations, not
 * universal failure rules. Downloads include size and SHA-256 records.
 *
 *   node scripts/fingerprint.mjs --target https://example.com/awarded-path
 *   node scripts/fingerprint.mjs --target https://example.com/awarded-path --bundle https://example.com/assets/main.js [--out probe] [--gap-ms 5000]
 */


import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256 } from "./lib/hash.mjs";
// Use the same BROWSER_UA as the capture helpers.
import { sanityEvidence, BROWSER_UA as UA } from "./lib/negotiate.mjs";
import { cli } from "./lib/cli.mjs";

cli({ known: ["target", "bundle", "out", "gap-ms"], file: import.meta.url });

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const TARGET = flag("target");
if (!TARGET) {
  console.error(
    "usage: fingerprint.mjs --target <url> [--bundle <url>[,<url>...]] [--out probe] [--gap-ms 5000]",
  );
  process.exit(2);
}
const OUT = path.resolve(flag("out", "probe"));
const GAP_MS = Math.max(1000, Number(flag("gap-ms", "5000")) || 5000);
const BUNDLES = (flag("bundle", "") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Count occurrences rather than matching lines.
const count = (s, re) => (s.match(re) || []).length;
const uniq = (arr) => [...new Set(arr)];
const stripWww = (h) => h.replace(/^www\./i, "");

const ledger = []; // {file, bytes, sha256, url}
const report = [];
const say = (line = "") => {
  report.push(line);
  console.log(line);
};

/** GET with manual redirect following (each hop recorded), 30s timeout. */
async function getManual(url, extraHeaders = {}) {
  const hops = [];
  let cur = url;
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) {
    const res = await fetch(cur, {
      redirect: "manual",
      headers: { "user-agent": UA, ...extraHeaders },
      signal: AbortSignal.timeout(30000),
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location") || "";
      hops.push({ url: cur, status: res.status, location: loc });
      await res.arrayBuffer().catch(() => {});
      if (!loc) break;
      cur = new URL(loc, cur).href;
      await sleep(1100);
      continue;
    }
    const body = Buffer.from(await res.arrayBuffer());
    return {
      finalUrl: cur,
      status: res.status,
      body,
      contentType: res.headers.get("content-type") || "",
      hops,
      ms: Math.round(performance.now() - t0),
    };
  }
  return {
    finalUrl: cur,
    status: 0,
    body: Buffer.alloc(0),
    contentType: "",
    hops,
    ms: Math.round(performance.now() - t0),
    error: "redirect chain >10 hops or missing Location",
  };
}

function saveArtifact(name, buf, url) {
  const p = path.join(OUT, name);
  writeFileSync(p, buf);
  ledger.push({ file: name, bytes: buf.length, sha256: sha256(buf), url });
}

/** Naive positional diff: only for locating the FIRST divergence points.
 *  An insertion shifts everything after it — fine as evidence, not as a diff tool. */
function diffSpans(a, b, max = 5) {
  const spans = [];
  const n = Math.min(a.length, b.length);
  let k = 0;
  while (k < n && spans.length < max) {
    if (a[k] !== b[k]) {
      const start = k;
      let equalRun = 0;
      let end = k;
      while (end < n && equalRun < 40) {
        equalRun = a[end] === b[end] ? equalRun + 1 : 0;
        end++;
      }
      const ctx = (s) =>
        s
          .slice(Math.max(0, start - 30), Math.min(s.length, end))
          .replace(/\s+/g, " ")
          .slice(0, 160);
      spans.push({ at: start, a: ctx(a), b: ctx(b) });
      k = end;
    } else k++;
  }
  return spans;
}

async function main() {
  say(`# fingerprint report — ${TARGET}`);
  say();
  say(`- 探测时间：${new Date().toISOString()}`);
  say(`- UA: Chrome/126 桌面请求头; 顺序请求, 相邻采样保留间隔`);
  say(
    `- 本报告记录响应和源码标记. 可行性需结合目标行为与可获得的实现判断, 见 references/scope-and-fingerprint.md.`,
  );
  say(
    `  计数为文本出现次数, 包含 vendor 内容; 不能直接代表实际使用或业务复杂度.`,
  );
  say();

  // Step 1: GET status and redirect chain for the target path.
  say(`## 步骤 1: 目标路径的 GET 响应与重定向`);
  let first;
  try {
    first = await getManual(TARGET);
  } catch (e) {
    say(`- GET 失败：${e.message}`);
    say(`- 此次请求不可达, 需区分 DNS、TLS、超时与目标版本失效. 单次失败不足以判定站点已下线.`);
    finish(2);
    return;
  }
  say(
    `- code=${first.status} final=${first.finalUrl} redirects=${first.hops.length} time=${first.ms}ms bytes=${first.body.length}`,
  );
  for (const h of first.hops) say(`  - hop: ${h.status} ${h.url} -> ${h.location}`);
  if (first.error) say(`-  ${first.error}`);
  const tHost = stripWww(new URL(TARGET).hostname);
  const fHost = stripWww(new URL(first.finalUrl).hostname);
  if (tHost !== fHost)
    say(
      `- 最终主机 ${fHost} 与目标主机 ${tHost} 不同. 核实是否为正常跨域跳转、域名变更或目标版本替换.`,
    );
  if (first.status === 404)
    say(`- 目标路径返回 GET 404. 核对路径与目标版本; 该结果不代表其他路由或全部存档均不可用.`);
  saveArtifact("a.html", first.body, TARGET);
  const aText = first.body.toString("utf8");
  say();

  // Step 2: compare two response samples.
  say(`## 步骤 2: 两次响应比较, 间隔 ${GAP_MS}ms`);
  await sleep(GAP_MS);
  let second;
  try {
    second = await getManual(TARGET);
    saveArtifact("b.html", second.body, TARGET);
  } catch (e) {
    say(`- 第二抓失败：${e.message}（确定性未取证）`);
  }
  if (second) {
    if (first.body.equals(second.body)) {
      say(`- BYTE-IDENTICAL: 这两次响应的正文相同, 不代表其他请求或交互状态均相同.`);
    } else {
      const bText = second.body.toString("utf8");
      const mismatch = diffSpans(aText, bText, 5);
      say(`- 不逐字节相同：a=${first.body.length}B b=${second.body.length}B（差 ${Math.abs(first.body.length - second.body.length)}B）`);
      for (const s of mismatch) {
        say(`  - 首个分歧点@${s.at}:`);
        say(`    a: ${s.a}`);
        say(`    b: ${s.b}`);
      }
      say(
        `- 核对差异来自 nonce、轮换标识、时间、内容或结构. 归一化需有明确依据; 响应变化本身不能决定目标行为是否可恢复.`,
      );
      say(`  此处按字符位置比较, 插入会造成后续错位. 详细差异可对 a.html 和 b.html 使用文本 diff.`);
    }
  }
  say();

  // Step 3: inspect site and version markers.
  say(`## 步骤 3: 站点身份与版本线索`);
  const generators = aText.match(/<meta[^>]+name=["']generator["'][^>]*>/gi) || [];
  say(`- generator meta：${generators.length ? "" : "无"}`);
  for (const g of generators.slice(0, 5)) say(`  - ${g.replace(/\s+/g, " ").slice(0, 160)}`);
  say(`- wp-content 出现次数：${count(aText, /wp-content/g)}`);
  const years = uniq(
    (aText.match(/(?:Copyright|\u00a9|&copy;)[^<]{0,80}(?:19|20)\d{2}/gi) || []).map((s) =>
      s.replace(/\s+/g, " ").trim().slice(0, 120),
    ),
  );
  say(`- 版权/年份字串（前 8 条）：${years.length ? "" : "无"}`);
  for (const y of years.slice(0, 8)) say(`  - ${y}`);
  say(
    `- 平台与主题名称 (shopify|Prestige|Dawn|elementor, 忽略大小写): ${count(aText, /shopify|prestige|dawn|elementor/gi)}`,
  );
  say(
    `- Shopify 标记: cdn/shop/=${count(aText, /cdn\/shop\//g)}  Shopify.theme=${count(aText, /Shopify\.theme/g)}  cdn.shopify.com=${count(aText, /cdn\.shopify\.com/g)}  myshopify.com=${count(aText, /myshopify\.com/g)}; 实际平台依赖见 references/shopify-platform.md`,
  );
  // Collect Sanity markers after normalizing plain, JSON-escaped and URL-encoded forms.
  const sanity = sanityEvidence(aText);
  if (sanity.projects.length || sanity.apiHosts.length || sanity.cdnRefs) {
    say(`- Sanity CMS 标记, 数据形态与获取时点见 references/sanity-platform.md:`);
    say(`  - cdn.sanity.io 出现 ×${sanity.cdnRefs}${sanity.cdnRefs && !sanity.projects.length ? "; 仅识别到主机引用, 未从当前响应提取出项目路径, 需检查相关路由与调用点" : ""}`);
    for (const p of sanity.projects)
      say(`  - projectId=${p.projectId} dataset=${p.dataset}（引用 ×${p.n}）`);
    for (const h of sanity.apiHosts)
      say(`  - API 主机 ${h.host} ×${h.n}; 主机名称不足以证明存在运行时数据依赖, 需观察实际请求与使用点`);
    say(`  - auto=format ×${sanity.autoFormat}${sanity.autoFormat ? "; 请求 Accept 可能影响返回格式, 采集时记录协商条件, 见 sanity-platform.md §1.2" : ""}`);
    say(`  - "_key" 字段 ×${sanity.keyFields}; 可能参与数组项身份, 需核实后决定比较方式`);
    say(`  - 将目标范围内实际使用的 CDN/API 主机纳入采集范围; next/image URL 需解码 url= 参数以识别来源`);
  } else {
    say(`- Sanity CMS 指纹：无`);
  }
  say(
    `- 核对当前页面是否为目标版本. generator、版权年份和框架标记仅提供线索, 需与目标时期的页面或资源证据对照.`,
  );
  say();

  // Step 4: inspect HTML framework and script markers.
  say(`## 步骤 4：技术指纹（HTML 层，已剥注释；计数=出现次数）`);
  const noComment = aText.replace(/<!--[\s\S]*?-->/g, "");
  const scripts = uniq(
    [...noComment.matchAll(/<script\b[^>]*?\ssrc=["']([^"']+)["']/gi)].map((m) => m[1]),
  );
  say(`- <script src> 枚举（${scripts.length} 条）：`);
  for (const s of scripts.slice(0, 40)) say(`  - ${s}`);
  if (scripts.length > 40) say(`  - …（其余 ${scripts.length - 40} 条见 a.html）`);
  const inlineImports = uniq(noComment.match(/import\(\s*["'][^"']+["']\s*\)/g) || []);
  say(`- 内联动态 import()（${inlineImports.length} 条；现代站可能没有任何 <script src>）：`);
  for (const s of inlineImports.slice(0, 20)) say(`  - ${s}`);
  say(`- 框架与序列化标记, 需回到调用点核实:`);
  say(`  - self.__next_f（Next RSC flight）        = ${count(noComment, /self\.__next_f/g)}`);
  say(`  - __reactRouterContext（RR framework 模式）= ${count(noComment, /__reactRouterContext/g)}`);
  say(`  - __NUXT__（Nuxt）                         = ${count(noComment, /__NUXT__/g)}`);
  say(`  - data-v-xxxxxxxx（Vue scoped 密度）       = ${count(noComment, /data-v-[0-9a-f]{6,8}/g)}`);
  say(`  - <!--[-->（Vue3 SSR fragment 注释，剥注释前计数）= ${count(aText, /<!--\[-->/g)}`);
  say(`- 渲染与动画库标记:`);
  say(`  - theatre|@react-three = ${count(noComment, /theatre|@react-three/gi)}; 声明式 API 不决定客户端实现是否可获得`);
  say();

  // Step 5: inspect bundle contents.
  say(`## 步骤 5：bundle 可逆向性初检`);
  if (!BUNDLES.length) {
    say(`- 未传 --bundle。从上面 <script src>/import() 清单里挑主 bundle 后复跑：`);
    say(`  node fingerprint.mjs --target "${TARGET}" --bundle <bundle-url> --out ${path.basename(OUT)}`);
  }
  for (let i = 0; i < BUNDLES.length; i++) {
    const url = BUNDLES[i];
    say(`### bundle ${i + 1}: ${url}`);
    await sleep(1100);
    let r;
    try {
      r = await getManual(url);
    } catch (e) {
      say(`- GET 失败：${e.message}`);
      continue;
    }
    let refererUsed = false;
    if (r.body.length < 1024) {
      // Retry small responses with Referer; landonorris returned a 32-byte refusal.
      const refDir = TARGET.slice(0, TARGET.lastIndexOf("/") + 1);
      say(`-  响应 ${r.body.length}B <1KB，疑似拒绝页——补 Referer(${refDir}) 重试`);
      await sleep(1100);
      try {
        r = await getManual(url, { referer: refDir });
        refererUsed = true;
      } catch (e) {
        say(`- Referer 重试失败：${e.message}`);
      }
    }
    saveArtifact(`bundle-${i + 1}.js`, r.body, url);
    const text = r.body.toString("utf8");
    const lines = text.split("\n");
    let longest = 0;
    for (const l of lines) if (l.length > longest) longest = l.length;
    say(
      `- code=${r.status} bytes=${r.body.length} content-type=${r.contentType}${refererUsed ? "（带 Referer）" : ""}`,
    );
    if (/text\/html/i.test(r.contentType))
      say(`- JavaScript URL 返回 HTML. 核对状态码与正文是否为回退页、访问提示或错误响应; 摘要只能核对内容一致性.`);
    // Report the detected formatting shape separately from its interpretation.
    // A marker count alone does not establish source availability.
    say(`- 形态预检：lines=${lines.length} longest_line=${longest}`);
    say(
      longest > 5000
        ? `  最长行 ${longest} 字符, 可考虑格式化以便定位; 格式化后需核对内容`
        : `  最长行 ${longest} 字符, 共 ${lines.length} 行. 行长不能证明未压缩, 先检查可读性再决定是否格式化`,
    );

    // Distinguish a sourcemap marker, its target URL and successful retrieval.
    // One vendor bundle retained a marker after bundling, but both the referenced
    // map and the same-basename map returned 404.
    const smMatches = [...text.matchAll(/[#@]\s*sourceMappingURL=(\S+)/g)].map((m) => m[1]);
    if (!smMatches.length) {
      say(`- sourceMappingURL：无`);
    } else {
      say(`- sourceMappingURL ×${smMatches.length}：${smMatches.slice(0, 3).join("  ")}`);
      for (const rel of smMatches.slice(0, 3)) {
        let mapUrl = null;
        try {
          mapUrl = new URL(rel, url).href;
        } catch {}
        if (!mapUrl || rel.startsWith("data:")) { say(`  - ${rel} → 内联或不可解析，人工确认`); continue; }
        await sleep(1100); // politeness: the protocol is one session, low rate
        const mr = await getManual(mapUrl).catch(() => null);
        const okMap = !!mr && mr.status === 200;
        const hasContent = okMap && /"sourcesContent"\s*:\s*\[/.test(mr.body.toString("utf8").slice(0, 400000));
        say(
          `  - ${mapUrl} → HTTP ${mr ? mr.status : "ERR"}` +
            (okMap
              ? `; sourcesContent ${hasContent ? "检测到数组字段, 需解析后核对内容与覆盖" : "未在已扫描范围内检测到字段"}`
              : `; 此次未成功获取映射, 不能据此使用该 sourcemap`),
        );
        if (!/[/\\]/.test(rel)) {
          say(`     相对文件名且本 bundle 是拼接产物时，该标记可能属于被拼进来的某个库，不属于它`);
        }
      }
    }
    say(`- three 强签名（弱字符串 "three" 不算）：`);
    say(`  - WebGLRenderer        = ${count(text, /WebGLRenderer/g)}`);
    say(`  - THREE.WebGLRenderer  = ${count(text, /THREE\.WebGLRenderer/g)}（vendor 自带报错串份额 = 污染量）`);
    say(`- /api/ = ${count(text, /\/api\//g)}; 根据实际调用与目标功能决定是否需要数据快照`);
    say(`- 以上计数包含 vendor 内容, 需核实真实调用和资源依赖.`);
    say();
  }

  // Download records.
  say(`## 下载物账本（sha256）`);
  for (const l of ledger) say(`- ${l.file}  ${l.bytes}B  sha256=${l.sha256}`);
  say();
  say(`## 下一步`);
  say(`1. 按 references/scope-and-fingerprint.md 核实目标版本、行为来源与可恢复范围.`);
  say(`2. 将框架、API 与资源标记关联到实际调用, 区分客户端实现、序列化输出与外部服务.`);
  say(`3. 在已确认的目标和授权范围内继续采集, 记录未获取资源及其影响.`);

  finish(0);
}

function finish(code) {
  const p = path.join(OUT, "fingerprint-report.md");
  writeFileSync(p, report.join("\n") + "\n");
  console.log(`\n[fingerprint] report -> ${path.relative(process.cwd(), p)}`);
  process.exitCode = code;
}

main().catch((e) => {
  say(`\nFATAL: ${e.stack || e.message}`);
  finish(2);
});
