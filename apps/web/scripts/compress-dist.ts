/**
 * Beside each script, stylesheet and other text file of the build, its Brotli and gzip copies (`app.js.br`,
 * `app.js.gz`): the server sends them to a browser that takes them (`serveStatic` with `precompressed`), so a server
 * with nothing in front of it (a self-hosted one) sends about a quarter of the bytes. Pages are left plain: the server
 * rewrites their HTML. `bun scripts/compress-dist.ts [dist]`
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const COMPRESSED = /\.(js|mjs|css|svg|json|webmanifest|wasm)$/;
/** Smaller files gain nothing worth a second file. */
const MIN_BYTES = 1024;

export function compressDist(dir: string) {
  let files = 0;
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const path = join(dir, name);
    if (!COMPRESSED.test(name) || !statSync(path).isFile()) continue;
    const bytes = readFileSync(path);
    if (bytes.byteLength < MIN_BYTES) continue;
    writeFileSync(
      `${path}.br`,
      brotliCompressSync(bytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 10, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength },
      }),
    );
    writeFileSync(`${path}.gz`, gzipSync(bytes, { level: 9 }));
    files++;
  }
  return files;
}

if (import.meta.main) {
  const dir = process.argv[2] ?? join(import.meta.dir, "..", "dist");
  console.log(`compressed ${compressDist(dir)} files in ${dir}`);
}
