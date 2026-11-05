$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
& .venv\Scripts\python.exe -m PyInstaller --noconfirm --clean --onedir --console --name kotoba-worker --distpath build/worker --workpath build/pyinstaller --specpath build --collect-all faster_whisper --collect-all ctranslate2 --collect-all onnxruntime --collect-all soxr --collect-all tokenizers python/worker.py
if ($LASTEXITCODE) { throw 'Worker packaging failed' }
