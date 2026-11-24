DS Player
=========

Plays your own Nintendo DS backups (.nds) in your web browser. Everything runs on
this computer: the app starts a small local server (only reachable from this computer)
and opens your default browser. Nothing is downloaded or sent anywhere.

Starting
--------
Windows (installed):  Start menu > DS Player
Windows (portable):   double-click DSPlayer.exe
Linux:                run ./ds-player

The app opens a list of your games (arrow keys, mouse or gamepad). Choose "Insert cartridge",
or drop a .nds file on the page, to add one: it is copied into the data folder once, and from
then on it is in the list. "Games" (top of the page) saves and goes back to the list. To remove a game, quit the app and delete its folder (see Saves).

Windows may warn "Windows protected your PC" because the app is not code-signed.
Click "More info" > "Run anyway".

Quitting
--------
Click "Quit" at the top of the page (it saves first). On Windows you can also close the
console window. Launching the app again while it is running just opens a new tab.

Controls
--------
D-pad           Arrow keys
A / B           X / Z
X / Y           S / A
L / R           Q / W
Start / Select  Enter / Shift
Touch screen    Mouse on the bottom screen
Back to game list  Backspace twice (or "Games" at the top)
Gamepads work automatically. Keys can be changed in the toolbar's "Control Settings".

Saves
-----
Save in the game's menu, as on a DS. The save is written to disk a few seconds later.
Each game has its own folder, named after its game code (e.g. CPUE),
inside the "games" folder of the data folder:

  Windows (installed):  %LOCALAPPDATA%\DSPlayer
  Windows (portable):   the "data" folder next to DSPlayer.exe
  Linux:                ~/.local/share/ds-player

Coming from the older "Pokemon Platinum" app: the installer replaces it and your games and saves
move over automatically. For the portable version, copy the old "data" folder next to DSPlayer.exe.

The game's folder holds "save.sav"; the last 20 versions are kept in its "backups" folder.
To restore a backup: quit the app, copy a file from "backups" over "save.sav".
To use a save from your real cartridge: toolbar > "Import Save File" (.sav / .dsv).
To copy your save out: toolbar > "Export Save File".
Save states (toolbar) are a convenience only; in-game saves are the reliable ones.

Uninstalling (Windows) removes the program but keeps your saves.

Linux: add to the application menu (run inside this folder)
------------------------------------------------------------
mkdir -p ~/.local/share/applications && sed "s|^Exec=.*|Exec=\"$PWD/ds-player\"|; s|^Icon=.*|Icon=$PWD/icon.png|" ds-player.desktop > ~/.local/share/applications/ds-player.desktop

Licenses
--------
This app bundles EmulatorJS, RetroArch and DeSmuME, which are free software (GPL), and the
Press Start 2P font (SIL Open Font License). See the LICENSES folder.
