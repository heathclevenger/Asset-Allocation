# Quarterly Update Workflow

Use this process when capital market assumptions change.

## One-Time Setup

From `C:\Users\hclevenger\Desktop\Paul Asset Allocation`:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

If PowerShell blocks activation scripts, run this once in PowerShell as your user:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Then reopen PowerShell and run the activation command again.

## Normal Quarterly Refresh

1. Replace `inputs\matrix-usd.xlsx` with the new quarterly source file.
2. Keep the filename exactly `matrix-usd.xlsx`.
3. Run:

```powershell
.\refresh_model.ps1
```

The workbook will be regenerated at:

```text
outputs\paul_asset_allocation_model.xlsx
```

## Where To Update Assumptions

In `src\portfolio_optimizer.py`, update:

- `ASSETS` for source-name mappings, categories, and min/max sleeve weights.
- `PROFILES` for each portfolio's equity, fixed income, alternatives, and cash bands.
- `target_volatility` inside each `PROFILES` section for each portfolio's target volatility range.
- `CASH_TARGET` if the hard cash allocation ever changes from 1%.
- `min_weight` and `max_weight` inside each `Asset(...)` row if you want tighter or looser single-sleeve ranges.

For normal quarterly updates, you should not need to edit the Python file. Only edit it if portfolio constraints, target volatility ranges, cash policy, or the stated asset-class mapping changes.

## Recommended Quarterly Checklist

- Confirm the source date and horizon.
- Confirm the model should continue using compound return.
- Review the policy bands before accepting any optimizer output.
- Review the target volatility bands and check whether any portfolio is flagged below or above target.
- Confirm cash is still intended to be fixed at exactly 1% for every portfolio, with both the minimum and maximum set to 1%.
- Review any asset class with stale or missing source assumptions.
- Confirm the stated model sleeves should remain unchanged.
- Confirm the correlation matrix is still reasonable.
- Save a dated copy of the output workbook before overwriting assumptions again.

## Normal Rule

Quarterly updates should only replace `inputs\matrix-usd.xlsx`. Do not edit the Python file unless the portfolio constraints, target volatility ranges, cash rule, or stated model sleeves need to change.
