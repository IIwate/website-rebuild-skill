#!/usr/bin/env node
/**
 * Recover MDX from decoded Flight trees using project-specific shape mappings.
 * Configure LINK_CLASS, SHAPE, FIRST_PARTY and root metadata for the target site.
 * Recognized Markdown nodes become Markdown; known component shapes become JSX;
 * other nodes use literal JSX. Unsupported props fail instead of being omitted.
 * Preserves significant text whitespace and heading IDs. Verify the generated
 * output against the captured tree; this is not an original-source recovery.
 * The rauchg case recorded 17 generated pages and 18/18 normalized route checks.
 *
 *   node tools/flight-to-mdx.mjs [--flight docs/flight] [--out rebuild/app] [--mirror mirror] [--only <slug-prefix>]
 */
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { cli } from "../scripts/lib/cli.mjs";

cli({ known: ["flight", "out", "mirror", "only"], file: import.meta.url });

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf("--" + n);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const FLIGHT = flag("flight", "docs/flight");
const OUT = flag("out", "rebuild/app");
const MIRROR = flag("mirror", "mirror");
const ONLY = flag("only", null);

const LINK_CLASS =
  "border-b text-gray-600 border-gray-300 transition-[border-color] hover:border-gray-600 dark:text-white dark:border-stone-600 dark:hover:border-white ";

const isEl = (v) => Array.isArray(v) && v[0] === "$" && v.length >= 4;
const tagOf = (v) => (typeof v[1] === "string" ? v[1] : v[1] && (v[1].$component || v[1].$symbol) || "?");
const propsOf = (v) => v[3] || {};
const kidsOf = (v) => propsOf(v).children;

/**
 * Find page seeds through parallel-route children, not arbitrary nested fragments. The next-for-vercel case had deeper keyed fragments inside a react-tweet media grid.
 */
function pageSeedOf(tree) {
  let cur = tree.f[0][1];
  let lastNode = null;
  while (cur) {
    let node = null, next = null;
    if (isEl(cur)) { node = cur; }
    else if (Array.isArray(cur)) {
      node = cur.find(isEl) || null;
      const cont = cur.find((x) => x && typeof x === "object" && !Array.isArray(x) && x.children !== undefined);
      next = cont ? cont.children : null;
    } else if (cur && typeof cur === "object" && cur.children !== undefined) {
      next = cur.children;
    }
    if (node) lastNode = node;
    cur = next;
  }
  return lastNode;
}

/**
 * Collect text within the tree.
 */
function textOf(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (isEl(v)) return textOf(kidsOf(v));
  if (Array.isArray(v)) return v.map(textOf).join("");
  if (v && typeof v === "object" && v.children !== undefined) return textOf(v.children);
  return "";
}

function jsonOf(v) { return JSON.stringify(v); }

