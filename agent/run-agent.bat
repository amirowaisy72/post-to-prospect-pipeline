@echo off
REM LeadHunter chat agent - run this on your PC (Windows, Python 3.14).
REM It installs the dependencies, installs Chromium for Playwright, then
REM serves the agent at http://127.0.0.1:8001 for the LeadHunter frontend.
REM The agent owns its own Chrome profile under agent\profiles\<account> -
REM it never uses another app's profile. First run only: open LeadHunter,
REM go to Agent Control, press "Sign in to Facebook", and sign in yourself
REM in the window that opens. After that the session stays saved and the
REM agent runs headless - no window appears, no sign-in ever again.
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
    echo [leadhunter] https://www.python.org/downloads/ - tick "Add python to PATH",
    echo [leadhunter] then run this file again.
    pause
    exit /b 1
  )
)

echo [leadhunter] Installing dependencies...
%PY% -m pip install -r requirements.txt
if errorlevel 1 (
  echo [leadhunter] pip install failed - check your connection and try again.
  pause
  exit /b 1
)

echo [leadhunter] Installing Chromium for Playwright - first run only.
%PY% -m playwright install chromium
if errorlevel 1 (
  echo [leadhunter] Playwright Chromium install failed - try again.
  pause
  exit /b 1
)

echo.
echo [leadhunter] Starting the agent at http://127.0.0.1:8001
echo [leadhunter] The agent runs headless - no browser window appears.
echo [leadhunter] First run: open LeadHunter, go to Agent Control, press
echo [leadhunter] "Sign in to Facebook" and sign in yourself in the window
echo [leadhunter] that opens. Then press "Relaunch browser" to go back to
echo [leadhunter] silent headless. The session stays saved in
echo [leadhunter] agent\profiles, and the agent never asks for or stores
echo [leadhunter] your Facebook password.
echo [leadhunter] Keep this window open while LeadHunter is chatting.
echo [leadhunter] Stop with Ctrl+C - the browser closes cleanly, so the
echo [leadhunter] next start never asks to restore pages.
echo.
%PY% -m uvicorn main:app --host 127.0.0.1 --port 8001
pause
