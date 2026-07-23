# Paul Asset Allocation

This workspace contains a first-pass asset allocation optimization model for five risk levels:

- Conservative
- Balanced
- Moderate
- Growth
- Aggressive Growth

The model uses `inputs/jpm_matrix.xlsx`: compound return, annualized volatility, and the correlation matrix.

Cash is hard constrained to exactly 1% in every portfolio and every optimization method; the cash minimum and cash maximum are both 1%.

## Files

- `src/portfolio_optimizer.py` - repeatable optimizer and workbook builder.
- `inputs/jpm_matrix.xlsx` - quarterly JPM assumption and correlation matrix. Replace this file each quarter.
- `inputs/blackrock-capital-market-assumptions.xlsx` - BlackRock assumptions used for the `BlackRock 2026` dropdown set.
- `inputs/vanguard_2026_assumptions.csv` - Vanguard assumptions transcribed from screenshot/table form.
- `inputs/invesco_2026_assumptions.csv` - Invesco assumptions transcribed from screenshot/table form.
- `inputs/msci_2026_assumptions.csv` - MSCI/suggested benchmark assumptions for U.S. equity factor sleeves.
- `inputs/capital_group_2026.xlsx` - Capital Group assumptions and correlation matrix transcribed from screenshot/table form.
- `inputs/Asset-Allocation-Interactive-Data.xlsx` - Asset Allocation Interactive assumptions, model mapping, and correlation matrix.
- `outputs/paul_asset_allocation_model.xlsx` - Excel workbook with assumptions, outputs, constraints, checks, and source/setup notes.

## Current Optimization

The active model is target-volatility MVO.

- Maximizes expected return while staying inside each portfolio's target volatility band.
- Uses category bands and single-asset caps to avoid unrealistic concentration.
- Monte Carlo simulation is currently removed from all calculations while the methodology is redesigned.

Scenario optimization is still included in the workbook refresh:

- Runs bad, median, and good economy cases.
- The bad/good cases currently adjust compound returns down/up by half of volatility.

## Refresh Command

For one-off refreshes after dependencies are installed, run from this folder:

```powershell
python src\portfolio_optimizer.py
```

For quarterly updates, use the setup and refresh workflow in `QUARTERLY_UPDATE.md`.

Quarterly updates should only require replacing `inputs/jpm_matrix.xlsx` with the new JPM source file, then running `.\refresh_model.ps1`.

## Assumption Inputs

JPM should stay in `inputs/jpm_matrix.xlsx` because it also provides the correlation matrix used by the optimizer.

BlackRock should stay in `inputs/blackrock-capital-market-assumptions.xlsx`. The exporter reads the cleaned USD assumptions sheet and only uses approved model-sleeve mappings.

Vanguard should stay in `inputs/vanguard_2026_assumptions.csv`. Vanguard currently comes from screenshot/table data, so the CSV is the reviewable source file. Use these columns:

```csv
Model Asset,Provider Asset,Return,Volatility,Source Note
```

When a new Vanguard screenshot is available, paste the screenshot or table into Codex and ask to convert it to `inputs/vanguard_2026_assumptions.csv`. Use the 50th percentile return and median volatility unless the model policy changes. Any missing or unclear provider category should be confirmed before mapping; if no approved proxy exists, that sleeve should fall back to CORE average assumptions and the source note should say so.

Invesco should stay in `inputs/invesco_2026_assumptions.csv`. Invesco currently comes from screenshot/table data, so the CSV is the reviewable source file. Use arithmetic return as the return assumption and expected risk as the volatility assumption. Any missing or unclear provider category should be confirmed before mapping; approved fallbacks should use CORE average assumptions and the source note should say so.

MSCI should stay in `inputs/msci_2026_assumptions.csv`. It currently covers only U.S. Income, U.S. Quality, U.S. Growth, and U.S. Value. All other sleeves fall back to CORE average assumptions.

Capital Group should stay in `inputs/capital_group_2026.xlsx`, with assumptions on the `Assumptions` sheet and correlations on the `Correlations` sheet. Capital Group assumptions use long-term expected return and standard deviation. Capital Group correlations are averaged with JPM correlations only where a model sleeve has an approved Capital Group correlation mapping; otherwise the model keeps the JPM correlation value.

Asset Allocation Interactive should stay in `inputs/Asset-Allocation-Interactive-Data.xlsx`, with source assumptions on `Expected Returns (All)`, source correlations on `Expected Correlations`, and approved model sleeve mappings on `Model Mapping`. Asset Allocation Interactive assumptions use nominal return as the return assumption and volatility as the volatility assumption. Its correlations are averaged with JPM and Capital Group correlations where mapped values are available; otherwise the model uses the available source average, falling back to JPM alone when no other mapped correlation is available.

## Key Setup Decisions Still Needed

- Confirm compound return remains the expected return basis.
- Confirm the five portfolio policy bands for equity, fixed income, alternatives, and cash.
- Review the correlation matrix mappings, especially any composite sleeves.
- Decide whether alternatives such as REITs and commodities should be included in all models or shown separately.
- Map each sleeve to actual ETFs, mutual funds, or model holdings.
- Decide taxable vs IRA/qualified-account treatment, especially for munis, taxable bonds, and REITs.
- Set rebalancing rules: calendar-based, tolerance-band, or both.
- Decide whether the target volatility bands need to be adjusted after reviewing outputs.
