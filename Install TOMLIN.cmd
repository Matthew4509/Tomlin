@echo off
rem Installs TOMLIN for this Windows user: double-click it in the unzipped folder. No administrator needed and
rem nothing is downloaded (except Microsoft's Visual C++ Runtime, offered when this PC lacks it, and, in a copy of the
rem source from GitHub, the packages and model runners it lacks, asked first). It asks first, then copies TOMLIN to %LOCALAPPDATA%\Programs\TOMLIN, builds
rem TOMLIN.exe (it runs by the clock, no console window), adds it to the Start menu (and the desktop if you
rem want), and lists it in Settings > Apps, where Uninstall removes it again. Already installed? It offers to update.
rem Your chats, staff, pictures and models stay in your "TOMLIN" folder ("Smart Manager" on a PC set up before the
rem TOMLIN name, which keeps its install there too); nothing there is changed.
title TOMLIN setup
cd /d "%~dp0"
if not exist "tools\install.ts" goto not_unzipped
set "SM_NODE=%~dp0runtime\node\node.exe"
if exist "%SM_NODE%" goto run
set "SM_NODE=node"
where node >nul 2>nul || goto no_node
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)" || goto no_node
:run
rem A copy downloaded from GitHub (the source, not the release zip) lacks the packages (node_modules) and the CPU
rem model runners (runtime). It says which, asks first and fetches them as Start TOMLIN.cmd does. No answer is No.
set SM_NEED_PKG=
set SM_NEED_RUN=
if not exist "node_modules\sharp" set SM_NEED_PKG=1
if not exist "node_modules\@img\sharp-win32-x64\lib" set SM_NEED_PKG=1
if not exist "runtime\llama-cpu\llama-server.exe" set SM_NEED_RUN=1
if not exist "runtime\sd-cpu\sd-server.exe" set SM_NEED_RUN=1
if not defined SM_NEED_PKG if not defined SM_NEED_RUN goto ready
echo.
echo  This copy is TOMLIN's source from GitHub, not the release zip, so it lacks parts TOMLIN needs:
if defined SM_NEED_PKG echo   - its packages ^(picture tools, PDF reader^), from the npm registry: npm install
if defined SM_NEED_RUN echo   - the CPU model runners ^(llama.cpp and stable-diffusion.cpp^), about 36 MB from their GitHub releases, each checked by SHA-256: npm run fetch
echo.
set SM_YES=
set /p "SM_YES= Download and add them to this folder now? [y/N] "
if /i "%SM_YES%"=="y" goto get_parts
if /i "%SM_YES%"=="yes" goto get_parts
goto parts_declined
:get_parts
if exist "%~dp0runtime\node\node.exe" set "PATH=%~dp0runtime\node;%PATH%"
if not defined SM_NEED_PKG goto get_runners
where npm >nul 2>nul || goto no_npm
echo.
echo  Installing the packages...
call npm install --omit=dev --include=optional --no-audit --no-fund || goto parts_failed
:get_runners
if not defined SM_NEED_RUN goto parts_check
echo.
echo  Downloading the CPU model runners...
"%SM_NODE%" tools\fetch.ts llama-cpu sd-cpu || goto parts_failed
:parts_check
if not exist "node_modules\@img\sharp-win32-x64\lib" goto parts_failed
if not exist "runtime\llama-cpu\llama-server.exe" goto parts_failed
if not exist "runtime\sd-cpu\sd-server.exe" goto parts_failed
echo.
echo  Done. Starting the setup...
:ready
rem The setup window (tools\setup.cs) is built here with the compiler that comes with Windows. Without that compiler,
rem or with --console, the text setup below runs instead.
if /i "%~1"=="--console" goto console
set "SM_CSC=%windir%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%SM_CSC%" set "SM_CSC=%windir%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%SM_CSC%" goto console
if not exist "tools\setup.cs" goto console
set "SM_WIN=%TEMP%\tomlin-setup-%RANDOM%"
mkdir "%SM_WIN%" >nul 2>nul
"%SM_CSC%" -nologo -target:winexe -optimize+ "-win32icon:%~dp0public\icon.ico" "-out:%SM_WIN%\TOMLIN Setup.exe" "-win32manifest:%~dp0tools\setup.manifest" -r:System.Windows.Forms.dll -r:System.Drawing.dll -r:System.IO.Compression.dll -r:System.IO.Compression.FileSystem.dll "%~dp0tools\setup.cs" >nul 2>nul
if errorlevel 1 goto console_clean
start "" /wait "%SM_WIN%\TOMLIN Setup.exe" --node "%SM_NODE%" --src "%~dp0."
set "SM_CODE=%errorlevel%"
rd /s /q "%SM_WIN%" >nul 2>nul
if "%SM_CODE%"=="9" goto console
exit /b %SM_CODE%
:console_clean
rd /s /q "%SM_WIN%" >nul 2>nul
:console
"%SM_NODE%" tools\install.ts install %*
if errorlevel 1 (echo. & pause & exit /b 1)
echo.
echo  This window closes in 10 seconds.
timeout /t 10 >nul 2>nul
exit /b 0
:not_unzipped
echo  This was opened from inside the zip, or without the rest of its folder.
echo  Unzip the whole folder first (right-click the zip, Extract All), then double-click "Install TOMLIN.cmd" in it.
pause
exit /b 1
:parts_declined
echo.
echo  Nothing was downloaded and TOMLIN was not installed. To add the parts yourself, run these in this folder
echo  ^(Node.js comes with npm^), then double-click "Install TOMLIN.cmd" again:
echo     npm install --omit=dev --include=optional
echo     npm run fetch
echo  Or use the release instead, which has them all: https://github.com/Matthew4509/Tomlin/releases/latest
pause
exit /b 1
:no_npm
echo.
echo  npm, which comes with Node.js, was not found, so the packages cannot be installed. Install Node.js 22.18 or
echo  newer from https://nodejs.org, then double-click "Install TOMLIN.cmd" again.
pause
exit /b 1
:parts_failed
echo.
echo  The parts could not all be added ^(the lines above say why; check the internet connection^). TOMLIN was not
echo  installed. Double-click "Install TOMLIN.cmd" to try again.
pause
exit /b 1
:no_node
echo  This copy has no Node.js of its own, and Node.js 22.18 or newer is not installed on this PC.
echo  Install it from https://nodejs.org, then double-click "Install TOMLIN.cmd" again.
pause
exit /b 1
