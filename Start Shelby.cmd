@echo off
rem The earlier name of Start TOMLIN.cmd, kept so Start with Windows entries, shortcuts and linked PCs on an older
rem version still find it. It runs Start TOMLIN.cmd. Remove it once every PC runs a version that has Start TOMLIN.cmd.
call "%~dp0Start TOMLIN.cmd" %*
exit /b %errorlevel%
