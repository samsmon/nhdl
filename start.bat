@echo off
title NHDL
cd /d "%~dp0"

if not exist "webui\dist\index.html" (
    echo Web UI belum di-build, menjalankan build...
    if not exist "webui\node_modules" call npm --prefix webui install || goto :fail
    call npm run build:ui || goto :fail
)

echo Menjalankan server di http://localhost:8080
node server/index.js
goto :eof

:fail
echo Build Web UI gagal. Periksa pesan error di atas.
pause
exit /b 1
