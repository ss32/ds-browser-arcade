// Local-only server: serves the embedded EmulatorJS page and the user's DS games, and keeps their saves on disk.
import { Hono, type Context } from "hono";
import { copyFile, mkdir, open, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

const APP = "ds-player";
const HOST = "127.0.0.1";
const PREFERRED_PORT = 47240; // fixed so the browser origin (and its ROM cache) stays the same between launches
const SAVE_MAX = 16 << 20; // DS saves are up to 8 MiB, plus DeSmuME's footer
const STATE_MAX = 64 << 20;
const ROM_MAX = 512 << 20; // largest DS cartridge
const KEEP_BACKUPS = 20;

// --- paths ---------------------------------------------------------------------------------------
const compiled = Bun.embeddedFiles.length > 0;
const assetRoot = compiled ? import.meta.dir : join(import.meta.dir, ".."); // where public/ and vendor/ live
const exeDir = dirname(process.execPath);
const win = process.platform === "win32";
const appData = (winName: string, linuxName: string) =>
  win
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), winName)
    : join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), linuxName);
const perUser = compiled && !process.env.DATA_DIR && !existsSync(join(exeDir, "portable.txt"));
let dataDir = process.env.DATA_DIR || (!compiled ? join(assetRoot, "saves") : perUser ? appData("DSPlayer", "ds-player") : join(exeDir, "data"));

// Before 1.2 the app was called "Pokemon Platinum": move its data folder (or keep using it if it can't be moved).
const oldDataDir = appData("PokemonPlatinum", "pokemon-platinum");
if (perUser && !existsSync(dataDir) && existsSync(oldDataDir)) await rename(oldDataDir, dataDir).catch(() => (dataDir = oldDataDir));
const gamesDir = join(dataDir, "games"); // one folder per game: rom.nds, save.sav, backups/, states/
const lockPath = join(dataDir, "app.lock");
await mkdir(gamesDir, { recursive: true });

// --- single instance -----------------------------------------------------------------------------
const openBrowser = (url: string) => {
  if (!compiled) return console.log(`Open ${url}`);
  const cmd = win ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"] }).exited.then((code) => {
      if (code !== 0) console.log(`Could not open a browser automatically. Open ${url} yourself.`);
    });
  } catch {
    console.log(`Could not open a browser automatically. Open ${url} yourself.`);
  }
};

try {
  const { port } = JSON.parse(await readFile(lockPath, "utf8"));
  const res = await fetch(`http://${HOST}:${port}/api/ping`, { signal: AbortSignal.timeout(1000) });
  if ((await res.json()).app === APP) {
    console.log("Already running; opening it in your browser.");
    openBrowser(`http://${HOST}:${port}/`);
    process.exit(0);
  }
} catch {} // no lock, or a stale one: take over

// --- games ---------------------------------------------------------------------------------------
// A game's folder is named after its 4-character game code (e.g. CPUE), or a hash for homebrew without one.
const gameId = (rom: Uint8Array) => {
  const code = new TextDecoder().decode(rom.subarray(0x0c, 0x10));
  return /^[A-Z0-9]{4}$/.test(code) ? code : Bun.hash(rom).toString(16);
};

// From the ROM's banner: the English title (else the short header title), and the 32x32 icon as base64
// (4bpp tiles + 16-color palette, decoded by the page).
async function gameInfo(rom: string) {
  const f = Bun.file(rom);
  const header = new Uint8Array(await f.slice(0, 0x6c).arrayBuffer());
  const at = new DataView(header.buffer).getUint32(0x68, true);
  const banner = at ? new Uint8Array(await f.slice(at, at + 0x440).arrayBuffer()) : new Uint8Array(0);
  const lines = new TextDecoder("utf-16le").decode(banner.subarray(0x340, 0x440)).split("\0")[0].split("\n"); // title lines, then the publisher
  return {
    title: (lines.length > 1 ? lines.slice(0, -1) : lines).join(" ").trim() || new TextDecoder().decode(header.subarray(0, 12)).replace(/\0.*/s, ""),
    icon: banner.length >= 0x240 ? Buffer.from(banner.subarray(0x20, 0x240)).toString("base64") : null,
  };
}

