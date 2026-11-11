@echo off
REM LeadHunter scraping agent — run this on your PC (Windows, Python 3.14).
REM It installs the dependencies, installs Chromium for Playwright, then
REM serves the agent at http://127.0.0.1:8001 for the LeadHunter frontend.
setlocal
cd /d "%~dp0"

REM Python 3.14 on some PCs is only reachable via the `py` launcher
REM (`python` is not on PATH). Prefer `python`, fall back to `py`.
set "PY=python"
where python >nul 2>nul
if errorlevel 1 (
  set "PY=py"
  where py >nul 2>nul
  if errorlevel 1 (
    echo [leadhunter] Python was not found. Install Python 3.14 from
    echo [leadhunter] https://www.python.org/downloads/ (tick "Add python to PATH"),
    echo [leadhunter] then run this file again.
    pause
    exit /b 1
  )
)

echo [leadhunter] Installing dependencies...
%PY% -m pip install -r requirements.txt
if errorlevel 1 (
  echo [leadhunter] pip install failed — check your connection and try again.
  pause
  exit /b 1
)

echo [leadhunter] Installing Chromium for Playwright (first run only)...
%PY% -m playwright install chromium
if errorlevel 1 (
  echo [leadhunter] Playwright Chromium install failed — try again.
  pause
  exit /b 1
)

REM Optional: reuse an already-signed-in Chrome profile instead of
REM the agent's own fresh one — e.g. the Client Hunting profile, so
REM no Facebook sign-in is needed. Close Client Hunting first (one
REM profile can only be used by one browser at a time), then:
REM   set "LEADHUNTER_CHROME_PROFILE=G:\Web Apps\client-hunting\data\profiles\Master"
REM See README.md ("Use an existing signed-in Chrome profile").
REM When the var is unset, the agent uses agent\.chrome-profile as before.

echo.
echo [leadhunter] Starting the agent at http://127.0.0.1:8001
echo [leadhunter] First run: start a Scrap/Sync in LeadHunter and a Chrome
echo [leadhunter] window will open — sign in to Facebook there ONCE.
echo [leadhunter] The session stays saved in agent\.chrome-profile, and the
echo [leadhunter] agent never asks for or stores your Facebook password.
echo [leadhunter] Keep this window open while LeadHunter is scraping.
echo.
%PY% -m uvicorn main:app --host 127.0.0.1 --port 8001
pause
