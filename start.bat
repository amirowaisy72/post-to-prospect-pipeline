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
if not errorlevel 1 goto agent_running
echo [leadhunter] Starting the agent in a new window...
start "LeadHunter Agent" /d "%~dp0agent" cmd /k run-agent.bat
call :wait_for "http://127.0.0.1:8001/health" "agent" 120
if errorlevel 1 (
  echo [leadhunter] The agent did not answer after 120 seconds. Check the "LeadHunter Agent" window for the error, then double-click start.bat again.
  pause
  exit /b 1
)
echo [leadhunter] Agent is up at http://127.0.0.1:8001
goto frontend
:agent_running
echo [leadhunter] The agent is already running — reusing it. Close the "LeadHunter Agent" window first if you just pulled new code.

:frontend
REM --- Frontend ---
curl -sf -o nul http://localhost:8080/ >nul 2>&1
if not errorlevel 1 goto app_running

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
call :wait_for "http://localhost:8080/" "app" 120
if errorlevel 1 (
  echo [leadhunter] The app did not answer after 120 seconds. Check the "LeadHunter App" window for the error, then double-click start.bat again.
  pause
  exit /b 1
)
echo [leadhunter] App is up at http://localhost:8080/
goto open_browser
:app_running
echo [leadhunter] The app is already running — reusing it. Close the "LeadHunter App" window first if you just pulled new code.

:open_browser
echo [leadhunter] Opening http://localhost:8080/ in your browser...
start "" "http://localhost:8080/"
echo [leadhunter] Done — LeadHunter is running. Keep the "LeadHunter Agent" and "LeadHunter App" windows open.
echo [leadhunter] To stop everything, close both windows.
pause
exit /b 0

REM --- Wait until a URL answers, or give up after %3 seconds ---
REM %1 = URL, %2 = name shown in messages, %3 = max seconds.
:wait_for
set "WAIT_URL=%~1"
set "WAIT_NAME=%~2"
set "WAIT_MAX=%~3"
set "WAITED=0"
if defined NO_CURL (
  echo [leadhunter] Waiting for the %WAIT_NAME% (about 60 seconds)...
  timeout /t 60 /nobreak >nul
  exit /b 0
)
echo [leadhunter] Waiting for the %WAIT_NAME%...
:wait_loop
curl -sf -o nul "%WAIT_URL%" >nul 2>&1
if not errorlevel 1 exit /b 0
timeout /t 2 /nobreak >nul
set /a WAITED+=2
if %WAITED% geq %WAIT_MAX% exit /b 1
goto wait_loop
