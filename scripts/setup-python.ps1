$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
uv python install 3.12
if ($LASTEXITCODE) { throw 'Python installation failed' }
if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
  uv venv --python 3.12 .venv
  if ($LASTEXITCODE) { throw 'Virtual environment creation failed' }
}
uv pip install --python .venv\Scripts\python.exe -r python\requirements-lock.txt
if ($LASTEXITCODE) { throw 'Python dependency installation failed' }
