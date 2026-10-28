$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvPython = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$DefaultJpmMatrix = Join-Path $ProjectRoot "inputs\2027\JPM matrix-usd_2027.xlsx"
$PythonExe = $null

$PythonCommand = Get-Command python -ErrorAction SilentlyContinue
if ($PythonCommand) {
    $PythonExe = $PythonCommand.Source
} elseif (Test-Path $VenvPython) {
    $PythonExe = $VenvPython
}

if (-not $PythonExe) {
    Write-Host "Python was not found. Install Python, then run:"
    Write-Host "  python -m pip install -r requirements.txt"
    exit 1
}

if (-not (Test-Path $DefaultJpmMatrix)) {
    Write-Host "The default JPM matrix file was not found:"
    Write-Host "  inputs\2027\JPM matrix-usd_2027.xlsx"
    exit 1
}

$DependencyCheck = @"
import importlib.util
import sys

missing = [pkg for pkg in ("numpy", "openpyxl", "scipy") if importlib.util.find_spec(pkg) is None]
if missing:
    print("Missing Python packages in .venv: " + ", ".join(missing))
    sys.exit(1)
"@

$DependencyCheck | & $PythonExe -
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Install the required packages with:"
    Write-Host "  python -m pip install -r requirements.txt"
    exit 1
}

& $PythonExe (Join-Path $ProjectRoot "src\portfolio_optimizer.py")
& $PythonExe (Join-Path $ProjectRoot "src\export_web_data.py")
Write-Host "Updated workbook: outputs\paul_asset_allocation_model.xlsx"
Write-Host "Updated year-aware web data: web\data\model-data.json"
