@echo off
title Pollinator Panic - local server
cd /d "C:\Users\SujithKumar R\OneDrive\Desktop\pollinator-panic"
echo ================================================
echo   Pollinator Panic  -^>  http://localhost:8080
echo   Keep this window OPEN. Ctrl+C stops the server.
echo ================================================
start "" http://localhost:8080
python -m http.server 8080 --bind 127.0.0.1
pause
