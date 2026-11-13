; LeadHunter installer — Inno Setup (v1.0.0).
; Compile on the Windows build machine / GitHub Actions
; windows-latest runner from the REPO ROOT:
;   iscc /DMyAppVersion=1.0.0 /DAppSrc="<repo root>" installer/leadhunter.iss
; Produces LeadHunter-Setup-<version>.exe in installer/installer-output/
; (next to this script).
;
; How it works:
; - The app payload (src/, agent/, public/, extension/, package.json,
;   bun.lock, ...) is copied to {app}\.payload-new — a staging folder.
;   installer\setup-helper.ps1 then diffs it into {app} with a SHA-256
;   manifest, so an update copies only added/changed files and never
;   rewrites what is already fine. User data is never in the manifest
;   and never touched: agent\profiles\, agent\leadhunter.db and the
;   browser's localStorage stay exactly as they are.
; - The seed database (installer's seed copy, when bundled) and the
;   seed data file (public\seed.json) are copied by setup-helper.ps1
;   ONLY on a fresh install, when the target has no copy yet. On an
;   update they are never overwritten.
; - Bun, Python 3.14, the agent venv, Playwright Chromium, node_modules
;   and Ollama are all installed by setup-helper.ps1 at install time
;   (downloads with aria2c, SHA-256 verified). Ollama is MANDATORY:
;   if Ollama or either model cannot be installed, the whole install
;   stops with a clear message.
; - PrivilegesRequired=lowest (per-user, no UAC prompt) with
;   DefaultDirName={localappdata}\LeadHunter: the app writes its
;   database and agent profiles next to the install, which Program
;   Files would not allow without admin. The user still picks the
;   folder in the wizard (directory page on).
; - Unsigned builds trigger Windows SmartScreen ("Windows protected
;   your PC" -> More info -> Run anyway). A code-signing certificate
;   costs money; v1.0.0 ships unsigned with that note in the
;   first-run guide.

#define MyAppName "LeadHunter"
#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif
#ifndef AppSrc
  #define AppSrc "."
#endif
#define MyAppPublisher "LeadHunter"
#define MyAppURL "https://github.com/amirowaisy72/post-to-prospect-pipeline"

[Setup]
AppId={{410936EC-5552-4544-97B8-3C298BC2D6B6}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
; The user picks the folder in the wizard (directory page on).
DefaultDirName={localappdata}\{#MyAppName}
DisableDirPage=no
; Per-user install: no UAC prompt, friendlier for the partner.
PrivilegesRequired=lowest
OutputDir=installer-output
OutputBaseFilename=LeadHunter-Setup-{#MyAppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
; The app needs internet at install time (Bun, Python, Chromium,
; node_modules, Ollama + both models) and at first run (Facebook
; sign-in, Gemini or Ollama). After that it runs on localhost only.

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; App payload -> staging. setup-helper.ps1 diffs it into {app}.
Source: "{#AppSrc}\build\payload\*"; DestDir: "{app}\.payload-new"; Flags: ignoreversion recursesubdirs createallsubdirs
; Installer worker + downloader + download manifest.
Source: "{#AppSrc}\build\installer\setup-helper.ps1"; DestDir: "{app}\installer"; Flags: ignoreversion
Source: "{#AppSrc}\build\installer\aria2c.exe"; DestDir: "{app}\installer"; Flags: ignoreversion
Source: "{#AppSrc}\build\installer\downloads.json"; DestDir: "{app}\installer"; Flags: ignoreversion
; One-click launcher (repo start.bat stays the dev launcher).
Source: "{#AppSrc}\build\installer\Run-LeadHunter.bat"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\Run-LeadHunter.bat"; WorkingDir: "{app}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\Run-LeadHunter.bat"; WorkingDir: "{app}"; Tasks: desktopicon

[Code]
var
  SetupOK: Boolean;

function SetupSucceeded(): Boolean;
begin
  Result := SetupOK;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  Params: String;
begin
  if CurStep = ssPostInstall then
  begin
    SetupOK := False;
    Params := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\installer\setup-helper.ps1') + '" -AppDir "' + ExpandConstant('{app}') + '"';
    if Exec('powershell.exe', Params, '', SW_SHOW, ewWaitUntilTerminated, ResultCode) then
    begin
      if ResultCode = 0 then
        SetupOK := True
      else
        MsgBox('LeadHunter setup failed. Ollama and both models are required - open {app}\installer\setup.log to see why, then run the installer again.', mbError, MB_OK);
    end
    else
    begin
      MsgBox('LeadHunter setup could not start PowerShell. Open {app}\installer\setup-helper.ps1 by hand and check setup.log.', mbError, MB_OK);
    end;
  end;
end;

[Run]
; Offer to open LeadHunter when setup finishes — only when the
; setup helper actually succeeded.
Filename: "{app}\Run-LeadHunter.bat"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent; Check: SetupSucceeded
