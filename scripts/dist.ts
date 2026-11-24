// Builds every release artifact from this Linux machine into dist/:
//   DSPlayer-<ver>-win-x64-portable.zip, DSPlayer-<ver>-win-x64-setup.exe, DSPlayer-<ver>-linux-x64.tar.gz, SHA256SUMS
import { path7za } from "7zip-bin";
import { create as tar } from "tar";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { userInfo } from "node:os";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const stage = join(dist, "stage");
const pkg = "packaging";
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const name = `DSPlayer-${version}`;

function run(cmd: string[], cwd = root) {
  console.log(`$ ${cmd.map((a) => relative(root, a) || a).join(" ")}`);
  const p = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`Failed (${p.exitCode}): ${cmd[0]}`);
}
const has = (bin: string) => Bun.which(bin) !== null;

if (!existsSync(join(root, "vendor", "emulatorjs", "VERSION.json"))) run([process.execPath, "scripts/fetch-emulator.ts"]);
await rm(dist, { recursive: true, force: true });

// 1. Compile the server, Bun runtime, page and EmulatorJS into one executable per platform.
const compile = (target: string, outfile: string) =>
  run([
    process.execPath, "build", "src/server.ts", "--compile", "--minify", `--target=${target}`, `--outfile=${outfile}`,
    "--asset=public", "--asset=vendor/emulatorjs/data", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
  ]);
const winDir = join(stage, "win", "DSPlayer");
const linDir = join(stage, "linux", "ds-player");
await mkdir(winDir, { recursive: true });
await mkdir(linDir, { recursive: true });
// (Bun can only set the .exe icon/metadata when compiling on Windows; the installer's shortcuts use icon.ico instead.)
compile("bun-windows-x64", join(winDir, "DSPlayer.exe"));
compile("bun-linux-x64", join(linDir, "ds-player"));
await chmod(join(linDir, "ds-player"), 0o755);

// 2. Shared files next to each binary.
for (const dir of [winDir, linDir]) {
  await copyFile(join(root, pkg, "README.txt"), join(dir, "README.txt"));
  await cp(join(root, "vendor", "emulatorjs", "LICENSES"), join(dir, "LICENSES"), { recursive: true });
  await copyFile(join(root, "public", "fonts", "OFL.txt"), join(dir, "LICENSES", "OFL-1.1-PressStart2P.txt"));
}
await copyFile(join(root, pkg, "ds-player.desktop"), join(linDir, "ds-player.desktop"));
await copyFile(join(root, pkg, "icon.png"), join(linDir, "icon.png"));

// 3. Never ship a ROM or a save.
const walk = async (dir: string): Promise<string[]> =>
  (await readdir(dir, { withFileTypes: true, recursive: true })).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
const shipped = [...(await walk(winDir)), ...(await walk(linDir))];
const forbidden = shipped.filter((f) => /\.(nds|sav|dsv|state)$/i.test(f));
if (forbidden.length) throw new Error(`Refusing to package game data: ${forbidden.join(", ")}`);

// 4. Windows installer: built from the same files, minus the portable marker.
// makensis runs on Linux; without a local install it runs in a throwaway Debian container (project mounted at /w).
const nsis = (r: string) => [
  `-DVERSION=${version}`, `-DSRC=${join(r, relative(root, winDir))}`, `-DOUTFILE=${join(r, "dist", `${name}-win-x64-setup.exe`)}`,
  `-DICON=${join(r, pkg, "icon.ico")}`, join(r, pkg, "installer.nsi"),
];
if (has("makensis")) run(["makensis", ...nsis(root)]);
else {
  const { uid, gid } = userInfo();
  run([
    "docker", "run", "--rm", "-v", `${root}:/w`, "debian:trixie-slim", "sh", "-c",
    `apt-get update -qq && apt-get install -y -qq nsis >/dev/null && makensis "$@" && chown ${uid}:${gid} /w/dist/*.exe`, "sh", ...nsis("/w"),
  ]);
}

// 5. Portable zip (with the marker that keeps saves next to the exe) and Linux tarball.
await writeFile(join(winDir, "portable.txt"), "This file makes the app keep its data (game file and saves) in the \"data\" folder next to the .exe.\n");
run([path7za, "a", "-tzip", "-mx=9", join(dist, `${name}-win-x64-portable.zip`), "DSPlayer"], join(stage, "win"));
await tar({ gzip: { level: 9 }, cwd: join(stage, "linux"), portable: true, file: join(dist, `${name}-linux-x64.tar.gz`) }, ["ds-player"]);

// 6. Checksums.
const artifacts = (await readdir(dist)).filter((f) => f !== "stage").sort();
const sums = await Promise.all(artifacts.map(async (f) => `${createHash("sha256").update(await readFile(join(dist, f))).digest("hex")}  ${f}`));
await writeFile(join(dist, "SHA256SUMS"), sums.join("\n") + "\n");
await rm(stage, { recursive: true, force: true });
console.log(`\nBuilt in ${relative(root, dist)}/:\n${sums.join("\n")}`);
