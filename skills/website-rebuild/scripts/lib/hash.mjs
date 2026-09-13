/**
 * SHA-256 helpers shared by mirror manifests, inventories and file checks.
 * Digests use lowercase hexadecimal; file hashing streams the input so memory
 * use does not scale with media size (verification-gates.md §2.1.1).
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Hex sha256 of a string or Buffer. */
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** First `n` hex chars — the short form used for ids in generated file names. */
export const sha256Short = (data, n = 12) => sha256(data).slice(0, n);

/** Hex SHA-256 of a file, read as a stream. */
export function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(p)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}
