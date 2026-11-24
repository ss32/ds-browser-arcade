# DS Player

Plays your own Nintendo DS backups in the browser, packaged as a desktop app for Windows and Linux.
The app is a small TypeScript server (Bun + Hono) bound to `127.0.0.1` that serves a vendored
[EmulatorJS](https://github.com/EmulatorJS/EmulatorJS) 4.2.3 with the DeSmuME WASM core, and keeps saves on disk.
See `PLAN.md` for the reasoning (why an emulator rather than compiling the game to WASM).

## Build

```sh
npm install
npm run fetch-emulator   # once: downloads + checksums EmulatorJS 4.2.3 into vendor/
npm run dist             # builds everything into dist/
```

`dist/` then contains:

| File | |
|---|---|
| `DSPlayer-<ver>-win-x64-setup.exe` | Per-user installer (no admin). Start menu shortcut, uninstaller. |
| `DSPlayer-<ver>-win-x64-portable.zip` | Unzip anywhere, run `DSPlayer.exe`. Data stays next to the exe. |
| `DSPlayer-<ver>-linux-x64.tar.gz` | Extract anywhere, run `./ds-player`. |
| `SHA256SUMS` | |

Everything is built on Linux. The installer needs `makensis`: a local one is used if it's on PATH, otherwise Docker
runs it in a throwaway `debian:trixie-slim` container. The first build downloads Bun's Windows runtime.
No artifact contains a ROM or a save; `dist` refuses to package `.nds`/`.sav`/`.dsv`/`.state` files.

## Develop

```sh
npm run dev   # http://127.0.0.1:47240, data in ./saves; add games through the page
```

`DATA_DIR=/some/dir` overrides the data folder in both dev and built apps.

## Files

| Path | |
|---|---|
| `src/server.ts` | The whole server: data-dir resolution, single instance, game library and import, atomic saves + 20 backups, save states, quit. |
| `public/index.html` | Page: 8-bit game menu and import, EmulatorJS config, per-game save sync, controls, Quit. |
| `public/fonts/` | Press Start 2P pixel font (SIL OFL 1.1, from google/fonts; sha256 `034c77f1…e017d`) and its license. |
| `scripts/fetch-emulator.ts` | Downloads, verifies and trims EmulatorJS to the 2 DeSmuME cores; writes `vendor/emulatorjs/VERSION.json`. |
| `scripts/dist.ts` | Compiles both executables and builds the zip, tarball and installer. |
| `packaging/` | NSIS script, `.desktop` file, icon, end-user `README.txt`. |

The page's menu uses a fixed 16-color palette, the pixel font, a canvas starfield, the ROMs' own banner icons, keyboard
and gamepad navigation, drag-and-drop import and square-wave sound effects (mutable). Animations stop under
`prefers-reduced-motion`, and the starfield runs only on the menu, never while a game is playing.

## Where data lives

| Mode | Folder |
|---|---|
| Windows installed | `%LOCALAPPDATA%\DSPlayer` |
| Windows portable | `data\` next to the exe (because of `portable.txt`) |
| Linux | `$XDG_DATA_HOME/ds-player` (default `~/.local/share/ds-player`), or `data/` next to the binary if `portable.txt` exists |

Before 1.2 the app was called "Pokemon Platinum". On start, the app moves the old per-user data folder
(`PokemonPlatinum` / `pokemon-platinum`) to the new name, and the installer silently uninstalls the old program (which
keeps data). Portable users copy their `data` folder over by hand.

Contents: `app.lock` and `games/<id>/` per game, where `<id>` is the 4-character game code (`CPUE` for US Platinum) or a
hash for homebrew without one. Each game folder holds `rom.nds`, `save.sav` (DeSmuME `.dsv` format: the raw save plus a
footer), `backups/` and `states/`. Adding a game with the same code again (e.g. another revision) replaces its ROM and
keeps its saves. To remove a game, delete its folder. A 1.0.0 data folder (`rom.nds`/`platinum.sav` at the top) is
moved into `games/<id>/` on first start.

## Notes and deviations from PLAN.md

- **EmulatorJS 4.2.3 has no `EJS_onSaveUpdate` or `EJS_fixedSaveInterval`.** The docs describe a newer version. The page
  calls `gameManager.saveSaveFiles()` every 5 s and listens to the internal `saveSaveFiles` event instead.
- **Uploads are debounced.** Platinum writes a save in pieces over several seconds. A routine upload happens only once the
  save has been unchanged for one interval, so each in-game save produces one upload and one backup. Quit, hiding the tab,
  and imports upload immediately.
- **No `keepalive` flush on page close.** Chrome caps keepalive bodies at 64 KiB, and a save is 512 KiB. If the tab closes
  before an upload, the browser's copy (IndexedDB) still has the save. On the next launch the page notices it was never
  synced (a hash is kept in `localStorage`) and uploads it, and the older disk copy becomes a backup.
- **Any DS game:** the import accepts any ROM whose header has the Nintendo logo checksum (`0xCF56` at `0x15C`). The list
  shows the English title from the ROM's banner. Each game loads as `/rom/<id>.nds`, because EmulatorJS names the
  browser-side save after that file. That keeps each game's browser save, and its "last synced" hash, separate.
- **No ROM cache in the browser** (`EJS_disableDatabases`): the ROM comes from this computer anyway, and caching would
  store a copy of every game in the browser. Key bindings and emulator settings are shared by all games.
- **Touch input:** the core option `desmume_pointer_type=touch` and turning off EmulatorJS's pointer lock make the mouse an
  absolute stylus. The EmulatorJS toolbar is pinned in its own strip so it never covers the touch screen.
- **Only the app's own page can talk to the server.** Requests whose `Host` isn't `127.0.0.1:<port>` or
  `localhost:<port>`, or whose `Origin` is another site, get 403. This blocks other websites and DNS-rebinding attacks.
- **No off-origin traffic:** a `Content-Security-Policy` header blocks everything except `127.0.0.1`. EmulatorJS's
  update check against its CDN is blocked, which leaves a harmless console error.
- **No Windows exe icon or version info.** Bun only sets these when compiling on Windows. The installer's shortcuts and
  Add/Remove Programs entry use `icon.ico`.
- **Linux `.desktop` entry:** `Terminal=false`, so use the page's Quit button. The end-user README has the one-line command
  to add it to the app menu.
- **No `.env` / `tsconfig.json`.** Bun runs the TypeScript directly; `DATA_DIR` is the only setting.

## Tested

On this Linux machine, in headless Chromium:

- **Game list:** rejects a non-DS file, adds games, and switches between two games in one browser session without
  their saves mixing. A 1.0.0 data folder is migrated.
- **Gameplay:** boot, keyboard and stylus input (including the naming keyboard), and 3D scenes. It runs at a steady 60 fps.
- **In-game save:** a save reaches disk, and it is restored after site data is cleared.
- **Saves, states and import:** backup rotation, save states, save import, Quit, and the single-instance check.

The Linux build ran from an extracted tarball. The Windows portable exe and the installer (install, run, uninstall) were
smoke-tested under Wine only. **They still need a run on a real Windows 10/11 machine**, which can't be done from here.
