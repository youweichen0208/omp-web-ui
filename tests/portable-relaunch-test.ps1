param([Parameter(Mandatory=$true)][string]$PortableExe)
$ErrorActionPreference = 'Stop'
$base = Join-Path $env:RUNNER_TEMP ("pi-portable-test-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $base | Out-Null
$profile = Join-Path $base 'profile'
$env:PI_WEB_DATA_DIR = Join-Path $base 'data'
$env:PI_CODING_AGENT_DIR = Join-Path $base 'agent'
$env:PI_WEB_CWD = $base
$launchers = @()
try {
  $first = Start-Process $PortableExe -ArgumentList "--user-data-dir=$profile" -PassThru
  $launchers += $first
  $main = $null
  for ($i = 0; $i -lt 180; $i++) {
    $main = Get-CimInstance Win32_Process -Filter "name='pi.exe'" | Where-Object { $_.CommandLine -like "*$profile*" -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1
    if ($main) { break }
    Start-Sleep -Seconds 1
  }
  if (-not $main) { throw 'First portable app never started' }
  $appDir = Split-Path $main.ExecutablePath
  $module = Join-Path $appDir 'resources/app/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js'
  if (-not (Test-Path $module)) { throw "Missing module on first launch: $module" }
  Write-Host "First launch module exists: $module"
  # Confirm the shipped module itself loads, without making any model call.
  $env:ELECTRON_RUN_AS_NODE = '1'
  node tests/packaged-server-start-test.mjs "$appDir/pi.exe" "$appDir/resources/app"
  Remove-Item Env:ELECTRON_RUN_AS_NODE
  if ($LASTEXITCODE -ne 0) { throw 'First portable server did not start' }
  $second = Start-Process $PortableExe -ArgumentList "--user-data-dir=$profile" -PassThru
  $launchers += $second
  if (-not $second.WaitForExit(180000)) { throw 'Second portable launcher did not exit' }
  if (-not (Get-Process -Id $main.ProcessId -ErrorAction SilentlyContinue)) { throw 'First app exited during relaunch' }
  if (-not (Test-Path $module)) { throw "ERR_MODULE_NOT_FOUND after relaunch: $module" }
  node tests/packaged-server-start-test.mjs "$appDir/pi.exe" "$appDir/resources/app"
  if ($LASTEXITCODE -ne 0) { throw 'Portable server cannot restart after relaunch' }
  Write-Host 'PASS portable relaunch preserves running app modules'
} finally {
  foreach ($launcher in $launchers) {
    if (-not $launcher.HasExited) { taskkill /PID $launcher.Id /T /F | Out-Null }
  }
}
