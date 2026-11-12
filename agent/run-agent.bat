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

REM Tip: double-click start.bat in the repo root to start the agent
REM AND the app together — it also sets the Chrome profile for you.
REM See README.md ("Use an existing signed-in Chrome profile").
REM When the var is unset, the agent uses agent\.chrome-profile as before.

echo.
echo [leadhunter] Starting the agent at http://127.0.0.1:8001
if defined LEADHUNTER_CHROME_PROFILE (
  echo [leadhunter] Reusing your signed-in Chrome profile:
  echo [leadhunter]   %LEADHUNTER_CHROME_PROFILE%
  echo [leadhunter] No Facebook sign-in needed. Close Client Hunting
  echo [leadhunter] first if it is running — one profile can only be
  echo [leadhunter] used by one browser at a time.
) else (
  echo [leadhunter] First run: the agent runs headless, no browser
  echo [leadhunter] window appears. If Facebook asks for a sign-in,
  echo [leadhunter] run it once with LEADHUNTER_HEADED=1 and sign in
  echo [leadhunter] in the window that opens. The session stays saved
  echo [leadhunter] in agent\.chrome-profile, and the agent never asks
  echo [leadhunter] for or stores your Facebook password.
)
echo [leadhunter] Keep this window open while LeadHunter is scraping.
echo [leadhunter] Stop with Ctrl+C - the browser closes cleanly, so the
echo [leadhunter] next start never asks to restore pages.
echo.
%PY% -m uvicorn main:app --host 127.0.0.1 --port 8001
pause
