$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvPython = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$JpmMatrix = Join-Path $ProjectRoot "inputs\matrix-usd.xlsx"

if (-not (Test-Path $VenvPython)) {
    Write-Host "Virtual environment not found. Create it first with:"
    Write-Host "  py -m venv .venv"
    Write-Host "  .\.venv\Scripts\Activate.ps1"
    Write-Host "  python -m pip install --upgrade pip"
    Write-Host "  python -m pip install -r requirements.txt"
    exit 1
}

if (-not (Test-Path $JpmMatrix)) {
    Write-Host "JPM matrix file not found. Save the quarterly JPM file here before refreshing:"
    Write-Host "  inputs\matrix-usd.xlsx"
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

$DependencyCheck | & $VenvPython -
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Install the required packages with:"
    Write-Host "  .\.venv\Scripts\python.exe -m pip install -r requirements.txt"
    exit 1
}

& $VenvPython (Join-Path $ProjectRoot "src\portfolio_optimizer.py")
& $VenvPython (Join-Path $ProjectRoot "src\export_web_data.py")
Write-Host "Updated workbook: outputs\paul_asset_allocation_model.xlsx"
Write-Host "Updated web data: web\data\model-data.json"
