$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Install Node.js 24+ x64 with npm, reopen PowerShell, then retry.'
}
& node (Join-Path $PSScriptRoot 'build-trial.mjs') windows
if ($LASTEXITCODE -ne 0) { throw "Windows trial build failed ($LASTEXITCODE). See the reported stage log." }
