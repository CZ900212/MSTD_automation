@echo off
rem mstd.cmd — Windows 入口 shim：全部委托 bin/service.mjs（Windows 没有 bash/pgrep/curl）。
rem 用法与 unix 版一致: mstd [start|stop|restart|status|logs|install|uninstall]
setlocal
set "SCRIPT_DIR=%~dp0"
if "%~1"=="" (
  node "%SCRIPT_DIR%service.mjs" start
) else (
  node "%SCRIPT_DIR%service.mjs" %*
)
endlocal
exit /b %errorlevel%
