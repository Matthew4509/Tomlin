@echo off
rem Installs TOMLIN for this Windows user: double-click it in the unzipped folder. No administrator needed and
rem nothing is downloaded (except Microsoft's Visual C++ Runtime, offered when this PC lacks it). It asks first, then copies TOMLIN to %LOCALAPPDATA%\Programs\TOMLIN, builds
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
:no_node
echo  This copy has no Node.js of its own, and Node.js 22.18 or newer is not installed on this PC.
echo  Install it from https://nodejs.org, then double-click "Install TOMLIN.cmd" again.
pause
exit /b 1
