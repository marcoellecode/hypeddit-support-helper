@echo off
rem Avvia l'app: parte il server e si apre da sola l'interfaccia grafica nel browser.
rem Usa Node dal PATH; se non c'e', prova un Node portatile in %USERPROFILE%\tools\node.
rem Chiudi questa finestra per fermare l'app.
where node >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\tools\node\node.exe" (
    set "PATH=%USERPROFILE%\tools\node;%PATH%"
  ) else (
    echo Node.js non trovato. Installalo da https://nodejs.org ^(versione LTS^) e riprova.
    pause
    exit /b 1
  )
)
cd /d "%~dp0"
if not exist node_modules (
  echo Prima esecuzione: installo le dipendenze...
  call npm install --omit=dev
)
title Hypeddit Support Helper
node server.js
pause
