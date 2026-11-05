$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskVswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$taskVs = & $taskVswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $taskVs) { throw 'Install Visual Studio Build Tools with Desktop development with C++ and Windows SDK.' }
$taskVcvars = Join-Path $taskVs 'VC\Auxiliary\Build\vcvars64.bat'
New-Item -ItemType Directory -Force -Path "$taskRoot\build\native" | Out-Null
Push-Location "$taskRoot\build\native"
try {
  $taskBatch = Join-Path $taskRoot 'build\native\compile.cmd'
  @('@echo off', ('call "{0}"' -f $taskVcvars), ('cl /nologo /std:c++17 /EHsc /O2 /MT /utf-8 /DUNICODE /D_UNICODE "{0}\native\loopback.cpp" /Fe:loopback.exe /link ole32.lib mmdevapi.lib propsys.lib avrt.lib user32.lib' -f $taskRoot)) | Set-Content -LiteralPath $taskBatch -Encoding ASCII
  & $env:ComSpec /d /c "call `"$taskBatch`""
  if ($LASTEXITCODE) { throw 'Native capture compilation failed' }
} finally { Pop-Location }
