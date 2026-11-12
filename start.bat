@echo off
REM LeadHunter - one double-click starts BOTH the app and the chat agent.
REM
REM Window 1 - "LeadHunter App": the app, bun run dev, http://localhost:8080/
REM Window 2 - "LeadHunter Agent": the chat agent, run-agent.bat, http://127.0.0.1:8001
REM
REM No env var, no typing, no sign-in from this file. The agent owns its
REM own Chrome profile under agent\profiles, so it never needs another
REM app's profile. First run only: open the app, go to Agent Control,
REM press "Sign in to Facebook" and sign in yourself in the window
REM that opens. After that the session stays saved and the agent runs
REM headless - no window, no sign-in ever again.
REM
REM Keep both windows open while LeadHunter is running. To stop, close
REM both windows, or press Ctrl+C in each.
REM
REM This file is written with NO parenthesised blocks and NO parentheses
REM at all - an unmatched close-paren in echo text inside an if/else
REM block broke run-agent.bat with ". was unexpected at this time."
setlocal
cd /d "%~dp0"

echo [leadhunter] Starting LeadHunter...

REM Find bun: prefer it on PATH, else the per-user install location.
set "BUN=bun"
where bun >nul 2>nul
if errorlevel 1 set "BUN=%USERPROFILE%\.bun\bin\bun.exe"
if not exist "%BUN%" goto no_bun

REM First run only: install the frontend dependencies.
if not exist "%~dp0node_modules" "%BUN%" install

echo [leadhunter] Starting the app in a new window...
start "LeadHunter App" cmd /k ""%BUN%" run dev"

echo [leadhunter] Starting the agent in a new window...
start "LeadHunter Agent" /d "%~dp0agent" run-agent.bat

echo.
echo [leadhunter] Both windows are starting:
echo [leadhunter]   App:   http://localhost:8080/
echo [leadhunter]   Agent: http://127.0.0.1:8001
echo [leadhunter] First run only: open the app, go to Agent Control,
echo [leadhunter] press "Sign in to Facebook" and sign in yourself.
echo [leadhunter] Keep both windows open while LeadHunter is running.
pause
exit /b 0

:no_bun
echo [leadhunter] Bun was not found. Install it once in PowerShell with:
echo [leadhunter]   irm bun.sh/install.ps1 ^| iex
echo [leadhunter] then double-click start.bat again.
pause
exit /b 1
