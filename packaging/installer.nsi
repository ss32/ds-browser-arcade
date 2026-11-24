; Per-user Windows installer (no admin rights). Built by scripts/dist.ts:
;   makensis -DVERSION=x.y.z -DSRC=<staged files> -DOUTFILE=<setup.exe> -DICON=<icon.ico> installer.nsi
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"

!define APPNAME "DS Player"
!define EXE "DSPlayer.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSPlayer"
!define OLD_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\PokemonPlatinum" ; before 1.2

Name "${APPNAME}"
OutFile "${OUTFILE}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\DSPlayer"
InstallDirRegKey HKCU "${UNINST_KEY}" "InstallLocation"
SetCompressor /SOLID lzma
!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Start ${APPNAME} now"

!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "${APPNAME}" SecMain
  SectionIn RO
  SetShellVarContext current
  ; Before 1.2 the app was installed as "Pokemon Platinum": uninstall that copy (the app moves its data folder).
  ReadRegStr $0 HKCU "${OLD_KEY}" "InstallLocation"
  ${If} $0 != ""
    ExecWait '"$0\Uninstall.exe" /S _?=$0'
    Delete "$0\Uninstall.exe"
    RMDir "$0"
  ${EndIf}
  SetOutPath "$INSTDIR"
  File "${SRC}\${EXE}"
  File "${SRC}\README.txt"
  File /r "${SRC}\LICENSES"
  File "/oname=icon.ico" "${ICON}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\icon.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\icon.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Section "Desktop shortcut" SecDesktop
  SetShellVarContext current
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\icon.ico"
SectionEnd

; Removes the program only. Saves and the imported game file live in %LOCALAPPDATA%\DSPlayer and are kept.
Section "Uninstall"
  SetShellVarContext current
  Delete "$INSTDIR\${EXE}"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\icon.ico"
  RMDir /r "$INSTDIR\LICENSES"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  Delete "$DESKTOP\${APPNAME}.lnk"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DetailPrint "Your saves were kept in $LOCALAPPDATA\DSPlayer"
SectionEnd
