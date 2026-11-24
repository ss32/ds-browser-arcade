// Downloads EmulatorJS 4.2.3, verifies it, and vendors only the files the app needs into vendor/emulatorjs/.
import { path7za } from "7zip-bin";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

const VERSION = "4.2.3";
const URL_7Z = `https://github.com/EmulatorJS/EmulatorJS/releases/download/v${VERSION}/${VERSION}.7z`;
const SHA256_7Z = "07d451bc06fa3ad04ab30d9b94eb63ac34ad0babee52d60357b002bde8f3850b";
// Everything the page loads at runtime. melonDS is left out on purpose: it needs BIOS dumps.
const KEEP = [
  "data/loader.js",
  "data/emulator.min.js",
  "data/emulator.min.css",
  "data/version.json",
  "data/compression/extract7z.js",
  "data/compression/extractzip.js",
  "data/cores/reports/desmume.json",
  "data/cores/reports/desmume2015.json",
  ...["desmume", "desmume2015"].flatMap((c) =>
    ["", "-thread"].flatMap((t) => ["", "-legacy"].map((l) => `data/cores/${c}${t}${l}-wasm.data`)),
  ),
  "LICENSE",
];

const root = join(import.meta.dir, "..");
const cache = join(root, "vendor", ".cache");
const out = join(root, "vendor", "emulatorjs");
const archive = join(cache, `${VERSION}.7z`);
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

await mkdir(cache, { recursive: true });
if (!existsSync(archive) || sha256(await readFile(archive)) !== SHA256_7Z) {
  console.log(`Downloading ${URL_7Z} ...`);
  const res = await fetch(URL_7Z);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (sha256(buf) !== SHA256_7Z) throw new Error("EmulatorJS archive checksum mismatch; refusing to use it.");
  await writeFile(archive, buf);
}

await rm(out, { recursive: true, force: true });
await chmod(path7za, 0o755).catch(() => {});
const proc = Bun.spawnSync([path7za, "x", "-y", `-o${out}`, archive, ...KEEP], { stdout: "ignore", stderr: "pipe" });
if (proc.exitCode !== 0) throw new Error(`7za failed: ${proc.stderr.toString()}`);

// Licenses travel with every build: EmulatorJS/RetroArch are GPL-3.0, DeSmuME is GPL-2.0-or-later.
await mkdir(join(out, "LICENSES"), { recursive: true });
await Bun.write(join(out, "LICENSES", "GPL-3.0.txt"), Bun.file(join(out, "LICENSE")));
await rm(join(out, "LICENSE"));
await writeFile(
  join(out, "LICENSES", "NOTICE.txt"),
  `This app bundles third-party software, unmodified:

- EmulatorJS ${VERSION} (GPL-3.0) - https://github.com/EmulatorJS/EmulatorJS
- RetroArch (GPL-3.0), compiled into the cores above - https://github.com/libretro/RetroArch
- DeSmuME libretro cores "desmume" and "desmume2015" (GPL-2.0-or-later, distributed here under GPL-3.0)
  - https://github.com/libretro/desmume
  - https://github.com/libretro/desmume2015

The full source code of each component is available at the URLs above.
GPL-3.0 text: GPL-3.0.txt
`,
);

const files: Record<string, string> = {};
const walk = async (dir: string): Promise<void> => {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else files[relative(out, p).replaceAll("\\", "/")] = sha256(await readFile(p));
  }
};
await walk(out);
const missing = KEEP.filter((k) => k !== "LICENSE" && !files[k]);
if (missing.length) throw new Error(`Missing from archive: ${missing.join(", ")}`);
await writeFile(join(out, "VERSION.json"), JSON.stringify({ version: VERSION, source: URL_7Z, sha256: SHA256_7Z, files }, null, 2));
console.log(`Vendored EmulatorJS ${VERSION}: ${Object.keys(files).length} files in ${relative(root, out)}`);
