@echo off
cd /d "%~dp0"
if not exist ".env\Scripts\python.exe" (
  echo Install Python and the dependencies using README.md first.
  pause
  exit /b 1
)
".env\Scripts\python.exe" app.py
if errorlevel 1 pause
