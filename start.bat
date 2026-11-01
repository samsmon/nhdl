@echo off
title NHDL
cd /d "%~dp0"

if not exist "node_modules\pg" (
    echo Menginstal dependency backend...
    call npm install --omit=dev || goto :fail
)

if not exist "webui\dist\index.html" (
    echo Web UI is not built yet, running build...
    if not exist "webui\node_modules" call npm --prefix webui install || goto :fail
    call npm run build:ui || goto :fail
)

echo Menjalankan server di http://localhost:8080
node server/index.js
goto :eof

:fail
echo Install or build failed. Check the error messages above.
pause
exit /b 1