// Version 1.0.0 kept one game at the top of the data folder: move it into games/<id> (rom.nds last, so an
// interrupted move is finished on the next start).
if (existsSync(join(dataDir, "rom.nds"))) {
  const dir = join(gamesDir, gameId(await readFile(join(dataDir, "rom.nds"))));
  await mkdir(dir, { recursive: true });
  for (const [from, to] of [["platinum.sav", "save.sav"], ["backups", "backups"], ["states", "states"], ["rom.nds", "rom.nds"]]) {
    if (existsSync(join(dataDir, from))) await rename(join(dataDir, from), join(dir, to));
  }
}

// --- file helpers --------------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Write to a temp file, fsync, then rename over the target, so a crash never leaves a half-written file.
// Windows antivirus/indexers can briefly hold the target open, so the rename is retried.
async function atomicWrite(file: string, data: Uint8Array) {
  const tmp = `${file}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  for (let i = 0; ; i++) {
    try {
      return await rename(tmp, file);
    } catch (e: any) {
      if (i >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      await sleep(100 * (i + 1));
    }
  }
}

const readIfExists = (file: string) => readFile(file).catch(() => null);
const stamp = () => new Date().toISOString().replace(/[:.]/g, "").replace("T", "_"); // sortable, no ':' (Windows)
const binary = (data: Uint8Array) => new Response(data, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });

async function readBody(req: Request, max: number) {
  const len = Number(req.headers.get("content-length") ?? NaN);
  if (!(len > 0 && len <= max)) return null;
  const body = new Uint8Array(await req.arrayBuffer());
  return body.length === len ? body : null;
}

// --- app -----------------------------------------------------------------------------------------
const app = new Hono();

app.use(async (c, next) => {
  // Only this app's own page may talk to the server: blocks other websites (cross-site requests) and DNS rebinding.
  const host = c.req.header("host");
  const origin = c.req.header("origin");
  if (![`${HOST}:${server.port}`, `localhost:${server.port}`].includes(host!) || (origin && origin !== `http://${host}`)) {
    return c.text("Forbidden", 403);
  }
  await next();
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Embedder-Policy", "require-corp");
  // Nothing may load from or talk to any other origin (EmulatorJS would otherwise check its CDN for updates).
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; " +
      "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob: data:; font-src 'self' data:",
  );
});

const fileResponse = async (path: string) => {
  const f = Bun.file(path);
  if (!(await f.exists())) return null;
  return new Response(f, { headers: { "Content-Type": f.type || "application/octet-stream", "Content-Length": String(f.size) } });
};
const ejsDir = compiled ? join(assetRoot, "data") : join(assetRoot, "vendor", "emulatorjs", "data"); // --asset keeps only the last dir name
const publicDir = join(assetRoot, "public");
const serveFrom = async (dir: string, rel: string) => {
  const path = join(dir, decodeURIComponent(rel));
  return (path.startsWith(dir + sep) && (await fileResponse(path))) || null;
};
app.get("/", async (c) => (await fileResponse(join(publicDir, "index.html"))) ?? c.notFound());
app.get("/fonts/*", async (c) => (await serveFrom(join(publicDir, "fonts"), c.req.path.slice("/fonts/".length))) ?? c.notFound());
app.get("/emulatorjs/*", async (c) => (await serveFrom(ejsDir, c.req.path.slice("/emulatorjs/".length))) ?? c.notFound());

app.get("/api/ping", (c) => c.json({ app: APP }));

const ID = ":id{[A-Za-z0-9]+}";
const gameDir = (c: Context) => join(gamesDir, c.req.param("id")!); // id is limited to [A-Za-z0-9] by the routes

