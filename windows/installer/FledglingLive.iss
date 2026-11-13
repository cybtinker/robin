; Fledgling Live installer (Inno Setup 6, free for commercial use).
; Per-user install, no admin prompt, silent install with /VERYSILENT (needed for a Microsoft Store EXE listing).
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

[Files]
Source: "..\build\FledglingLive.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\THIRD-PARTY-NOTICES.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\Fledgling Live"; Filename: "{app}\FledglingLive.exe"
Name: "{userdesktop}\Fledgling Live"; Filename: "{app}\FledglingLive.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Run]
Filename: "{app}\FledglingLive.exe"; Description: "Start Fledgling Live"; Flags: nowait postinstall skipifsilent
