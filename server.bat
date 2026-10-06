@echo off
rem Windows entrypoint: runs server.py with the first Python 3.7+ found (py launcher, then python).
setlocal
set "SCRIPT=%~dp0server.py"
set "CHECK=import sys; sys.exit(sys.version_info < (3, 7))"

py -3 -c "%CHECK%" >nul 2>&1
if not errorlevel 1 (
  py -3 "%SCRIPT%" %*
  goto end
)
python -c "%CHECK%" >nul 2>&1
if not errorlevel 1 (
  python "%SCRIPT%" %*
  goto end
)
echo [ERROR] Python 3.7 ou mais novo nao encontrado. 1>&2
echo         Instale de https://www.python.org/downloads/ (marque "Add python.exe to PATH") 1>&2
echo         ou: winget install Python.Python.3.12 1>&2
exit /b 1

:end
exit /b %ERRORLEVEL%
