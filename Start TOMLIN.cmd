@echo off
rem Starts TOMLIN without installing it and opens it in its own window (Install TOMLIN.cmd installs it
rem instead, with a Start menu entry and no console window). Nothing loads until you press Connect. Closing this window stops TOMLIN and every model it loaded, and frees the memory.
title TOMLIN
cd /d "%~dp0"
rem The copy's own Node.js (runtime\node) first, so a PC without Node.js runs it too.
if exist "%~dp0runtime\node\node.exe" set "PATH=%~dp0runtime\node;%PATH%"
where node >nul 2>nul || (echo Node.js is not installed. Install it from https://nodejs.org ^(version 22.18 or newer^), then start TOMLIN again. & pause & exit /b 1)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)" || (echo This Node.js is too old for TOMLIN. Install version 22.18 or newer from https://nodejs.org, then start TOMLIN again. & pause & exit /b 1)
if not exist node_modules\sharp (echo Installing the picture tools ^(one time^)... & call npm install --omit=dev --no-audit --no-fund || (pause & exit /b 1))
if not exist runtime\llama-cpu\llama-server.exe (echo The model runners are missing. Downloading them now... & call npm run fetch || (pause & exit /b 1))
if not exist runtime\sd-cpu\sd-server.exe (echo The model runners are missing. Downloading them now... & call npm run fetch || (pause & exit /b 1))
rem The model runners need Microsoft's Visual C++ Runtime (src/vcrt.ts); a clean Windows lacks it. Said, not stopped.
set SM_NO_VCRT=
for %%f in (vcruntime140.dll vcruntime140_1.dll msvcp140.dll msvcp140_1.dll msvcp140_atomic_wait.dll msvcp140_codecvt_ids.dll vcomp140.dll) do if not exist "%SystemRoot%\System32\%%f" set SM_NO_VCRT=1
if defined SM_NO_VCRT (echo. & echo  This PC does not have the Microsoft Visual C++ Runtime, which the model runners need: TOMLIN opens, but no model will load. & echo  Install it from Microsoft: https://aka.ms/vc14/vc_redist.x64.exe ^(or run "Install TOMLIN.cmd", which offers it^), then press Connect. & echo.)
rem The browser opens once TOMLIN is ready (src/server.ts), not before.
if not defined TOMLIN_NO_BROWSER set TOMLIN_OPEN=1
rem TOMLIN ends with code 75 to start again (to bring in an older copy's data, or put a backup back), and with
rem code 76 to start a newer copy beside this one (updated from a linked PC): its folder is in next-copy.txt.
set TOMLIN_LOOP=1
:run
node src/server.ts
set "TOMLIN_CODE=%errorlevel%"
rem A new copy that answered once (src/server.ts leaves .started-ok) is the one to keep: no going back from here on.
if exist ".started-ok" (del ".started-ok" & set TOMLIN_PREV=& set TOMLIN_FAILED=)
rem 78: the installed program (TOMLIN.exe) took over from this one (My PC, Repair install): this window closes.
if %TOMLIN_CODE%==78 exit /b 0
rem 77: TOMLIN already runs (its lines above say where): nothing to start again.
if %TOMLIN_CODE%==77 (pause & exit /b 1)
if %TOMLIN_CODE%==75 (set TOMLIN_OPEN=& echo Starting TOMLIN again... & goto run)
if %TOMLIN_CODE%==76 goto next
if defined TOMLIN_PREV goto back
pause
exit /b
:back
rem The new copy (pushed from a linked PC) ended before it ever answered: the copy before it starts again.
echo The new version did not start. Starting the version before it again...
set "TOMLIN_FAILED=%CD%"
cd /d "%TOMLIN_PREV%"
set TOMLIN_PREV=
set TOMLIN_OPEN=
goto run
:next
if not exist next-copy.txt (echo The new version's folder was not named. Start TOMLIN from its folder. & pause & exit /b 1)
set /p TOMLIN_NEXT=<next-copy.txt
del next-copy.txt
if not exist "%TOMLIN_NEXT%\src\server.ts" (echo The new version is not in "%TOMLIN_NEXT%". Start TOMLIN from its folder. & pause & exit /b 1)
set "TOMLIN_PREV=%CD%"
cd /d "%TOMLIN_NEXT%"
set TOMLIN_OPEN=
echo TOMLIN was updated by a linked PC. Starting the new version in %CD% ...
goto run
