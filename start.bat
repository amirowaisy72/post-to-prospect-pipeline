@echo off
REM =====================================================================
REM LeadHunter — one double-click starts everything.
REM
REM Double-click this file and it will:
REM   1. Start the scraping agent in a "LeadHunter Agent" window
REM      (http://127.0.0.1:8001).
REM   2. Start the app in a "LeadHunter App" window
REM      (http://localhost:8080).
REM   3. Open the app in your browser.
REM
REM No typing needed. The agent reuses your already-signed-in
REM Client Hunting Chrome profile, so no Facebook sign-in is needed.
REM Close Client Hunting first — one Chrome profile can only be used
REM by one browser at a time.
REM
REM NOTE: this file is intentionally written with NO labels, NO goto
REM and NO call — plain linear if/else only — because the label-based
REM wait routine failed on some PCs with "... was unexpected at this
REM time." Keep it that way.
REM =====================================================================
setlocal
cd /d "%~dp0"

echo [leadhunter] Starting LeadHunter...

REM --- Chrome profile: reuse the signed-in Client Hunting profile ---
REM Only set the default when the user has not set their own value.
if not defined LEADHUNTER_CHROME_PROFILE (
  set "LEADHUNTER_CHROME_PROFILE=G:\Web Apps\client-hunting\data\profiles\Master"
  set "PROFILE_WAS_DEFAULT=1"
)
if exist "%LEADHUNTER_CHROME_PROFILE%" (
  echo [leadhunter] Chrome profile: %LEADHUNTER_CHROME_PROFILE%
) else (
  echo [leadhunter] WARNING: Client Hunting profile not found at %LEADHUNTER_CHROME_PROFILE% — the agent will use its own fresh profile and ask for a Facebook sign-in once.
  if "%PROFILE_WAS_DEFAULT%"=="1" set "LEADHUNTER_CHROME_PROFILE="
)

REM --- Is curl available for the readiness checks? ---
where curl >nul 2>nul
if errorlevel 1 (
  echo [leadhunter] NOTE: curl was not found, so I will wait a fixed 60 seconds for each service instead of checking it.
  set "NO_CURL=1"
)

REM --- Agent ---
curl -sf -o nul http://127.0.0.1:8001/health >nul 2>&1
if not errorlevel 1 (
  echo [leadhunter] The agent is already running — reusing it. Close the "LeadHunter Agent" window first if you just pulled new code.
) else (
  echo [leadhunter] Starting the agent in a new window...
  start "LeadHunter Agent" /d "%~dp0agent" cmd /k run-agent.bat
  set "AGENT_UP="
  if defined NO_CURL (
    echo [leadhunter] Waiting for the agent (about 60 seconds)...
    timeout /t 60 /nobreak >nul
    set "AGENT_UP=1"
  ) else (
    echo [leadhunter] Waiting for the agent...
    for /l %%i in (1,1,60) do (
      if not defined AGENT_UP (
        curl -sf -o nul http://127.0.0.1:8001/health >nul 2>&1
        if not errorlevel 1 set "AGENT_UP=1"
        if not defined AGENT_UP timeout /t 2 /nobreak >nul
      )
    )
  )
  if not defined AGENT_UP (
    echo [leadhunter] The agent did not answer after 120 seconds. Check the "LeadHunter Agent" window for the error, then double-click start.bat again.
    pause
    exit /b 1
  )
  echo [leadhunter] Agent is up at http://127.0.0.1:8001
)

REM --- Frontend ---
curl -sf -o nul http://localhost:8080/ >nul 2>&1
if not errorlevel 1 (
  echo [leadhunter] The app is already running — reusing it. Close the "LeadHunter App" window first if you just pulled new code.
) else (
  REM Find bun: prefer it on PATH, else the per-user install location.
  set "BUN=bun"
  where bun >nul 2>nul
  if errorlevel 1 (
    if exist "%USERPROFILE%\.bun\bin\bun.exe" (
      set "BUN=%USERPROFILE%\.bun\bin\bun.exe"
    ) else (
      echo [leadhunter] Bun was not found. Install it once in PowerShell with:
      echo [leadhunter]   irm bun.sh/install.ps1 ^| iex
      echo [leadhunter] then double-click start.bat again.
      pause
      exit /b 1
    )
  )
  if not exist "%~dp0node_modules" (
    echo [leadhunter] Installing frontend dependencies (first run only)...
    "%BUN%" install
    if errorlevel 1 (
      echo [leadhunter] bun install failed — check your connection and try again.
      pause
      exit /b 1
    )
  )
  echo [leadhunter] Starting the app in a new window...
  start "LeadHunter App" /d "%~dp0" cmd /k ""%BUN%" run dev"
  set "APP_UP="
  if defined NO_CURL (
    echo [leadhunter] Waiting for the app (about 60 seconds)...
    timeout /t 60 /nobreak >nul
    set "APP_UP=1"
  ) else (
    echo [leadhunter] Waiting for the app...
    for /l %%i in (1,1,60) do (
      if not defined APP_UP (
        curl -sf -o nul http://localhost:8080/ >nul 2>&1
        if not errorlevel 1 set "APP_UP=1"
        if not defined APP_UP timeout /t 2 /nobreak >nul
      )
    )
  )
  if not defined APP_UP (
    echo [leadhunter] The app did not answer after 120 seconds. Check the "LeadHunter App" window for the error, then double-click start.bat again.
    pause
    exit /b 1
  )
  echo [leadhunter] App is up at http://localhost:8080/
)

echo [leadhunter] Opening http://localhost:8080/ in your browser...
start "" "http://localhost:8080/"
echo [leadhunter] Done — LeadHunter is running. Keep the "LeadHunter Agent" and "LeadHunter App" windows open.
echo [leadhunter] To stop everything, close both windows.
pause
exit /b 0
