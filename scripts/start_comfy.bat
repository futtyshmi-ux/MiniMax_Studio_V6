@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0.."

set "COMFY_ROOT=ComfyUI-Easy-Install"

REM Read VRAM config from config.ini (optional, defaults: reserve=3, dynamic=1)
REM First matching line wins — immune to stray duplicate keys from old configs.
set "RESERVE_VRAM="
set "DYNAMIC_VRAM="
set "ASYNC_OFFLOAD="
if exist config\config.ini (
    for /f "tokens=2 delims==" %%a in ('findstr /i "reserve_gb" config\config.ini 2^>nul') do if not defined RESERVE_VRAM set "RESERVE_VRAM=%%a"
    for /f "tokens=2 delims==" %%a in ('findstr /i "dynamic_vram" config\config.ini 2^>nul') do if not defined DYNAMIC_VRAM set "DYNAMIC_VRAM=%%a"
    for /f "tokens=2 delims==" %%a in ('findstr /i "async_offload" config\config.ini 2^>nul') do if not defined ASYNC_OFFLOAD set "ASYNC_OFFLOAD=%%a"
)
if not defined RESERVE_VRAM set "RESERVE_VRAM=3"
if not defined DYNAMIC_VRAM set "DYNAMIC_VRAM=1"
REM (правка) async_offload по умолчанию = 0 (выключен). comfy-aimdo 0.4.13
REM на Windows+NVIDIA падает при загрузке больших моделей (~20 ГБ):
REM   hostbuf_file_reader_read failed / HostBuffer.read_file_slice failed,
REM   GetOverlappedResult error=1450/1453 (нехватка системных ресурсов).
REM Причина — async weight offloading (2 потока) + pinned memory. Выключаем их,
REM и модель грузится синхронно и стабильно. Включить обратно (быстрее
REM загрузка, но на RTX 50xx может падать): async_offload=1 в config\config.ini.
if not defined ASYNC_OFFLOAD set "ASYNC_OFFLOAD=0"
set "RESERVE_VRAM=%RESERVE_VRAM:"=%"
set "DYNAMIC_VRAM=%DYNAMIC_VRAM:"=%"
set "ASYNC_OFFLOAD=%ASYNC_OFFLOAD:"=%"
set "EXTRA_FLAGS="
if not "%ASYNC_OFFLOAD%"=="1" set "EXTRA_FLAGS=--disable-async-offload --disable-pinned-memory"

REM ============================================================
REM  [CHECK] Block auto-update if .no-auto-update flag exists
REM ============================================================
REM (правка 132) ComfyUI-Easy-Install может автоматически обновляться
REM  и подтянуть новую версию, несовместимую со старой структурой.
REM  Папка .no-auto-update — флаг: если она существует, обновления
REM  запрещены. Это защищает от случайного обновления до несовместимой
REM  версии.
if exist "%COMFY_ROOT%\.no-auto-update" (
    echo  [OK] Auto-update blocked (.no-auto-update flag present).
    echo       ComfyUI will NOT update itself.
) else (
    echo  [WARN] Auto-update NOT blocked.
    echo         ComfyUI-Easy-Install may update itself and break.
    echo         To block: mkdir ComfyUI-Easy-Install\.no-auto-update
)

REM ============================================================
REM  [CHECK] Verify ComfyUI version compatibility
REM ============================================================
REM (правка 131) ComfyUI-Easy-Install может автоматически обновляться
REM  и подтянуть новую версию, несовместимую со старой структурой
REM  (comfy.ldm убрали, но execution.py всё ещё импортирует).
REM  Проверяем, что comfy.ldm существует — иначе ComfyUI упадёт
REM  с ModuleNotFoundError.
if not exist "%COMFY_ROOT%\ComfyUI\comfy\ldm\models\autoencoder.py" (
    echo.
    echo  [ERROR] Incompatible ComfyUI version detected.
    echo          The 'comfy.ldm' module is missing, but execution.py
    echo          still imports it. This happens when ComfyUI-Easy-Install
    echo          auto-updates to a new version.
    echo.
    echo  Solution: revert to a stable version.
    echo    cd ComfyUI-Easy-Install\update
    echo    update_comfyui_stable.bat
    echo.
    pause
    exit /b 1
)
echo  [OK] ComfyUI version compatible.

REM Launch ComfyUI
if "%DYNAMIC_VRAM%"=="0" (
    "%COMFY_ROOT%\python_embeded\python.exe" -I "%COMFY_ROOT%\ComfyUI\main.py" --windows-standalone-build --use-ck-attention --disable-auto-launch --reserve-vram %RESERVE_VRAM% --disable-dynamic-vram %EXTRA_FLAGS%
    exit /b %errorlevel%
) else (
    "%COMFY_ROOT%\python_embeded\python.exe" -I "%COMFY_ROOT%\ComfyUI\main.py" --windows-standalone-build --use-ck-attention --disable-auto-launch --reserve-vram %RESERVE_VRAM% %EXTRA_FLAGS%
    exit /b %errorlevel%
)
