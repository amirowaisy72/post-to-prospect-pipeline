@echo off
REM LeadHunter - installed one-click launcher.
REM
REM Window 1 - "LeadHunter App": the app, bun run dev, http://localhost:8080/
REM Window 2 - "LeadHunter Agent": the chat agent, venv Python, http://127.0.0.1:8001
REM
REM First run only: open the app, go to Configurations and pick Gemini
REM or Ollama, then go to Agent Control, press "Sign in to Facebook" and
REM sign in yourself in the window that opens. After that the session
REM stays saved and the agent runs headless - no window, no sign-in
REM ever again.
REM
REM Keep both windows open while LeadHunter is running. To stop, close
REM both windows, or press Ctrl+C in each.
REM
REM This file is written with NO parentheses at all - an unmatched
REM close-paren in echo text inside an if/else block broke run-agent.bat
REM with ". was unexpected at this time."
setlocal
cd /d "%~dp0"

echo [leadhunter] Starting LeadHunter...

REM Find bun: prefer it on PATH, else the per-user install location.
REM Verified by running it, not by checking a bare name exists.
set "BUN=bun"
bun --version >nul 2>nul
if not errorlevel 1 goto bun_ok
set "BUN=%USERPROFILE%\.bun\bin\bun.exe"
"%BUN%" --version >nul 2>nul
if errorlevel 1 goto no_bun
:bun_ok

REM First run only: install the frontend dependencies.
if not exist "%~dp0node_modules" "%BUN%" install

REM The agent runs from its own venv - never the system Python.
set "AGENT_PY=%~dp0agent\.venv\Scripts\python.exe"
if not exist "%AGENT_PY%" goto no_venv

echo [leadhunter] Starting the app in a new window...
start "LeadHunter App" cmd /k ""%BUN%" run dev"

echo [leadhunter] Starting the agent in a new window...
start "LeadHunter Agent" /d "%~dp0agent" cmd /k ""%AGENT_PY%" -m uvicorn main:app --host 127.0.0.1 --port 8001"

echo.
echo [leadhunter] Both windows are starting:
echo [leadhunter]   App:   http://localhost:8080/
echo [leadhunter]   Agent: http://127.0.0.1:8001
echo [leadhunter] First run only: open the app, go to Configurations,
echo [leadhunter] pick Gemini or Ollama, then go to Agent Control and
echo [leadhunter] press "Sign in to Facebook" and sign in yourself.
echo [leadhunter] Keep both windows open while LeadHunter is running.

REM Wait for the app to answer, then open it in the browser.
set "TRIES=0"
:wait_app
"%SystemRoot%\System32\curl.exe" -sf http://127.0.0.1:8080/ >nul 2>nul
if not errorlevel 1 goto app_ready
set /a TRIES=%TRIES%+1
if %TRIES% GEQ 30 goto app_ready
timeout /t 2 /nobreak >nul
goto wait_app
:app_ready
start "" http://localhost:8080/
pause
exit /b 0

:no_bun
echo [leadhunter] Bun was not found. Run the installer again - it installs Bun for you.
pause
exit /b 1

:no_venv
echo [leadhunter] The agent venv was not found. Run the installer again - it sets up Python for you.
pause
exit /b 1
