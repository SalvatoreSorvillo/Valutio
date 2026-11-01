[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$PythonArguments
)

$ErrorActionPreference = "Stop"

function Get-PythonCommand {
    # Prefer the direct interpreter. On some Windows installs the py launcher
    # exists but is not configured, while python.exe is fully usable.
    if (Get-Command python -ErrorAction SilentlyContinue) {
        return "python"
    }
    if (Get-Command py -ErrorAction SilentlyContinue) {
        try {
            & py --version *> $null
            if ($LASTEXITCODE -eq 0) { return "py" }
        } catch {
            # Fall through to the actionable error below.
        }
    }
    throw "Python was not found on PATH. Install Python for Windows, reopen PowerShell, then run: python -m pip install rjsmin rcssmin"
}

$publisher = Join-Path $PSScriptRoot "Scripts\publish-public.py"
if (-not (Test-Path -LiteralPath $publisher -PathType Leaf)) {
    throw "Publishing helper is missing: $publisher"
}
$python = Get-PythonCommand

& $python $publisher --init-git --force @PythonArguments
exit $LASTEXITCODE
