[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$PythonArguments
)

$ErrorActionPreference = "Stop"

function Get-PythonCommand {
    if (Get-Command py -ErrorAction SilentlyContinue) {
        return "py"
    }
    if (Get-Command python -ErrorAction SilentlyContinue) {
        return "python"
    }
    throw "Python was not found. Install Python for Windows, then reopen PowerShell."
}

$publisher = Join-Path $PSScriptRoot "Scripts\publish-public.py"
if (-not (Test-Path -LiteralPath $publisher -PathType Leaf)) {
    throw "Publishing helper is missing: $publisher"
}
$python = Get-PythonCommand

& $python $publisher --init-git --force @PythonArguments
exit $LASTEXITCODE
