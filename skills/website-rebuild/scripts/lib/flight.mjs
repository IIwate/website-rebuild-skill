/**
 * Localize text within length-prefixed React Flight rows.
 *
 * A T row has the form <id>:T<hex>,<UTF-8 text>. Its length determines where the
 * next row begins. URL replacement changes the text's byte count, so the length
 * must be updated at the same time. Other serialized fields can have separate
 * constraints; this helper covers the supported Flight row representation.
 *
 * On eightdesign, two of 115 routes rendered 70 characters instead of 2,440
 * after response localization. The recorded failure was:
 *     TypeError: t.reason.enqueueModel is not a function
 * There were no observed 404s or request failures, and the stored HTML byte
 * counts matched. Serving the same files with python3 -m http.server restored
 * both routes, locating the defect in response transformation.
 *
 * The build and response layers share this helper so they use the same byte
 * length calculation and Flight escaping rules.
 */

/** The push shape every Next.js App Router page streams its payload through. */
const PUSH = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;

/**
 * Rewrite each row's content on its own and re-declare what it now measures.
 * Returns { text, marks } where marks map original -> repaired char offsets at
 * every row boundary, so a caller can preserve unrelated structure.
 */
export function repairFlightRows(stream, rw) {
  const buf = Buffer.from(stream, "utf8");
  const out = [];
  const marks = [];
  let i = 0, chars = 0, newChars = 0;

  const pass = (from, to) => {
    const t = rw(buf.subarray(from, to).toString("utf8"));
    out.push(t);
    chars += buf.subarray(from, to).toString("utf8").length;
    newChars += t.length;
  };

  while (i < buf.length) {
    marks.push({ o: chars, n: newChars });
    const nl = buf.indexOf(0x0a, i);
    const comma = buf.indexOf(0x2c, i);
    // No comma before the line ends: not a row this pass understands. Pass it
    // through — an unknown row is rewritten, never reinterpreted.
    if (comma < 0 || (nl >= 0 && nl < comma)) {
      const end = nl < 0 ? buf.length : nl + 1;
      pass(i, end);
      i = end;
      continue;
    }
    const header = buf.subarray(i, comma).toString("utf8");
    const m = /^([0-9a-f]+):T([0-9a-f]+)$/i.exec(header);
    if (!m) {
      const end = nl < 0 ? buf.length : nl + 1;
      pass(i, end);
      i = end;
      continue;
    }
    const declared = parseInt(m[2], 16);
    const start = comma + 1;
    const stop = Math.min(start + declared, buf.length);
    const body = rw(buf.subarray(start, stop).toString("utf8"));
    //  Re-declare in UTF-8 BYTES, not characters. This payload is Japanese,
    // where the two differ by a factor of three.
    const head = `${m[1]}:T${Buffer.byteLength(body, "utf8").toString(16)},`;
    out.push(head + body);
    chars += header.length + 1 + buf.subarray(start, stop).toString("utf8").length;
    newChars += head.length + body.length;
    i = stop;
  }
  marks.push({ o: chars, n: newChars });
  return { text: out.join(""), marks };
}

/**
 * Rewrite a document's flight payload out of band and splice it back.
 * Returns null when there is no payload, so the caller can fall through to its
 * ordinary path.
 *
 *  The gaps BETWEEN pushes are rewritten here too, so every region of the
 * document is rewritten exactly once. Letting a blanket pass run afterwards
 * over the repaired literal would shorten those rows a second time and re-open
 * the mismatch this function closes.
 */
export function rewriteFlight(html, rw) {
  PUSH.lastIndex = 0;
  const lits = [];
  let m;
  while ((m = PUSH.exec(html))) lits.push({ start: m.index, end: m.index + m[0].length, lit: m[1] });
  if (!lits.length) return null;

  let stream = "";
  const bounds = [];   // char offset in the original stream where each push ends
  for (const l of lits) {
    let piece;
    try { piece = JSON.parse(l.lit); } catch { return null; }
    stream += piece;
    bounds.push(stream.length);
  }

  const { text: fixed, marks } = repairFlightRows(stream, rw);

  //  Keep the ORIGINAL push boundaries. Chunk boundaries carry no meaning to
  // the client — it concatenates before parsing — but they carry a great deal
  // to the shell gate, which diffs the port against the mirror hunk by hunk.
  // Re-chunking arbitrarily turns a handful of local URL edits into 73 hunks of
  // text that merely moved, and a transform table cannot explain those.
  const mapOffset = (o) => {
    let lo = 0, hi = marks.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (marks[mid].o <= o) lo = mid; else hi = mid - 1; }
    const mk = marks[lo];
    return Math.min(fixed.length, mk.n + (o - mk.o));
  };

  const enc = (s) => JSON.stringify(s).replace(/<\//g, "<\\u002f");
  let out = "", cursor = 0, prev = 0;
  lits.forEach((l, k) => {
    out += rw(html.slice(cursor, l.start));
    const end = k === lits.length - 1 ? fixed.length : mapOffset(bounds[k]);
    out += `self.__next_f.push([1,${enc(fixed.slice(prev, Math.max(prev, end)))}])`;
    prev = Math.max(prev, end);
    cursor = l.end;
  });
  return out + rw(html.slice(cursor));
}

/** True when this document streams a length-prefixed payload. */
export const hasFlight = (html) => html.includes("self.__next_f.push");
