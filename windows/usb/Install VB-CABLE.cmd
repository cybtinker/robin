@echo off
rem Installs the VB-CABLE virtual microphone (donationware by VB-Audio Software, www.vb-cable.com).
rem Needs administrator rights: it asks for them if this was not started with "Run as administrator".
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0VB-CABLE"
echo Installing VB-CABLE (donationware by VB-Audio Software, www.vb-cable.com)...
start "" /wait VBCABLE_Setup_x64.exe -i -h
if exist "%windir%\System32\drivers\vbaudio_cable64_win*.sys" (
  echo VB-CABLE is installed. Please restart the PC, then open FledglingLive.exe.
) else (
  echo VB-CABLE was not installed. Run VBCABLE_Setup_x64.exe in the VB-CABLE folder as administrator.
)
pause
