$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskTarget = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*scripts*soak.py*--seconds 1800*' } | Sort-Object PrivatePageCount -Descending | Select-Object -First 1
if (-not $taskTarget) { throw 'Running soak process not found' }
$taskSamples = [System.Collections.Generic.List[object]]::new()
$taskOutput = Join-Path $taskRoot 'artifacts\soak-memory.json'
while ($true) {
  $taskProcess = Get-Process -Id $taskTarget.ProcessId -ErrorAction SilentlyContinue
  if (-not $taskProcess) { break }
  $taskSamples.Add([pscustomobject]@{ at = [DateTime]::UtcNow.ToString('o'); workingSetMB = [math]::Round($taskProcess.WorkingSet64 / 1MB, 1); privateMB = [math]::Round($taskProcess.PrivateMemorySize64 / 1MB, 1) })
  [pscustomobject]@{ pid = $taskTarget.ProcessId; completed = $false; samples = @($taskSamples.ToArray()) } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $taskOutput -Encoding utf8
  Start-Sleep -Seconds 5
}
[pscustomobject]@{ pid = $taskTarget.ProcessId; completed = $true; samples = @($taskSamples.ToArray()) } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $taskOutput -Encoding utf8