app.get("/api/games", async (c) => {
  const ids = (await readdir(gamesDir)).filter((id) => existsSync(join(gamesDir, id, "rom.nds")));
  const games = await Promise.all(ids.map(async (id) => ({ id, ...(await gameInfo(join(gamesDir, id, "rom.nds"))) })));
  return c.json({ dataDir, games: games.sort((a, b) => a.title.localeCompare(b.title)) });
});

// Served as <id>.nds because EmulatorJS names the game's browser-side save after the file name.
app.get("/rom/:file{[A-Za-z0-9]+\\.nds}", async (c) => (await fileResponse(join(gamesDir, c.req.param("file").slice(0, -4), "rom.nds"))) ?? c.notFound());

// Add a game. The Nintendo logo checksum at 0x15C is present in every DS ROM header.
app.put("/api/rom", async (c) => {
  const body = await readBody(c.req.raw, ROM_MAX);
  if (!body || body.length < 0x200 || new DataView(body.buffer).getUint16(0x15c, true) !== 0xcf56) {
    return c.text("This is not a Nintendo DS game file (.nds).", 400);
  }
  const id = gameId(body);
  await mkdir(join(gamesDir, id), { recursive: true });
  await atomicWrite(join(gamesDir, id, "rom.nds"), body);
  return c.json({ id });
});

app.use(`/api/games/${ID}/*`, async (c, next) => (existsSync(join(gameDir(c), "rom.nds")) ? next() : c.notFound()));

app.get(`/api/games/${ID}/save`, async (c) => {
  const data = await readIfExists(join(gameDir(c), "save.sav"));
  return data ? binary(data) : c.body(null, 204); // 204, not 404: no save yet is normal
});

app.put(`/api/games/${ID}/save`, async (c) => {
  const body = await readBody(c.req.raw, SAVE_MAX);
  if (!body) return c.text("Bad save size.", 400);
  const savePath = join(gameDir(c), "save.sav");
  const backupDir = join(gameDir(c), "backups");
  const current = await readIfExists(savePath);
  if (current && current.equals(body)) return c.text("unchanged");
  if (current) {
    await mkdir(backupDir, { recursive: true });
    await copyFile(savePath, join(backupDir, `save-${stamp()}.sav`));
    const old = (await readdir(backupDir)).filter((f) => f.endsWith(".sav")).sort().slice(0, -KEEP_BACKUPS);
    await Promise.all(old.map((f) => unlink(join(backupDir, f))));
  }
  await atomicWrite(savePath, body);
  return c.text("saved");
});

app.get(`/api/games/${ID}/state/:slot{[1-4]}`, async (c) => {
  const data = await readIfExists(join(gameDir(c), "states", `slot${c.req.param("slot")}.state`));
  return data ? binary(data) : c.notFound();
});

app.put(`/api/games/${ID}/state/:slot{[1-4]}`, async (c) => {
  const body = await readBody(c.req.raw, STATE_MAX);
  if (!body) return c.text("Bad state size.", 400);
  await mkdir(join(gameDir(c), "states"), { recursive: true });
  await atomicWrite(join(gameDir(c), "states", `slot${c.req.param("slot")}.state`), body);
  return c.text("saved");
});

async function quit() {
  await rm(lockPath, { force: true });
  process.exit(0);
}
app.post("/api/quit", (c) => {
  setTimeout(quit, 100);
  return c.text("bye");
});

// --- start ---------------------------------------------------------------------------------------
const serve = (port: number) => Bun.serve({ hostname: HOST, port, fetch: app.fetch, maxRequestBodySize: ROM_MAX + 1, idleTimeout: 120 });
let server: ReturnType<typeof serve>;
try {
  server = serve(PREFERRED_PORT);
} catch {
  server = serve(0); // preferred port taken by something else
}
const url = `http://${HOST}:${server.port}/`;
await atomicWrite(lockPath, new TextEncoder().encode(JSON.stringify({ pid: process.pid, port: server.port })));

process.on("SIGINT", quit);
process.on("SIGTERM", quit);

console.log(`DS Player is running at ${url}\nSaves are kept in ${dataDir}\nClose this window to quit.`);
openBrowser(url);
