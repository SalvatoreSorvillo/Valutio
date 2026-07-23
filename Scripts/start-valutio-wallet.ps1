[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8123,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$indexFile = Join-Path $root "index.html"
$server = Join-Path $PSScriptRoot "serve-wallet.mjs"
$url = "http://127.0.0.1:$Port/"

if (-not (Test-Path -LiteralPath $indexFile -PathType Leaf)) {
    throw "Cannot find Valutio at: $root"
}
if (-not (Test-Path -LiteralPath $server -PathType Leaf)) {
    throw "Local server helper is missing: $server"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js was not found. Install Node.js for Windows, then reopen PowerShell."
}

$browserJob = $null
if (-not $NoBrowser) {
    $browserJob = Start-Job -ScriptBlock {
        param([string]$TargetUrl)
        Start-Sleep -Seconds 1
        Start-Process $TargetUrl
    } -ArgumentList $url
}

Write-Host "Valutio serving on $url (press Ctrl+C to stop)"
try {
    & node $server $Port
    exit $LASTEXITCODE
}
finally {
    if ($null -ne $browserJob) {
        Remove-Job $browserJob -Force -ErrorAction SilentlyContinue
    }
}
