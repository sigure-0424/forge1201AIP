@echo off
<<<<<<< HEAD
title Forge AI Player System
cd /d "%~dp0"

:: Check Node.js
where node
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Please install from https://nodejs.org
    pause
    exit /b 1
)

:: Install dependencies if node_modules is missing
if not exist "node_modules\" (
    echo [Setup] Installing dependencies...
    npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

:: Create .env if it does not exist
if not exist ".env" (
    echo [Setup] Creating default .env file...
    (
        echo OLLAMA_URL=http://localhost:11434/api/generate
        echo OLLAMA_MODEL=gpt-oss:20b-cloud
        echo OLLAMA_API_KEY=
        echo MC_HOST=localhost
        echo MC_PORT=25565
        echo BOT_NAMES=AI_Bot_01
        echo WEBUI_PORT=3000
    ) > .env
    echo [Setup] .env created. Edit it to set your server address and model, then re-run.
    pause
    exit /b 0
)

:: Launch
echo.
echo  =========================================================
echo   Forge AI Player System
echo  =========================================================
echo   Dashboard: http://localhost:3000
echo   Press Ctrl+C to stop.
echo  =========================================================
echo.

node index.js 2>&1
set EXITCODE=%errorlevel%

echo.
if %EXITCODE% neq 0 (
    echo [ERROR] Process exited with code %EXITCODE%.
) else (
    echo [INFO] Process ended.
)
echo.
echo Press any key to close this window...
pause > nul
