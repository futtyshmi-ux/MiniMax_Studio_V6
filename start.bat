@echo off
chcp 65001 >nul
setlocal EnableExtensions

REM (правка 100) Свёрнутый запуск: bat не может менять состояние СВОЕГО
REM окна — поэтому при обычном запуске перезапускаем себя в свёрнутом
REM окне и выходим. Аргумент :minimized — защита от бесконечного цикла.
if /i "%~1"==":minimized" goto main
start "" /min "%~f0" :minimized
exit /b

:main
title MiniMax H3 Studio
cd /d "%~dp0"

set PORT=3000
set COMFY_PORT=8188
set "COMFY_ROOT=ComfyUI-Easy-Install"

echo.
echo  ============================================
echo    MiniMax H3 Studio
echo  ============================================
echo.

REM ============================================================
REM  [CHECK 1/5] Node.js — PATH first, then bundled runtime\node.exe
REM ============================================================
set "NODE_CMD="
where node >nul 2>&1
if %errorlevel% equ 0 (
    set "NODE_CMD=node"
    echo  [OK] Node.js found in PATH
) else if exist "%~dp0runtime\node.exe" (
    set "NODE_CMD=%~dp0runtime\node.exe"
    echo  [OK] Node.js not in PATH - using bundled runtime\node.exe
) else (
    echo.
    echo  [ERROR] Node.js not found: neither in PATH nor as runtime\node.exe.
    echo          Install Node.js 18+ LTS from https://nodejs.org and
    echo          restart this script, or copy node.exe into the runtime\
    echo          folder next to start.bat.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('"%NODE_CMD%" --version') do set NODE_VER=%%v
echo  [OK] Node.js %NODE_VER%

REM ============================================================
REM  [CHECK 2/5] ComfyUI folder
REM ============================================================
if not exist "%COMFY_ROOT%\python_embeded\python.exe" (
    echo.
    echo  [WARN] ComfyUI not found at: %COMFY_ROOT%
    echo         Expected folder: %~dp0%COMFY_ROOT%\python_embeded\python.exe
    echo         Place the ComfyUI-Easy-Install folder next to this project.
    echo.
    set /p CONTINUE=         Start Web UI anyway, frontend only [Y/N]:
    if /i "%CONTINUE%"=="Y" goto web_ui
    pause
    exit /b 0
)
echo  [OK] ComfyUI found: %COMFY_ROOT%

REM ============================================================
REM  [CHECK 3/5] node_modules (auto-install; needs real npm)
REM ============================================================
if exist "node_modules" (
    echo  [OK] Dependencies present.
) else (
    where npm >nul 2>&1
    if errorlevel 1 (
        echo.
        echo  [ERROR] node_modules not found and npm is unavailable.
        echo          Copy the project together with node_modules\ from the
        echo          source PC - same Windows x64 - or install full Node.js
        echo          18+ from https://nodejs.org first.
        echo.
        pause
        exit /b 1
    )
    echo  [INSTALL] node_modules not found - running npm install...
    call npm install
    if errorlevel 1 (
        echo  [ERROR] npm install failed.
        pause
        exit /b 1
    )
    echo  [OK] Dependencies installed.
)

REM ============================================================
REM  [CHECK 4/5] Production build (auto-build; needs real npm)
REM ============================================================
if exist ".next\BUILD_ID" (
    echo  [OK] Build present.
) else (
    where npm >nul 2>&1
    if errorlevel 1 (
        echo.
        echo  [ERROR] .next build not found and npm is unavailable.
        echo          Copy the project together with the .next\ folder from
        echo          the source PC, or install full Node.js 18+ first.
        echo.
        pause
        exit /b 1
    )
    echo  [BUILD] .next build not found - running npm run build...
    call npm run build
    if errorlevel 1 (
        echo  [ERROR] Build failed.
        pause
        exit /b 1
    )
    echo  [OK] Production build complete.
)

REM ============================================================
REM  [ правка 97] Start Web UI FIRST — браузер с экраном-заставкой
REM  открывается сразу, не дожидаясь загрузки ComfyUI (30-90 с).
REM  Заставка (/splash) сама опрашивает /api/comfy/health и переходит
REM  в приложение, когда бэкенд готов.
REM ============================================================
echo.
echo  Starting web UI...

REM Kill any existing process on web port (только LISTENING — см. выше)
for /f "tokens=5" %%p in ('netstat -aon ^| findstr /C:":%PORT% " ^| findstr /C:"LISTENING" 2^>nul') do (
    taskkill /F /PID %%p >nul 2>&1
)
timeout /t 1 /nobreak >nul

set NODE_ENV=production

REM Веб-сервер — в фоне: он нужен ПРЯМО СЕЙЧАС, чтобы отдать заставку.
start /b "" "%NODE_CMD%" server.js

REM Ждём, пока веб-сервер начнёт отвечать (обычно 1-3 с)
echo       Starting web server...
set /a wt=0
:wait_web
set /a wt+=1
if %wt% gtr 30 (
    echo  [ERROR] Web server did not start within 60s.
    pause
    exit /b 1
)
powershell -NoProfile -Command "try { [void](Invoke-WebRequest -Uri 'http://127.0.0.1:%PORT%/splash' -TimeoutSec 3 -UseBasicParsing); exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% equ 0 goto web_ready
timeout /t 2 /nobreak >nul
goto wait_web

:web_ready
echo  [OK] Web UI is up.

echo.
echo  ============================================
echo    Web UI:   http://localhost:%PORT%
echo    ComfyUI:  http://127.0.0.1:%COMFY_PORT%
echo    Backend:  %COMFY_ROOT%
echo  ============================================
echo.
echo  Opening browser (splash screen)...
echo.

REM (правка 128) Открываем браузер поверх всех окон (не в фоне).
REM explorer.exe — простой вариант, но Windows foreground-lock может не дать
REM взять фокус. (правка 129b) Надёжный способ — PowerShell + SetForegroundWindow.
call :open_browser_foreground http://localhost:%PORT%/splash

REM ============================================================
REM  Start ComfyUI backend
REM ============================================================
echo.
echo  Starting ComfyUI backend...

REM Kill any existing process on ComfyUI port
REM ВАЖНО: два findstr /C: подряд. Одиночный findstr ":port .*LISTENING"
REM в литеральном режиме делит шаблон по пробелам на ИЛИ-альтернативы и
REM матчит ЛЮБУЮ строку с ":port" (включая ESTABLISHED-соединения браузера
REM и node) — taskkill /F убивал бы весь браузер пользователя.
for /f "tokens=5" %%p in ('netstat -aon ^| findstr /C:":%COMFY_PORT% " ^| findstr /C:"LISTENING" 2^>nul') do (
    taskkill /F /PID %%p >nul 2>&1
)
timeout /t 2 /nobreak >nul

REM Start ComfyUI in background (правка 140) — запускаем python.exe напрямую
REM Читаем настройки из config\config.ini (как в start_comfy.bat)
set "RESERVE_VRAM=3"
set "DYNAMIC_VRAM=1"
set "ASYNC_OFFLOAD=0"
if exist config\config.ini (
    for /f "tokens=2 delims==" %%a in ('findstr /i "reserve_gb" config\config.ini 2^>nul') do if not defined RESERVE_VRAM set "RESERVE_VRAM=%%a"
    for /f "tokens=2 delims==" %%a in ('findstr /i "dynamic_vram" config\config.ini 2^>nul') do if not defined DYNAMIC_VRAM set "DYNAMIC_VRAM=%%a"
    for /f "tokens=2 delims==" %%a in ('findstr /i "async_offload" config\config.ini 2^>nul') do if not defined ASYNC_OFFLOAD set "ASYNC_OFFLOAD=%%a"
)
set "EXTRA_FLAGS="
if not "%ASYNC_OFFLOAD%"=="1" set "EXTRA_FLAGS=--disable-async-offload --disable-pinned-memory"

REM Запускаем ComfyUI напрямую
start /b "" "%COMFY_ROOT%\python_embeded\python.exe" -I "%COMFY_ROOT%\ComfyUI\main.py" --windows-standalone-build --use-ck-attention --disable-auto-launch --reserve-vram %RESERVE_VRAM% %EXTRA_FLAGS%

REM Wait for ComfyUI to be ready (заставка в браузере покажет это сама)
echo       Waiting for ComfyUI (first start can take 30-90s)...
set /a tries=0
:wait_comfy
set /a tries+=1
if %tries% gtr 120 (
    echo.
    echo  [WARN] ComfyUI did not start within 240s.
    echo  Splash screen keeps waiting - check the output above.
    echo.
    goto keepalive
)
powershell -NoProfile -Command "try { [void](Invoke-WebRequest -Uri 'http://127.0.0.1:%COMFY_PORT%/' -TimeoutSec 3 -UseBasicParsing); exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% equ 0 goto comfy_ready
timeout /t 2 /nobreak >nul
goto wait_comfy

:comfy_ready
echo  [OK] ComfyUI is ready. Browser will enter the studio automatically.

REM ============================================================
REM  Keepalive: консоль держит фоновые процессы (веб + ComfyUI).
REM  Закрытие окна = остановка всего (как и раньше).
REM ============================================================
:keepalive
echo.
echo  To STOP: close this window.
echo.
:keepalive_loop
timeout /t 30 /nobreak >nul
goto keepalive_loop

REM ============================================================
REM (правка 129b) Субрутина: открыть URL в браузере ПОВЕРХ всех окон.
REM
REM Windows foreground-lock не даёт скрипту напрямую взять фокус.
REM Рабочий обход: Start-Process открывает браузер, а через 500 мс
REM PowerShell через Win32 P/Invoke SetForegroundWindow принудительно
REM поднимает окно браузера на первый план (это работает, т.к. вызов
REM идёт из процесса, запущенного через Start-Process — у него есть
REM разрешение на SetForegroundWindow).
REM ============================================================
:open_browser_foreground
setlocal
set "_URL=%~1"

REM 1) Открываем URL в браузере по умолчанию (Start-Process даёт новый
REM    процесс, у которого Windows разрешает SetForegroundWindow).
powershell -NoProfile -Command "Start-Process -FilePath '%_URL%'" >nul 2>&1

REM 2) Через 500 мс принудительно поднимаем окно браузера на передний план.
REM    (Если браузер ещё не создал окно — SetForegroundWindow молча
REM    пройдёт мимо; если окно уже есть — оно возьмёт фокус.)
REM (правка 130) Убрали `^`-продолжения: cmd их убирает, но PowerShell
REM    видит как аргумент → Add-Type падал с "positional parameter '")".
REM    Теперь одна строка, без продолжений.
timeout /t 1 /nobreak >nul
powershell -NoProfile -Command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class FG { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int n); [DllImport(\"user32.dll\")] public static extern bool IsZoomed(IntPtr hWnd); public static void BringToFront() { IntPtr fg = GetForegroundWindow(); if (fg != IntPtr.Zero) { if (!IsZoomed(fg)) { ShowWindow(fg, 3); } SetForegroundWindow(fg); } } }' ; [FG]::BringToFront()" >nul 2>&1

endlocal
goto :eof