// ---------------------------------------------------------------------------
// Shared JSX serialization for literal nodes and component calls.
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function jsxProps(props, ctx) {
  const parts = [];
  for (const [k, v] of Object.entries(props)) {
    if (k === "children") continue;
    if (v === undefined) continue;
    if (v && typeof v === "object" && v.$undefined) continue;
    if (!IDENT.test(k) && !/^[a-zA-Z-]+$/.test(k)) throw new Error(`prop 名不可序列化: ${k}`);
    if (v === true) { parts.push(k); continue; }
    if (typeof v === "string") {
      // Use JSON string literals for multiline values. MDX indentation processing
      // changed six leading spaces to four in the golf pre className fixture.
      if (v.includes("\n") || v.includes('"')) parts.push(`${k}={${jsonOf(v)}}`);
      else parts.push(`${k}="${v}"`);
      continue;
    }
    if (typeof v === "number" || v === false || v === null) { parts.push(`${k}={${jsonOf(v)}}`); continue; }
    if (typeof v === "object") {
      // Emit page imports for static image objects, copying assets from the mirror.
      if (v.src && String(v.src).startsWith("/_next/static/media/")) {
        const imp = ctx.addStaticImage(v.src);
        parts.push(`${k}={${imp}}`);
        continue;
      }
      parts.push(`${k}={${jsonOf(v)}}`);
      continue;
    }
    throw new Error(`prop 不可序列化: ${k}=${typeof v}`);
  }
  return parts.length ? " " + parts.join(" ") : "";
}
function templ(s) {
  return "`" + s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`";
}

// ---------------------------------------------------------------------------
// Recover inline Markdown.
function escapeMd(s) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/([*_`[\]<>{}])/g, "\\$1")
    .replace(/&(?=[a-zA-Z#])/g, "\\&");
}
function mdInlinable(kids) {
  const arr = isEl(kids) ? [kids] : Array.isArray(kids) ? kids : [kids];
  return arr.every((k) =>
    typeof k === "string" ||
    (isEl(k) && ["strong", "em", "code", "b", "s"].includes(tagOf(k)) && mdInlinable(kidsOf(k)))
  );
}

function inline(v, ctx) {
  if (typeof v === "string") return escapeMd(v);
  if (typeof v === "number") return String(v);
  if (Array.isArray(v) && !isEl(v)) return v.map((x) => inline(x, ctx)).join("");
  if (!isEl(v)) {
    if (v && typeof v === "object" && v.$undefined) return "";
    throw new Error("内联遇到未知节点: " + jsonOf(v)?.slice(0, 120));
  }
  const t = tagOf(v);
  const p = propsOf(v);
  const kids = kidsOf(v);
  switch (t) {
    case "strong": return "**" + inline(kids, ctx) + "**";
    case "em": return "*" + inline(kids, ctx) + "*";
    case "b": return "<b>" + inline(kids, ctx) + "</b>";
    case "s": return "<s>" + inline(kids, ctx) + "</s>";
    case "br": return "<br/>";
    case "code": {
      // A code node without the mapped class uses literal JSX in this project.
      if (p.className === undefined || (p.className && p.className.$undefined)) {
        return `<code>{${jsonOf(textOf(kids))}}</code>`;
      }
      const txt = textOf(kids);
      const fence = txt.includes("`") ? "``" : "`";
      return fence + txt + fence;
    }
    case "a": {
      if (p.className === "relative text-xs top-[-5px] no-underline" && /^#f\d+$/.test(p.href || "")) {
        ctx.use("Ref");
        const n = textOf(kids).replace(/[^0-9]/g, "");
        return `<Ref id="${n}" />`;
      }
      const plain = mdInlinable(kids);
      const extras = Object.keys(p).filter((k) => !["href", "target", "rel", "className", "children"].includes(k));
      if (p.className === LINK_CLASS && plain && !extras.length) {
        if (/&[a-z#]+;/i.test(p.href)) return `<a href={${jsonOf(p.href)}} target="_blank" rel="noopener noreferrer" className=${jsonOf(LINK_CLASS)}>${inline(kids, ctx)}</a>`;
        return `[${inline(kids, ctx)}](${p.href})`;
      }
      return ctx.jsxCompact(v);
    }
    case "(default)#86796": { // next/link
      if (p.className === LINK_CLASS && mdInlinable(kids)) return `[${inline(kids, ctx)}](${p.href})`;
      return ctx.jsxCompact(v, "Link");
    }
    default:
      return ctx.jsxCompact(v);
  }
}

// ---------------------------------------------------------------------------
// Recognize configured component shapes by className.
const SHAPE = {
  callout: "bg-gray-200 dark:bg-[#333] dark:text-gray-300 flex items-start p-3 my-6 text-base",
  figure: "my-5 flex flex-col items-center",
  caption: "block w-full text-xs my-3 font-mono text-gray-500 text-center leading-normal",
  footnotes: /^text-base before:w-\[200px\]/,
  footnote: "my-6",
  hr: /^my-8 text-center after:content/,
  snippet: /bg-gray-100[\s\S]*ml-\[-50vw\]/,
  tweetWrap: "tweet my-6",
};

function block(v, ctx) {
  if (typeof v === "string") {
    if (v.trim() === "") return null; // Preserve block separators from the captured text structure.
    return escapeMd(v);
  }
  if (Array.isArray(v) && !isEl(v)) {
    return v.map((x) => block(x, ctx)).filter((x) => x != null).join("\n\n");
  }
  if (!isEl(v)) throw new Error("块级未知节点: " + jsonOf(v)?.slice(0, 400));
  const t = tagOf(v);
  if (t === "script" && String((v[3] || {}).src || "").includes("/_next/")) return null;
  if (t === "link" && String((v[3] || {}).href || "").includes("/_next/")) return null;
  const p = propsOf(v);
  const kids = kidsOf(v);
  const cls = typeof p.className === "string" ? p.className : "";

  if (t === "p") {
    const arr = isEl(kids) ? [kids] : Array.isArray(kids) ? kids : [kids];
    const INLINE_TAGS = new Set(["em", "strong", "a", "code", "b", "s", "br", "(default)#86796"]);
    const allBlockJsx =
      arr.some(isEl) &&
      arr.every((k) =>
        typeof k === "string" ? k.trim() === "" : isEl(k) && !INLINE_TAGS.has(tagOf(k))
      );
    if (allBlockJsx) {
      // Use <P> for a paragraph containing only block JSX so MDX retains its wrapper.
      // Mixed inline content follows a different path to avoid an extra paragraph.
      ctx.use("P");
      return `<P>${arr.filter(isEl).map((k) => dispatchInsideJsx(k, ctx)).join("")}</P>`;
    }
    return inline(kids, ctx);
  }
  if (t === "h1") return "# " + headingText(kids, ctx);
  if (t === "h2") return "## " + headingText(kids, ctx);
  if (t === "h3") return "### " + headingText(kids, ctx);
  if (t === "blockquote") {
    const inner = block(kids, ctx);
    return inner.split("\n").map((l) => (l ? "> " + l : ">")).join("\n");
  }
  if (t === "ul" || t === "ol") {
    const items = (isEl(kids) ? [kids] : Array.isArray(kids) ? kids : [kids]).filter(isEl);
    return items
      .map((li, i) => {
        const marker = t === "ul" ? "- " : `${i + 1}. `;
        const inner = liContent(li, ctx);
        return marker + inner.split("\n").join("\n" + " ".repeat(marker.length));
      })
      .join("\n");
  }
  if (t === "div" && cls === "my-6") {
    const arr = isEl(kids) ? [kids] : Array.isArray(kids) ? kids : [kids];
    const els = arr.filter(isEl);
    if (els.length === 1 && tagOf(els[0]) === "pre") return block(els[0], ctx);
  }
  if (t === "pre") {
    // The configured pre>code>code shape identifies a fenced code block.
    // Other code shapes retain literal JSX; confirm these mappings per project.
    const outerCode = isEl(kids) ? kids : (Array.isArray(kids) ? kids.find(isEl) : null);
    const innerKids = outerCode ? kidsOf(outerCode) : null;
    const nested = innerKids && (isEl(innerKids) ? tagOf(innerKids) === "code" : Array.isArray(innerKids) && innerKids.length === 1 && isEl(innerKids[0]) && tagOf(innerKids[0]) === "code");
    if (nested) {
      const txt = textOf(kids);
      const fence = txt.includes("```") ? "````" : "```";
      return fence + "\n" + txt.replace(/\n$/, "") + "\n" + fence;
    }
    return ctx.jsx(v);
  }
  if (t === "div" && cls === SHAPE.callout) {
    const parts = (isEl(kids) ? [kids] : Array.isArray(kids) ? kids : [kids]).filter(isEl);
    const emoji = textOf(parts[0]);
    let body = kidsOf(parts[1]); if (isEl(body)) body = [body];
    ctx.use("Callout");
    const bodyStr = typeof body === "string" && !/[<>{}]/.test(body)
      ? `text="${body.replace(/"/g, '&quot;')}"`
      : `text={<>${(Array.isArray(body) ? body : [body]).map((x) => inlineJsxText(x, ctx)).join("")}</>}`;
    return `<Callout emoji="${emoji}" ${bodyStr} />`;
  }
  if (t === "span" && cls === SHAPE.figure) { ctx.use("Figure"); return `<Figure>\n  ${jsxChildren(kids, ctx, "  ")}\n</Figure>`; }
  if (t === "span" && cls === SHAPE.caption) return captionOf(v, ctx);
  if (t === "div" && SHAPE.footnotes.test(cls)) {
    ctx.use("FootNotes");
    // Preserve captured footnote separators; two source posts differed in whether
    // they included a newline text node. Emit strings as explicit JSON expressions.
    const rawArr = isEl(kids) ? [kids] : Array.isArray(kids) ? kids : [kids];
    const pieces = rawArr.map((n) => {
      if (typeof n === "string") return n === "" ? null : `{${jsonOf(n)}}`;
      if (!isEl(n)) return null;
      // Footnote paragraph shape: ["1", ".", " ", <a href="#sN" id="fN">^</a>, " ", content].
      if (tagOf(n) === "p") {
        const arr = kidsOf(n);
        if (Array.isArray(arr) && typeof arr[0] === "string" && arr[1] === "." &&
            isEl(arr[3]) && tagOf(arr[3]) === "a" && /^#s\d+$/.test(propsOf(arr[3]).href || "")) {
          ctx.use("FootNote");
          const num = arr[0];
          const content = arr.slice(5);
          return `<FootNote id="${num}">${inline(content, ctx)}</FootNote>`;
        }
      }
      return block(n, ctx);
    }).filter((x) => x != null);
    return `<FootNotes>\n${pieces.join("\n")}\n</FootNotes>`;
  }
  if (t === "div" && SHAPE.hr.test(cls)) { ctx.use("HR"); return "<HR />"; }
  if (t === "div" && SHAPE.snippet.test(cls)) {
    ctx.use("Snippet");
    const inner = kidsOf(isEl(kids) ? kids : kids.find(isEl)); // Inner max-w-2xl content.
    // Retain literal JSX where the source component bypasses MDX component mappings.
    return `<Snippet>\n  ${jsxChildren(inner, ctx, "  ")}\n</Snippet>`;
  }
  if (t === "div" && cls === SHAPE.tweetWrap) {
    const m = jsonOf(v).match(/status\\?\/(\d{8,})/);
    if (!m) throw new Error("tweet 包装里找不到 status id");
    ctx.use("Tweet");
    const arr = isEl(kids) ? [kids] : Array.isArray(kids) ? kids : [kids];
    const cap = arr.find((k) => isEl(k) && tagOf(k) === "span" && propsOf(k).className === SHAPE.caption);
    if (cap) {
      let inner = kidsOf(cap);
      if (isEl(inner) && tagOf(inner) === "default#90777") inner = kidsOf(inner);
      if (isEl(inner) && tagOf(inner) === "span" && propsOf(inner).className === "[&>a]:post-link") inner = kidsOf(inner);
      const capStr = (Array.isArray(inner) && !isEl(inner) ? inner : [inner]).map((x) => inlineJsxText(x, ctx)).join("");
      if (/[<>{}]/.test(capStr)) return `<Tweet id="${m[1]}" caption={<>${capStr}</>} />`;
      return `<Tweet id="${m[1]}" caption="${capStr.replace(/"/g, '&quot;')}" />`;
    }
    return `<Tweet id="${m[1]}" />`;
  }
  // Fallback to literal JSX.
  return ctx.jsx(v);
}

function liContent(li, ctx) {
  const kids = kidsOf(li);
  // List items can contain inline text or loose block content (li > p).
  const arr = isEl(kids) ? [kids] : Array.isArray(kids) ? kids : [kids];
  const hasBlock = arr.some((k) => isEl(k) && ["ul", "ol", "p", "blockquote", "pre", "div"].includes(tagOf(k)));
  if (!hasBlock) return inline(kids, ctx);
  // Recover loose items block by block; the list emitter supplies continuation indentation.
  const blocks = [];
  for (const k of arr) {
    if (typeof k === "string") { if (k.trim() !== "") blocks.push(escapeMd(k)); continue; }
    if (!isEl(k)) continue;
    blocks.push(block(k, ctx));
  }
  return blocks.filter((b) => b != null && b !== "").join("\n\n");
}

function headingText(kids, ctx) {
  // Invert the configured heading wrapper into text [#id]; plain strings remain plain.
  const arr = isEl(kids) ? [kids] : Array.isArray(kids) ? kids : [kids];
  return arr
    .map((k) => {
      if (typeof k === "string") return escapeMd(k);
      if (isEl(k) && tagOf(k) === "span" && propsOf(k).className === "relative") {
        const inner = kidsOf(k);
        const parts = Array.isArray(inner) ? inner : [inner];
        const idA = parts.find((x) => isEl(x) && tagOf(x) === "a" && propsOf(x).id);
        const text = parts.filter((x) => typeof x === "string").join("");
        if (idA) return escapeMd(text) + `[#${propsOf(idA).id}]`;
        return escapeMd(text);
      }
      return inline(k, ctx);
    })
    .join("");
}

function captionOf(v, ctx) {
  // span.caption > Balancer > span.[&>a]:post-link > children
  ctx.use("Caption");
  let inner = kidsOf(v);
  if (isEl(inner) && tagOf(inner) === "default#90777") inner = kidsOf(inner);
  if (isEl(inner) && tagOf(inner) === "span" && propsOf(inner).className === "[&>a]:post-link") inner = kidsOf(inner);
  return `<Caption>${(Array.isArray(inner) ? inner : [inner]).map((x) => inlineJsxText(x, ctx)).join("")}</Caption>`;
}

/**
 * Render inline content in JSX context without Markdown text escaping.
 */
function inlineJsxText(v, ctx) {
  if (typeof v === "string") return v.replace(/([<>{}])/g, (c) => ({ "<": "&lt;", ">": "&gt;", "{": "&#123;", "}": "&#125;" }[c]));
  if (typeof v === "number") return `{${v}}`;
  if (Array.isArray(v) && !isEl(v)) return v.map((x) => inlineJsxText(x, ctx)).join("");
  if (!isEl(v)) { if (v && v.$undefined) return ""; throw new Error("JSX 内联未知节点"); }
  // MDX can map lowercase tags to components in expression contexts such as captions.
  // Emit minimal LINK_CLASS anchors; the mapped A component supplies their attributes.
  if (tagOf(v) === "a" && propsOf(v).className === LINK_CLASS) {
    const inner = kidsOf(v);
    const innerStr = (isEl(inner) ? [inner] : Array.isArray(inner) ? inner : [inner])
      .map((x) => inlineJsxText(x, ctx)).join("");
    return `<a href=${jsonOf(propsOf(v).href)}>${innerStr}</a>`;
  }
  return ctx.jsxCompact(v);
}

function jsxChildren(kids, ctx, pad) {
  const arr = isEl(kids) ? [kids] : Array.isArray(kids) ? kids : [kids];
  return arr
    .map((k) => {
      if (typeof k === "string") {
        // Emit text children as JSON expressions to avoid MDX adding paragraph wrappers.
        // This matters for the-ai-cloud tables and whitespace in the 2019 terminal block.
        // Explicit expressions preserve the recorded text bytes.
        return `{${jsonOf(k)}}`;
      }
      if (typeof k === "number") return `{${k}}`;
      if (typeof k === "boolean") return `{${k}}`; // Preserve boolean results of conditional children.
      if (k && typeof k === "object" && !Array.isArray(k) && k.$undefined) return "{undefined}";
      if (k && typeof k === "object" && !Array.isArray(k) && k.$component === "DEMO_CODE#24956") { ctx.use("fp:DEMO_CODE#24956"); return "{DEMO_CODE}"; }
      return isEl(k) ? dispatchInsideJsx(k, ctx) : null;
    })
    .filter((x) => x != null && x !== "")
    .join("\n" + pad);
}

/**
 * Recognized components such as Caption still use component emission inside literal JSX.
 */
function dispatchInsideJsx(v, ctx) {
  const cls = typeof propsOf(v).className === "string" ? propsOf(v).className : "";
  const t = tagOf(v);
  if (t === "span" && cls === SHAPE.caption) return captionOf(v, ctx);
  if (t === "span" && cls === SHAPE.figure) { ctx.use("Figure"); return `<Figure>\n  ${jsxChildren(kidsOf(v), ctx, "  ")}\n</Figure>`; }
  if (t === "div" && cls === SHAPE.tweetWrap) return block(v, ctx);
  return ctx.jsx(v);
}

// ---------------------------------------------------------------------------
function indent(s, pad) { return s.split("\n").map((l) => (l ? pad + l : l)).join("\n"); }

// Map first-party client references to component names and import paths.
const FIRST_PARTY = {
  "Demo#33006": ["Demo", "pure-ui-demo"],
  "Demos#33006": ["Demos", "pure-ui-demo"],
  "Demo#24956": ["Demo", "golf-demo"],
  "DEMO_CODE#24956": ["DEMO_CODE", "golf-demo"],
  "YouTube#18165": ["YouTube", "youtube"],
  "Chart#92951": ["Chart", "chart"],
};

function makeCtx(slug) {
  const usedComponents = new Set();
  const staticImages = new Map(); // mirrorPath -> {name, file}
  const ctx = {
    use: (n) => usedComponents.add(n),
    usedComponents,
    staticImages,
    addStaticImage(src) {
      if (!staticImages.has(src)) {
        const base = path.basename(src).replace(/\.[0-9a-f]{8}(?=\.[a-z0-9]+$)/i, ""); // Remove the recognized content-hash segment.
        const name = "img" + (staticImages.size + 1) + "_" + base.replace(/[^a-zA-Z0-9]/g, "_").replace(/_[a-z0-9]+$/, "");
        staticImages.set(src, { name, file: base });
      }
      return staticImages.get(src).name;
    },
    jsxCompact(v, forcedName) {
      const t = tagOf(v);
      let name = forcedName || t;
      if (FIRST_PARTY[t]) { name = FIRST_PARTY[t][0]; ctx.use("fp:" + t); }
      else if (t === "Image#60547") { name = "Image"; ctx.use("Image"); }
      else if (t === "(default)#86796") { name = "Link"; ctx.use("__nextlink"); }
      else if (t === "default#90777") { name = "Balancer"; ctx.use("__balancer"); }
      else if (t.includes("#")) throw new Error(`未识别客户端组件: ${t}`);
      const p = propsOf(v);
      const kids = kidsOf(v);
      const keyAttr2 = typeof v[2] === "string" && !/^\.?\d+$/.test(v[2]) ? ` key=${jsonOf(v[2])}` : "";
      const open = `<${name}${keyAttr2}${jsxProps(p, ctx)}`;
      if (kids === undefined || (Array.isArray(kids) && !isEl(kids) && kids.length === 0)) return open + " />";
      const arr = isEl(kids) ? [kids] : Array.isArray(kids) ? kids : [kids];
      const inner = arr.map((k) => {
        if (typeof k === "string") return inlineJsxText(k, ctx);
        if (typeof k === "number") return `{${k}}`;
        if (k && typeof k === "object" && !Array.isArray(k) && k.$component === "DEMO_CODE#24956") { ctx.use("fp:DEMO_CODE#24956"); return "{DEMO_CODE}"; }
        if (k && typeof k === "object" && !Array.isArray(k) && k.$undefined) return "{undefined}";
        if (isEl(k) && tagOf(k) === "a" && propsOf(k).className === LINK_CLASS) return inlineJsxText(k, ctx);
        return isEl(k) ? ctx.jsxCompact(k) : "";
      }).join("");
      if (!inner) return open + " />";
      return `${open}>${inner}</${name}>`;
    },
    jsx(v, forcedName) {
      const t = tagOf(v);
      let name = forcedName || t;
      if (FIRST_PARTY[t]) { name = FIRST_PARTY[t][0]; ctx.use("fp:" + t); }
      else if (t === "Image#60547") { name = "Image"; ctx.use("Image"); }
      else if (t === "(default)#86796") { name = "Link"; ctx.use("__nextlink"); }
      else if (t === "default#90777") { name = "Balancer"; ctx.use("__balancer"); }
      else if (t.includes("#")) throw new Error(`未识别客户端组件: ${t}(${slug})`);
      const p = propsOf(v);
      const kids = kidsOf(v);
      const keyAttr = typeof v[2] === "string" && !/^\.?\d+$/.test(v[2]) ? ` key=${jsonOf(v[2])}` : "";
      const open = `<${name}${keyAttr}${jsxProps(p, ctx)}`;
      if (kids === undefined || (Array.isArray(kids) && kids.length === 0)) return open + " />";
      const inner = jsxChildren(kids, ctx, "  ");
      if (!inner) return open + " />";
      return `${open}>${inner.includes("\n") ? "\n  " + inner + "\n" : inner}</${name}>`;
    },
  };
  return ctx;
}

// ---------------------------------------------------------------------------
async function invert(slugFile) {
  const j = JSON.parse(await readFile(path.join(FLIGHT, slugFile), "utf8"));
  const route = j.route; // e.g. /2020/static-hoisting/
  const seed = pageSeedOf(j.tree);
  if (!seed) throw new Error("找不到页面种子: " + slugFile);
  const kids = (Array.isArray(kidsOf(seed)) ? kidsOf(seed) : [kidsOf(seed)]).filter((k) => {
    if (isEl(k) && tagOf(k) === "script" && propsOf(k).async) return false;
    if (isEl(k) && tagOf(k) === "script" && String(propsOf(k).src || "").includes("/_next/")) return false;
    if (isEl(k) && tagOf(k) === "link" && String(propsOf(k).href || "").includes("/_next/")) return false;
    if (isEl(k) && String(tagOf(k)).startsWith("OutletBoundary")) return false;
    return true;
  });

  const ctx = makeCtx(route);
  const blocks = [];
  for (const k of kids) {
    const b = block(k, ctx);
    if (b != null && b !== "") blocks.push(b);
  }

  // Recover metadata from the head entry f[0][2].
  const head = j.tree.f[0][2];
  const metas = {};
  (function walk(v) {
    if (isEl(v)) {
      const t = tagOf(v), p = propsOf(v);
      if (t === "title" && typeof p.children === "string") metas.title = p.children;
      if (t === "meta" && p.name === "description") metas.description = p.content;
      if (t === "meta" && p.property === "og:image") metas.ogImage = p.content;
      if (t === "meta" && p.property === "og:title") metas.ogTitle = p.content;
      if (t === "link" && p.rel === "alternate" && p.hrefLang) (metas.alternates ||= {})[p.hrefLang] = p.href;
      walk(kidsOf(v)); return;
    }
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object" && v.children !== undefined) walk(v.children);
  })(head);

  // Output path.
  let rel;
  if (route === "/about/") rel = "about/page.mdx";
  else rel = path.join("(post)", route.replace(/^\/|\/$/g, ""), "page.mdx");
  const outFile = path.join(OUT, rel);
  await mkdir(path.dirname(outFile), { recursive: true });

  // Imports and metadata declarations.
  const depth = rel.split("/").length - 1;
  const up = "../".repeat(depth);
  const compImports = [...ctx.usedComponents].filter((c) => !c.startsWith("__") && !c.startsWith("fp:") && c !== "Tweet" && c !== "Image");
  const lines = [];
  if (compImports.length) lines.push(`import { ${compImports.sort().join(", ")} } from "${up}components/mdx";`);
  if (ctx.usedComponents.has("Image")) lines.push(`import Image from "next/image";`);
  if (ctx.usedComponents.has("Tweet")) lines.push(`import { Tweet } from "${up}components/tweet";`);
  if (ctx.usedComponents.has("__nextlink")) lines.push(`import Link from "next/link";`);
  if (ctx.usedComponents.has("__balancer")) lines.push(`import Balancer from "react-wrap-balancer";`);
  for (const c of ctx.usedComponents) {
    if (c.startsWith("fp:")) {
      const [name, file] = FIRST_PARTY[c.slice(3)];
      lines.push(`import { ${name} } from "${up}components/${file}";`);
    }
  }
  for (const [src, { name, file }] of ctx.staticImages) {
    lines.push(`import ${name} from "./${file}";`);
    const mirrorFile = path.join(MIRROR, src.replace(/^\//, ""));
    await copyFile(mirrorFile, path.join(path.dirname(outFile), file)).catch((e) => {
      throw new Error(`静态图拷贝失败 ${mirrorFile}: ${e.message}`);
    });
  }
  if (route === "/2015/pure-ui/")
    lines.push(`import "${up}components/pure-ui.css"; // 页级样式(镜像 367b5958,该页 HL 多一条 css 为证)`);
  if (lines.length) lines.push("");
  const ROOT_TITLE = "Guillermo Rauch's blog";
  const ROOT_DESC = "Guillermo Rauch is the CEO and founder of Vercel, a software engineer, and the creator of Next.js, Mongoose, Socket.io and other open source libraries.";
  const md = { title: metas.title, description: metas.description };
  const og = metas.ogImage ? new URL(metas.ogImage).pathname : null;
  const inheritsAll = md.title === ROOT_TITLE && (md.description === ROOT_DESC || !md.description) && (!og || og === "/opengraph-image");
  if (inheritsAll) {
    // The golf page inherited root metadata; do not invent page-specific metadata.
  } else {
  lines.push("export const metadata = {");
  lines.push(`  title: ${jsonOf(md.title)},`);
  if (md.description && md.description !== ROOT_DESC) lines.push(`  description: ${jsonOf(md.description)},`);
  lines.push(`  openGraph: {`);
  lines.push(`    title: ${jsonOf(metas.ogTitle ?? md.title)},`);
  if (md.description && md.description !== ROOT_DESC) lines.push(`    description: ${jsonOf(md.description)},`);
  if (og) lines.push(`    images: [${jsonOf(og)}],`);
  lines.push(`  },`);
  if (metas.alternates) {
    lines.push(`  alternates: {`);
    lines.push(`    languages: ${jsonOf(metas.alternates)},`);
    lines.push(`  },`);
  }
  lines.push("};");
  lines.push("");
  }

  const body = blocks.join("\n\n");
  await writeFile(outFile, lines.join("\n") + "\n" + body + "\n");
  return { route, outFile, blocks: blocks.length, components: [...ctx.usedComponents] };
}

const { readdirSync } = await import("node:fs");
const files = readdirSync(FLIGHT)
  .filter((f) => f.endsWith(".json") && !["index.json", "csscss.json"].includes(f))
  .filter((f) => !ONLY || f.startsWith(ONLY));
let ok = 0, fail = 0;
for (const f of files.sort()) {
  try {
    const r = await invert(f);
    console.log(`ok   ${r.route}  blocks:${r.blocks}  comps:${r.components.filter((c) => !c.startsWith("__")).join(",") || "-"}`);
    ok++;
  } catch (e) {
    console.log(`FAIL ${f}: ${e.message}`); if (process.env.STACK) console.log(e.stack.split('\n').slice(1,8).join('\n'));
    fail++;
  }
}
console.log(`\n${ok} ok, ${fail} fail`);
if (fail) process.exit(1);
