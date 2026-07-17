# Paul Asset Allocation

This workspace contains a first-pass asset allocation optimization model for five risk levels:

- Conservative
- Balanced
- Moderate
- Growth
- Aggressive Growth

The model uses `inputs/matrix-usd.xlsx`: compound return, annualized volatility, and the correlation matrix.

Cash is hard constrained to exactly 1% in every portfolio and every optimization method; the cash minimum and cash maximum are both 1%.

## Files

- `src/portfolio_optimizer.py` - repeatable optimizer and workbook builder.
- `inputs/matrix-usd.xlsx` - quarterly assumption and correlation matrix. Replace this file each quarter.
- `outputs/paul_asset_allocation_model.xlsx` - Excel workbook with assumptions, outputs, constraints, checks, and source/setup notes.

## Optimization Tests

1. Target-volatility optimization
   - Maximizes expected return while staying inside each portfolio's target volatility band.
   - Uses category bands and single-asset caps to avoid unrealistic concentration.

2. Monte Carlo optimization and simulation
   - Searches random feasible portfolios within the same policy bands.
   - Simulates 10-year terminal wealth outcomes for each risk profile.

3. Scenario optimization
   - Runs bad, median, and good economy cases.
   - The bad/good cases currently adjust compound returns down/up by half of volatility.

## Refresh Command

For one-off refreshes after dependencies are installed, run from this folder:

```powershell
python src\portfolio_optimizer.py
```

For quarterly updates, use the setup and refresh workflow in `QUARTERLY_UPDATE.md`.

Quarterly updates should only require replacing `inputs/matrix-usd.xlsx` with the new source file, then running `.\refresh_model.ps1`.

## Key Setup Decisions Still Needed

- Confirm compound return remains the expected return basis.
- Confirm the five portfolio policy bands for equity, fixed income, alternatives, and cash.
- Review the correlation matrix mappings, especially any composite sleeves.
- Decide whether alternatives such as REITs and commodities should be included in all models or shown separately.
- Map each sleeve to actual ETFs, mutual funds, or model holdings.
- Decide taxable vs IRA/qualified-account treatment, especially for munis, taxable bonds, and REITs.
- Set rebalancing rules: calendar-based, tolerance-band, or both.
- Decide whether the target volatility bands need to be adjusted after reviewing outputs.
