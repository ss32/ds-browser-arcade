# Plan: Play Pokémon Platinum in the Browser

## Goal

Ship the game as a **local desktop app for Windows and Linux**. The user double-clicks it, it starts a small server on their own machine, opens their default browser, and they play their own Pokémon Platinum backup there. Saves are kept on disk. Nothing ever runs or loads from anywhere except the user's own machine.

What the build must produce, all of it built on this Linux machine by one command:

| File | What it is |
|---|---|
| `PokemonPlatinum-<ver>-win-x64-portable.zip` | A single `.exe` plus a `portable.txt` marker. Unzip anywhere and run. Saves go next to the `.exe`. |
| `PokemonPlatinum-<ver>-win-x64-setup.exe` | Installer. Per-user install, no admin needed. Adds a Start menu shortcut and an uninstaller. |
| `PokemonPlatinum-<ver>-linux-x64.tar.gz` | A single binary, a `.desktop` file, an icon and a short README. Extract anywhere and run. |

## Inputs (already in this directory)

| File | Notes |
|---|---|
| `pokemon_platinum.nds` | 128 MiB, header `POKEMON PL`, game code `CPUE01`, Rev 1, decrypted. SHA-1 `0862ec35b24de5c7e2dcb88c9eea0873110d755c`. **Use this file.** |
| `Pokemon - Platinum Version (USA) (Rev 1).zip` | Contains the same-size `.nds`. It is probably a duplicate. Don't use it, and don't delete it. |

There is no `.sav` file, so the game starts fresh. The app still supports importing a save later (see step 5).

**The ROM is never bundled into any build.** The user supplies it at first run (see step 4). Use this copy for local testing only.

Environment: Node v20.19.2, npm, Docker, and emsdk at `~/emsdk` (`emcc` is on PATH). Bun is not installed yet; add it as a pinned dev dependency (`npm i -D bun@<exact version>`) so the build doesn't depend on anything installed system-wide. This directory is not a git repo.

---

## Decision 1: Can the game itself be compiled to WASM? No.

- The `.nds` file is not source code. It contains ARM9 and ARM7 machine code built for the DS hardware: two CPUs, a custom 2D/3D GPU, a touchscreen, and DS sound and save chips. You can't compile it to WASM. Static recompilation of a commercial DS game is a research project, not a weekend task.
- The **pret/pokeplatinum** decompilation exists, but it rebuilds the *DS ROM*. It depends on the NitroSDK and on direct hardware access. Unlike some GBA Pokémon decomps, it has no PC or WASM port. Making one means rewriting the graphics, audio, input and filesystem layers: months of work, with no working game until the end.

**Next best option, and the one to build: a Nintendo DS emulator compiled to WASM, served by a small local TypeScript server.** The game runs unmodified inside the emulator.

### Which emulator

Use **EmulatorJS 4.2.3** (the latest stable release; do not use 4.3.0-pre), vendored into the app. It packages the libretro DS cores as Emscripten/WASM builds. It also provides the canvas, audio, keyboard and gamepad input, touch on the bottom screen, and save-file hooks.

| Core | BIOS needed? | Notes |
|---|---|---|
| `desmume2015` | No (HLE BIOS) | **Default.** Lightest core, so the best chance of full speed in a browser. Platinum runs well on DeSmuME. |
| `desmume` | No | Newer DeSmuME. Ship it as a fallback if `desmume2015` has a bug in some scene. |
| `melonds` | **Yes**: `bios7.bin`, `bios9.bin`, `firmware.bin` | **Don't ship it.** It needs BIOS files dumped from a DS. |

## Decision 2: How to package it as Windows and Linux apps

Use **`bun build --compile`**. It turns the TypeScript server, the Bun runtime and every embedded asset into one self-contained executable. It can **build the Windows binary from Linux** (`--target=bun-windows-x64`, `--target=bun-linux-x64`). Bun runs TypeScript directly, and Hono runs on it natively, so there is no transpile step and no separate Node install for the user.

