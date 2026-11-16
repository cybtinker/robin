; Fledgling Live installer (Inno Setup 6, free for commercial use).
; Per-user install, no admin prompt, silent install with /VERYSILENT (needed for a Microsoft Store EXE listing).
;
; VB-CABLE bundling (optional): if the unmodified VB-Audio driver pack is unzipped into
; installer\vbcable\ (the CI workflow does this), the installer offers to install it too.
; VB-Audio's licensing page (https://vb-audio.com/Services/licensing.htm) allows shipping the
; VB-CABLE package AS IS with an app, embedded in its installer and silently installed, as long
; as the donationware model stays visible: we must say it is VB-Audio's donationware and point to
; www.vb-cable.com. Only VB-CABLE itself may be bundled, never VB-CABLE A+B or C+D.
; Only the driver step needs admin rights: it asks with its own UAC prompt, and the app itself
; stays a per-user install. It is skipped on silent installs (/SILENT, /VERYSILENT).
#define AppVer GetEnv("APP_VERSION")
#if AppVer == ""
  #define AppVer "0.1.0"
#endif

[Setup]
AppId={{6A3C1E52-8F1B-4E0B-9D53-2F6B7C1D5A01}
AppName=Fledgling Live
AppVersion={#AppVer}
AppPublisher=Fledgling
VersionInfoVersion={#AppVer}
DefaultDirName={localappdata}\Programs\Fledgling Live
DefaultGroupName=Fledgling Live
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
OutputDir=..\build
OutputBaseFilename=FledglingLive-Setup-{#AppVer}
SetupIconFile=..\src\app.ico
UninstallDisplayIcon={app}\FledglingLive.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
#ifexist "vbcable\VBCABLE_Setup_x64.exe"
  #define WithCable
#endif

[Files]
Source: "..\build\FledglingLive.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\THIRD-PARTY-NOTICES.txt"; DestDir: "{app}"; Flags: ignoreversion
#ifdef WithCable
; The whole VB-Audio pack, unchanged, kept so the user can reinstall or remove VB-CABLE later.
Source: "vbcable\*"; DestDir: "{app}\VB-CABLE"; Flags: ignoreversion recursesubdirs; Tasks: vbcable
#endif

[Icons]
Name: "{userprograms}\Fledgling Live"; Filename: "{app}\FledglingLive.exe"
Name: "{userdesktop}\Fledgling Live"; Filename: "{app}\FledglingLive.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked
#ifdef WithCable
Name: "vbcable"; Description: "Install the VB-CABLE virtual microphone (needs administrator rights and a restart). VB-CABLE is donationware by VB-Audio Software, www.vb-cable.com"; Check: not CableInstalled
#endif

[Run]
#ifdef WithCable
; -i -h = install without VB-Audio's own window. "runas" shows the UAC prompt for this step only;
; Windows may also ask once whether to trust VB-Audio's driver.
Filename: "{app}\VB-CABLE\VBCABLE_Setup_x64.exe"; Parameters: "-i -h"; WorkingDir: "{app}\VB-CABLE"; Verb: "runas"; StatusMsg: "Installing the VB-CABLE virtual microphone (VB-Audio donationware)..."; Flags: shellexec waituntilterminated skipifsilent; Tasks: vbcable; AfterInstall: CableSetupRan
#endif
Filename: "{app}\FledglingLive.exe"; Description: "Start Fledgling Live"; Flags: nowait postinstall skipifsilent

#ifdef WithCable
[Messages]
FinishedRestartLabel=To finish installing the VB-CABLE virtual microphone, Windows must be restarted. Restart now?

[Code]
var
  CableRan: Boolean;

function CableInstalled: Boolean;
var
  F: TFindRec;
begin
  { VB-CABLE's driver file; "CABLE A/B/C/D" use other names, so they don't count here }
  Result := FindFirst(ExpandConstant('{sys}\drivers\vbaudio_cable64_win*.sys'), F);
  if Result then FindClose(F);
end;

procedure CableSetupRan;
begin
  CableRan := CableInstalled;
  if not CableRan then
    MsgBox('VB-CABLE was not installed (the administrator prompt may have been cancelled). ' +
      'Fledgling Live is installed. To add VB-CABLE later, right-click ' +
      ExpandConstant('{app}\VB-CABLE\VBCABLE_Setup_x64.exe') +
      ' and choose "Run as administrator", or get it from www.vb-cable.com.', mbInformation, MB_OK);
end;

function NeedRestart: Boolean;
begin
  Result := CableRan;
end;
#endif