The installer is built with **NSIS** (`makensis`), which also runs on Linux (`apt install nsis`, or a Docker image if it isn't installed). The Windows build therefore needs no Windows machine, although final testing does (see Acceptance).

### Counter-arguments considered

- *"Build DeSmuME/melonDS to WASM ourselves with the installed emsdk."* We would then have to write the frontend, audio, input, touch and save handling that EmulatorJS already provides. It is a lot more code for no benefit to the player. It is deferred to the optional Phase 2.
- *"Skip the server and open a static HTML file."* WASM and `fetch` need HTTP, not `file://`. Browser-only saves (IndexedDB) are also lost when site data is cleared. The server's real job is **durable saves on disk**.
- *"Electron or Tauri, with their own window."* The user asked to play in their browser. Electron also adds about 100 MB and a second rendering stack. Tauri needs Rust, and on Linux it uses WebKitGTK, which is noticeably slower for WASM emulation. Both are more code and more moving parts.
- *"Node SEA (single executable application) instead of Bun."* It works with stock Node, but embedding assets needs Node 22 or newer, and the build involves more manual steps (`postject`, a blob config, a separate binary per platform). Bun does the same thing in one command. **If Bun compile misbehaves on Windows** (for example, antivirus false positives or file API bugs), Node SEA is the fallback. Keep the server free of Bun-only APIs, except in the tiny asset-loading module, so that switch stays cheap.

---

## Architecture

```
PokemonPlatinum(.exe)  ── single binary: Bun runtime + server + embedded EmulatorJS + page
  │  on launch:
  │   1. resolve data dir (portable vs installed)
  │   2. if already running → open browser to it, exit
  │   3. start Hono on 127.0.0.1:<port>, write lock file
  │   4. open default browser (Windows: `cmd /c start "" <url>`, Linux: `xdg-open <url>`)
  ▼
Browser ──HTTP (127.0.0.1 only)──▶ server
                 ├─ GET  /                → index.html (EmulatorJS config, ROM picker if no ROM)
                 ├─ GET  /emulatorjs/*    → embedded EmulatorJS 4.2.3 files (desmume2015 + desmume cores only)
                 ├─ GET  /rom             → streams <dataDir>/rom.nds
                 ├─ PUT  /api/rom         → first-run import: validate game code, save as <dataDir>/rom.nds
                 ├─ GET  /api/save        → current .sav (404 if none)
                 ├─ PUT  /api/save        → write .sav atomically + rotate backups
                 ├─ GET/PUT /api/state/:slot → save states
                 └─ POST /api/quit        → clean shutdown (Quit button on the page)
```

### Data directory

| Mode | How it is detected | Data dir |
|---|---|---|
| Portable (Windows zip) | `portable.txt` next to the executable | `<exe dir>/data` |
| Installed (Windows setup) | default | `%LOCALAPPDATA%\PokemonPlatinum` |
| Linux | default (`portable.txt` also honored) | `$XDG_DATA_HOME/pokemon-platinum`, falling back to `~/.local/share/pokemon-platinum` |
| Development (`bun run dev`) | env `DATA_DIR` | `./saves` by default |

Contents: `rom.nds`, `platinum.sav`, `backups/`, `states/`, `app.lock`. The uninstaller **must not** delete this directory, because it holds the user's saves.

### Project layout (keep it small)

```
pokemon/
  PLAN.md
  pokemon_platinum.nds           # input, unchanged (dev testing only, never packaged)
  package.json                   # scripts: fetch-emulator, dev, dist
  tsconfig.json
  src/server.ts                  # routes, save logic, launch/lock/browser-open (~200 lines)
  src/assets.ts                  # the only Bun-specific module: embedded-file lookup
  scripts/fetch-emulator.ts      # downloads + verifies EmulatorJS 4.2.3 into vendor/
  scripts/dist.ts                # compiles both targets, builds zip, tar.gz, NSIS installer
  public/index.html              # EmulatorJS config, ROM picker, save sync glue (one inline script)
  packaging/installer.nsi        # NSIS script
  packaging/pokemon-platinum.desktop
  packaging/icon.png / icon.ico  # original simple icon (not Nintendo/Pokémon artwork)
  vendor/emulatorjs/             # gitignored; produced by fetch-emulator
  dist/                          # gitignored; build outputs
  .gitignore                     # vendor/, dist/, saves/, node_modules/, *.nds, *.zip, *.sav
```

Dependencies: `hono` at runtime, plus `bun` and `typescript` as dev dependencies, with exact versions pinned. Nothing else, apart from at most one small pure-JS archive library for `fetch-emulator` and `dist`, if Bun's built-ins don't cover it.

---

## Implementation steps

### 1. Vendor EmulatorJS (`scripts/fetch-emulator.ts`)
- Download the **4.2.3** release archive from `github.com/EmulatorJS/EmulatorJS/releases` and extract its `data/` folder into `vendor/emulatorjs/`. Use no shell tools (`unzip`, `7z`, `curl`).
- Keep only what the app needs: the loader, its scripts and CSS, and the `desmume2015` and `desmume` cores. Delete every other core, which keeps the binary small. If the cores aren't in the release archive, download the matching 4.2.3 core files from EmulatorJS's CDN at **build time**. **At runtime, nothing loads from any origin except 127.0.0.1.**
- Record the version, the file list and each file's sha256 in `vendor/emulatorjs/VERSION.json`.
- Read the vendored `GameManager.js` and confirm the undocumented save API used in step 5 (`getSaveFilePath`, `loadSaveFiles`, `FS`).
- Ship EmulatorJS's license (GPL-3.0) and the cores' licenses (DeSmuME is GPL-2.0+) inside every build, in a `LICENSES/` folder.

### 2. Embedded assets (`src/assets.ts`)
- In compiled builds, serve `public/` and `vendor/emulatorjs/` from inside the binary, using Bun's file embedding: extra files passed to `bun build --compile`, read through `Bun.embeddedFiles` or `import … with { type: "file" }`. Check how this works in the pinned Bun version. If directory embedding is awkward, have `dist.ts` generate a manifest module that imports every file.
- In `dev`, serve the same paths from disk.
- Set correct MIME types, in particular `.wasm` → `application/wasm`.

### 3. Server (`src/server.ts`)
- **Always bind to `127.0.0.1`.** There is no host option.
- Port: try `3000`, and if that is taken, use any free port.
- **Single instance:** `app.lock` in the data dir holds the PID and port. At launch, if the lock exists and `GET http://127.0.0.1:<port>/api/ping` answers, open the browser to that URL and exit. Otherwise treat the lock as stale and take it over.
- Open the default browser after the server is listening. Windows: `cmd /c start "" <url>`. Linux: `xdg-open <url>`. Use `Bun.spawn` or `child_process` with an argument array, never a string passed to a shell.
- Console: keep the console window visible on Windows. It prints "Pokémon Platinum is running at <url>. Close this window to quit." Hiding it would leave a process the user can't see or stop. The page also has a Quit button (`POST /api/quit`) that flushes the save first.
- `GET /rom` streams `<dataDir>/rom.nds` with `Content-Length` and supports `Range`.
- `PUT /api/save` accepts a raw binary body, capped at 1 MiB (the Platinum save is 512 KiB):
  - Write to `platinum.sav.tmp`, `fsync`, then `rename` over `platinum.sav`. The write is atomic, so a crash can't corrupt the save. On Windows, retry `EPERM`/`EBUSY` up to 5 times with a short delay, because antivirus can hold the file open. Never fall back to a non-atomic write.
  - Before overwriting, copy the previous file to `backups/platinum-YYYYMMDD-HHmmss.sav` (no `:`, since Windows doesn't allow it in file names) and keep the newest 20. **The save is the most valuable thing here. Losing it is the worst possible failure.**
  - Skip the write if the body's hash matches the current file.
- Save-state routes work the same way, for slots `1`–`4`. They don't need backups.
- Send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on every response. `127.0.0.1` is a secure context, so `SharedArrayBuffer` is available if threads help performance (step 7).
- Build every path with `node:path`, starting from the executable's directory (`process.execPath`) or the data dir. Never use the current working directory, because double-clicking sets it unpredictably.

### 4. First run: ROM import (`index.html` + `PUT /api/rom`)
- If `rom.nds` is missing, the page shows one "Choose your Pokémon Platinum .nds file" button instead of the emulator.
- The server checks the upload: size at most 256 MiB, and game code `CPU?` at offset `0x0C`, so `CPUE` passes. It writes the file atomically to `<dataDir>/rom.nds` and the page reloads into the game.
- After that, launching the app goes straight to the game.
- For dev, copy `./pokemon_platinum.nds` into `./saves/rom.nds`.

### 5. Page and save sync (`public/index.html`)
- A full-viewport dark page. Center the emulator and keep the DS aspect ratio: two 256×192 screens stacked vertically, scaled with `image-rendering: pixelated`. Add a small Quit button and a collapsible controls overlay.
- EmulatorJS config:
  ```js
  EJS_player = '#game';
  EJS_core = 'desmume2015';          // ?core=desmume to switch, for troubleshooting
  EJS_pathtodata = '/emulatorjs/';
  EJS_gameUrl = '/rom';
  EJS_gameName = 'Pokemon Platinum';
  EJS_gameID = 1;
  EJS_startOnLoaded = true;
  EJS_fixedSaveInterval = 10000;     // flush SRAM every 10s
  ```
- **Upload:** `EJS_onSaveUpdate = ({ save }) => fetch('/api/save', { method: 'PUT', body: save })`. Also flush on `visibilitychange`→hidden, on `pagehide` (with `keepalive: true`), and before Quit.
- **Download on boot:** when the game starts (`EJS_onGameStart`), `GET /api/save`. If it returns 200, write the bytes to `EJS_emulator.gameManager.getSaveFilePath()` through the emulator FS, call `loadSaveFiles()`, and restart the game so it reads the save on boot. **The server's copy is the source of truth.** Keep all of this glue in one small function.
- Point `EJS_onSaveSave` and `EJS_onLoadSave` at the server. That is how the user exports a save or imports one dumped from their real cartridge.
- Save states go through `/api/state/1`. They are a convenience only. Tell the user that **in-game saves are the reliable ones**.

### 6. Controls
- Set `EJS_defaultControls` for keyboard: arrows = D-pad, `X` = A, `Z` = B, `S` = X, `A` = Y, `Q`/`W` = L/R, `Enter` = Start, `Shift` = Select. Gamepads work through EmulatorJS.
- Mouse and touch on the bottom screen act as the DS touchscreen. Test it on the title screen and on the Pokétch.

### 7. Performance
- Target a steady 60 fps in Chrome, Firefox and Edge, in the overworld and in a double battle.
- If it is under 60 fps: try `EJS_threads = true`, then the `desmume` core, then EmulatorJS's core options (frameskip, renderer).

### 8. Packaging (`scripts/dist.ts`, run with `npm run dist`)
1. Check that `vendor/emulatorjs/` exists, and run `fetch-emulator` if it doesn't.
2. `bun build --compile --minify --target=bun-windows-x64 → dist/PokemonPlatinum.exe` and `--target=bun-linux-x64 → dist/pokemon-platinum`, embedding the assets. Set the version and an `.ico` icon on the Windows exe if the pinned Bun version supports it when building from Linux. If it doesn't, skip the icon on the exe itself; the installer shortcut can still use the `.ico`.
3. **Windows portable:** a zip containing `PokemonPlatinum.exe`, `portable.txt`, `README.txt` and `LICENSES/`.
4. **Windows installer:** `makensis packaging/installer.nsi` (from `apt install nsis`, or a Docker image; fail with a clear message if neither is available). It should:
   - install per user to `%LOCALAPPDATA%\Programs\PokemonPlatinum`, with `RequestExecutionLevel user`;
   - add Start menu and optional desktop shortcuts;
   - register an uninstaller in Add/Remove Programs (HKCU);
   - have the uninstaller remove the program files **only**, and say that saves remain in `%LOCALAPPDATA%\PokemonPlatinum`.
5. **Linux:** a tar.gz containing the binary (`chmod +x`), `pokemon-platinum.desktop`, `icon.png`, `README.txt` and `LICENSES/`. The README gives the one-line command to copy the `.desktop` file into `~/.local/share/applications` for a menu entry.
6. Write `SHA256SUMS` for all artifacts. **Assert that no artifact contains an `.nds` or `.sav` file.**
- Versioning: take `<ver>` from `package.json`.

---

## Acceptance criteria

Run on **Linux** and on a **real Windows 10/11 machine or VM**. The Windows check can't be done from this Linux box (Wine is not a valid test), so tell the user they must run it.

1. **Linux tarball:** extract it, run it, and the browser opens. On first launch the ROM picker appears; choose the ROM and the Platinum title screen loads. The network tab shows **no requests to any origin except 127.0.0.1**.
2. **Windows portable:** unzip into a folder (also test one with spaces in its name), double-click, and the result is the same as criterion 1. Saves appear in `<folder>\data\`.
3. **Windows installer:** installs without an admin prompt, the Start menu shortcut launches the game, and uninstalling leaves `%LOCALAPPDATA%\PokemonPlatinum` (and the saves) in place.
4. Tapping the title screen with the mouse works, keyboard and gamepad controls work, and audio plays.
5. Save in game and wait about 10 seconds: `platinum.sav` exists in the data dir and is 524,288 bytes. Close the browser and the app, clear the site data, relaunch, and choose Continue: the save loads.
6. Save twice more: `backups/` contains the earlier versions.
7. Killing the app mid-write never leaves a truncated `platinum.sav`.
8. Launching the app a second time opens a new tab to the running instance and doesn't start a second server.
9. The server is unreachable from another machine on the LAN, because it is bound to 127.0.0.1.
10. Gameplay holds about 60 fps in the overworld and in battle.

## Risks / watch-outs

- **Unsigned binaries:** Windows SmartScreen will warn on first run ("More info → Run anyway"). Document this in the README. Code signing needs a paid certificate and is out of scope unless the user asks for it.
- **Antivirus false positives:** some antivirus tools flag self-extracting or compiled-runtime executables. If Windows Defender flags the Bun build, try the Node SEA fallback from Decision 2 before anything else.
- **EmulatorJS's internal save API** is undocumented. Pin 4.2.3, check it against the vendored source, and keep the glue to a single function.
- **Save-type detection:** DeSmuME usually detects the 512 KiB flash correctly for `CPUE`. If saving fails in game ("could not save"), set the core's save-type option.
- **Linux `xdg-open`** may be missing on minimal systems. If launching the browser fails, print the URL clearly so the user can open it themselves.
- **Legal/privacy:** this is the user's own backup. Never bundle, commit or upload the ROM or saves. Use an original icon, not Nintendo or Pokémon artwork.

## Optional Phase 2 (only if the user asks)

- **Build the cores from source** with the local emsdk, so the WASM can be reproduced and audited instead of downloaded prebuilt.
- **More packages:** a Linux AppImage or `.deb`, and Windows code signing.
- **Watching pret/pokeplatinum:** if a community PC/SDL port ever appears, a true native build becomes realistic.
