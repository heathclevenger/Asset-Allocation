from __future__ import annotations

import csv
import json
from pathlib import Path

import numpy as np
from openpyxl import load_workbook

import portfolio_optimizer as optimizer


ROOT = Path(__file__).resolve().parents[1]
WEB_DATA = ROOT / "web" / "data" / "model-data.json"
INPUTS_DIR = ROOT / "inputs"
DEFAULT_ASSUMPTION_YEAR = "2027"
FUND_MAPPING_FILE = INPUTS_DIR / "2026" / "Fund Mapping.xlsx"


def find_year_file(year: str, name_parts: tuple[str, ...], suffixes: tuple[str, ...]) -> Path | None:
    year_dir = INPUTS_DIR / str(year)
    if not year_dir.exists():
        return None
    candidates = []
    for path in year_dir.iterdir():
        normalized_name = path.name.lower().replace("_", " ").replace("-", " ")
        if path.suffix.lower() not in suffixes or path.name.startswith("~$"):
            continue
        if all(part.lower() in normalized_name for part in name_parts):
            candidates.append(path)
    return sorted(candidates)[0] if candidates else None


def year_source_files(year: str) -> dict[str, Path | None]:
    return {
        "jpm": optimizer.jpm_matrix_path(year),
        "vanguard": find_year_file(year, ("vanguard",), (".csv",)),
        "blackrock": find_year_file(year, ("blackrock",), (".xlsx",)),
        "invesco": find_year_file(year, ("invesco",), (".csv",)),
        "capital_group": find_year_file(year, ("capital", "group"), (".xlsx",)),
        "asset_allocation_interactive": find_year_file(year, ("asset", "allocation", "interactive"), (".xlsx",)),
    }

FUND_MAPPING_HEADERS = {
    "large cap": "U.S. Large Cap",
    "mid cap": "U.S. Mid Cap",
    "small cap": "U.S. Small Cap",
    "us value": "U.S. Value",
    "us growth": "U.S. Growth",
    "int. developed": "International Developed Equity",
    "emerging markets": "Emerging Markets Equity",
    "us short tsy": "US Short Treasuries",
    "us intermediate tsy": "US Intermediate Treasuries",
    "us long tsy": "US Long Treasuries",
    "inv. grade corporate": "Investment Grade Corporate",
    "high yield": "High Yield",
    "international fi(h)": "International Fixed Income (H)",
}

FUND_SECTION_PREFIXES = ("equities", "fixed income")


def parse_assumption_percent(value: str) -> float:
    text = str(value).strip()
    if text.endswith("%"):
        return float(text[:-1]) / 100.0
    number = float(text)
    return number / 100.0 if abs(number) > 1 else number


def clean_text(value: object) -> str:
    return str(value or "").strip()


def load_fund_models() -> dict[str, object]:
    if not FUND_MAPPING_FILE.exists():
        return {"providers": {}, "warnings": [f"{FUND_MAPPING_FILE.name} was not found in inputs."]}

    wb = load_workbook(FUND_MAPPING_FILE, data_only=True, read_only=True)
    providers: dict[str, list[dict[str, object]]] = {}
    warnings: list[str] = []

    for ws in wb.worksheets:
        rows: list[dict[str, object]] = []
        current_section = ""
        current_headers: dict[int, str] = {}

        for row_number, row in enumerate(ws.iter_rows(values_only=True), start=1):
            ticker = clean_text(row[0] if row else "")
            row_values = list(row or [])
            row_headers: dict[int, str] = {}
            for index, raw_header in enumerate(row_values[2:], start=2):
                header = clean_text(raw_header).lower()
                if header in FUND_MAPPING_HEADERS:
                    row_headers[index] = FUND_MAPPING_HEADERS[header]
            numeric_values = [
                value for value in row_values[2:]
                if isinstance(value, (int, float)) and abs(float(value)) > 1e-12
            ]
            lower_ticker = ticker.lower()

            if lower_ticker.startswith(FUND_SECTION_PREFIXES):
                current_section = ticker
                if row_headers:
                    current_headers = row_headers
                if numeric_values:
                    warnings.append(f"{ws.title} row {row_number}: section row contains exposure values and was skipped.")
                continue

            if row_headers:
                current_headers = row_headers
                if ticker:
                    warnings.append(f"{ws.title} row {row_number}: {ticker} appears to be a header row and was skipped.")
                continue

            if not ticker:
                if numeric_values:
                    warnings.append(f"{ws.title} row {row_number}: blank ticker contains exposure values and was skipped.")
                continue

            if not current_headers:
                if numeric_values:
                    warnings.append(f"{ws.title} row {row_number}: {ticker} has exposures before a recognized header row and was skipped.")
                continue

            exposures: dict[str, float] = {}
            for index, asset_name in current_headers.items():
                value = row_values[index] if index < len(row_values) else None
                if isinstance(value, (int, float)) and abs(float(value)) > 1e-12:
                    exposures[asset_name] = float(value)

            if not exposures:
                warnings.append(f"{ws.title} row {row_number}: {ticker} has no usable exposures and was kept at 0%.")

            rows.append({
                "ticker": ticker,
                "section": current_section,
                "exposures": exposures,
            })

        providers[ws.title] = rows

    return {"providers": providers, "warnings": warnings}


def load_vanguard_assumptions(source_file: Path | None) -> dict[str, dict[str, float | str]]:
    if source_file is None or not source_file.exists():
        return {}
    out: dict[str, dict[str, float | str]] = {}
    with source_file.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            model_asset = optimizer.normalize_name(row.get("Model Asset", ""))
            provider_asset = row.get("Provider Asset", "").strip()
            if not model_asset or not provider_asset:
                continue
            out[model_asset] = {
                "return": parse_assumption_percent(row.get("Return", "0")),
                "volatility": parse_assumption_percent(row.get("Volatility", "0")),
                "sourceMapping": provider_asset,
            }
    return out


JPM_FALLBACK_TO_AVERAGE = set()
CAPITAL_GROUP_FALLBACK_TO_AVERAGE = {
    "U.S. Value",
    "U.S. REITs",
    "Commodities",
}
ASSET_ALLOCATION_INTERACTIVE_FALLBACK_TO_AVERAGE = set()
INVESCO_FALLBACK_TO_AVERAGE = {
    "U.S. Mid Cap",
    "U.S. Value",
    "U.S. REITs",
    "Cash",
}
FALLBACK_RETURN_OVERRIDES = {}


def load_capital_group_assumptions(source_file: Path | None) -> dict[str, dict[str, float | str]]:
    if source_file is None or not source_file.exists():
        return {}
    out: dict[str, dict[str, float | str]] = {}
    wb = load_workbook(source_file, data_only=True, read_only=True)
    ws = wb["Assumptions"]
    headers = [str(cell.value).strip() if cell.value is not None else "" for cell in ws[1]]
    index = {header: position for position, header in enumerate(headers)}
    for row in ws.iter_rows(min_row=2, values_only=True):
        model_asset = optimizer.normalize_name(row[index["Model Asset"]] or "")
        provider_asset = str(row[index["Provider Asset"]] or "").strip()
        expected_return = row[index["Return"]]
        volatility = row[index["Volatility"]]
        if not model_asset or not provider_asset or expected_return in (None, "") or volatility in (None, ""):
            continue
        out[model_asset] = {
            "return": parse_assumption_percent(str(expected_return)),
            "volatility": parse_assumption_percent(str(volatility)),
            "sourceMapping": provider_asset,
        }
    return out


def load_capital_group_correlation(source_file: Path | None) -> dict[str, dict[str, float]]:
    if source_file is None or not source_file.exists():
        return {}
    wb = load_workbook(source_file, data_only=True, read_only=True)
    ws = wb["Correlations"]
    headers = [optimizer.normalize_name(cell.value) for cell in ws[1][1:]]
    out: dict[str, dict[str, float]] = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        row_name = optimizer.normalize_name(row[0])
        if not row_name:
            continue
        out[row_name] = {
            header: float(value)
            for header, value in zip(headers, row[1:])
            if header and value not in (None, "")
        }
    return out


def load_asset_allocation_interactive_assumptions(source_file: Path | None) -> dict[str, dict[str, float | str]]:
    if source_file is None or not source_file.exists():
        return {}
    wb = load_workbook(source_file, data_only=True, read_only=True)
    ws = wb["Model Mapping"]
    headers = [str(cell.value).strip() if cell.value is not None else "" for cell in ws[1]]
    index = {header: position for position, header in enumerate(headers)}
    out: dict[str, dict[str, float | str]] = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        model_asset = optimizer.normalize_name(row[index["Model Asset"]] or "")
        provider_asset = str(row[index["Provider Asset"]] or "").strip()
        expected_return = row[index["Return"]]
        volatility = row[index["Volatility"]]
        if not model_asset or not provider_asset or expected_return in (None, "") or volatility in (None, ""):
            continue
        out[model_asset] = {
            "return": parse_assumption_percent(str(expected_return)),
            "volatility": parse_assumption_percent(str(volatility)),
            "sourceMapping": provider_asset,
        }
    return out


def load_asset_allocation_interactive_correlation(source_file: Path | None) -> dict[str, dict[str, float]]:
    if source_file is None or not source_file.exists():
        return {}
    wb = load_workbook(source_file, data_only=True, read_only=True)
    ws = wb["Expected Correlations"]
    headers = [optimizer.normalize_name(cell.value) for cell in ws[4][2:] if cell.value not in (None, "")]
    out: dict[str, dict[str, float]] = {}
    for row in ws.iter_rows(min_row=5, values_only=True):
        row_name = optimizer.normalize_name(row[1])
        if not row_name or row_name in out:
            continue
        values = row[2:2 + len(headers)]
        if not values or all(value in (None, "") for value in values):
            continue
        out[row_name] = {
            header: float(value)
            for header, value in zip(headers, values)
            if header and value not in (None, "")
        }
        if len(out) >= len(headers):
            break
    return out
BLACKROCK_FALLBACK_TO_AVERAGE = {
    "U.S. Value",
    "Commodities",
    "US Short Treasuries",
}

CAPITAL_GROUP_CORRELATION_MAP = {
    "U.S. Large Cap": "U.S. equity",
    "U.S. Mid Cap": ("U.S. equity", "U.S. small-cap equity"),
    "U.S. Small Cap": "U.S. small-cap equity",
    "International Developed Equity": "Non-U.S. developed markets equity",
    "Emerging Markets Equity": "Emerging markets equity",
    "US Short Treasuries": "U.S. Treasury short term",
    "US Intermediate Treasuries": "U.S. Treasury intermediate term",
    "US Long Treasuries": "U.S. Treasury long term",
    "Investment Grade Corporate": "U.S. corporate",
    "High Yield": "U.S. high yield",
    "International Fixed Income (H)": "Non-U.S. global aggregate",
    "Cash": "Cash (USD)",
}

ASSET_ALLOCATION_INTERACTIVE_CORRELATION_MAP = {
    "U.S. Large Cap": "US Large",
    "U.S. Mid Cap": ("US Large", "US Small"),
    "U.S. Small Cap": "US Small",
    "U.S. Value": "US Large Value",
    "U.S. Growth": "US Large Growth",
    "International Developed Equity": "Dev ex US Large",
    "Emerging Markets Equity": "Emerging Markets",
    "U.S. REITs": "REITs",
    "Commodities": "Commodities",
    "US Short Treasuries": "US Treasury Short",
    "US Intermediate Treasuries": "US Treasury Intermediate",
    "US Long Treasuries": "US Treasury Long",
    "Investment Grade Corporate": "US Corporate Intermediate",
    "High Yield": "US High Yield",
    "International Fixed Income (H)": "Global ex US Aggregate (Hedged)",
    "Cash": "United States Cash",
}


def load_invesco_assumptions(source_file: Path | None) -> dict[str, dict[str, float | str]]:
    if source_file is None or not source_file.exists():
        return {}
    out: dict[str, dict[str, float | str]] = {}
    with source_file.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            model_asset = optimizer.normalize_name(row.get("Model Asset", ""))
            provider_asset = row.get("Provider Asset", "").strip()
            expected_return = row.get("Arithmetic Return", "").strip()
            expected_risk = row.get("Expected Risk", "").strip()
            if not model_asset or not provider_asset or not expected_return or not expected_risk:
                continue
            out[model_asset] = {
                "return": parse_assumption_percent(expected_return),
                "volatility": parse_assumption_percent(expected_risk),
                "sourceMapping": provider_asset,
            }
    return out


def load_blackrock_source_data(source_file: Path | None) -> dict[str, dict[str, float]]:
    if source_file is None or not source_file.exists():
        return {}
    wb = load_workbook(source_file, data_only=True, read_only=True)
    ws = wb["Starting point "] if "Starting point " in wb.sheetnames else wb.active
    out: dict[str, dict[str, float]] = {}
    for asset_class, asset_name, expected_return, volatility in ws.iter_rows(min_row=4, max_col=4, values_only=True):
        if not isinstance(asset_name, str):
            continue
        if not isinstance(expected_return, (int, float)) or not isinstance(volatility, (int, float)):
            continue
        out[optimizer.normalize_name(asset_name)] = {
            "return": float(expected_return),
            "volatility": float(volatility),
        }
    return out


def blackrock_assumption(source: dict[str, dict[str, float]], name: str, source_mapping: str) -> dict[str, float | str] | None:
    row = source.get(optimizer.normalize_name(name))
    if row is None:
        return None
    return {
        "return": row["return"],
        "volatility": row["volatility"],
        "sourceMapping": source_mapping,
    }


def blackrock_average_assumption(source: dict[str, dict[str, float]], names: list[str], source_mapping: str) -> dict[str, float | str] | None:
    rows = [source.get(optimizer.normalize_name(name)) for name in names]
    if any(row is None for row in rows):
        return None
    valid_rows = [row for row in rows if row is not None]
    return {
        "return": sum(row["return"] for row in valid_rows) / len(valid_rows),
        "volatility": sum(row["volatility"] for row in valid_rows) / len(valid_rows),
        "sourceMapping": source_mapping,
    }


def build_blackrock_assumptions(jpm_assets: list[dict], source_file: Path | None) -> list[dict | None]:
    source = load_blackrock_source_data(source_file)
    mappings = {
        "U.S. Large Cap": lambda: blackrock_assumption(source, "US large cap equities", "BlackRock US large cap equities"),
        "U.S. Mid Cap": lambda: blackrock_average_assumption(
            source,
            ["US large cap equities", "US small cap equities"],
            "BlackRock average of US large cap equities and US small cap equities",
        ),
        "U.S. Small Cap": lambda: blackrock_assumption(source, "US small cap equities", "BlackRock US small cap equities"),
        "International Developed Equity": lambda: blackrock_assumption(source, "Global ex-US large cap equities", "BlackRock Global ex-US large cap equities"),
        "Emerging Markets Equity": lambda: blackrock_assumption(source, "Emerging large cap equities", "BlackRock Emerging large cap equities"),
        "U.S. REITs": lambda: blackrock_assumption(source, "Listed REITs", "BlackRock Listed REITs"),
        "US Intermediate Treasuries": lambda: blackrock_assumption(source, "US government (10- years)", "BlackRock US government (10- years)"),
        "US Long Treasuries": lambda: blackrock_assumption(source, "US government (10+ years)", "BlackRock US government (10+ years)"),
        "Investment Grade Corporate": lambda: blackrock_assumption(source, "US credit (all maturities)", "BlackRock US credit (all maturities)"),
        "High Yield": lambda: blackrock_assumption(source, "US high yield", "BlackRock US high yield"),
        "International Fixed Income (H)": lambda: blackrock_assumption(source, "Global ex-US treasuries (hedged)", "BlackRock Global ex-US treasuries (hedged)"),
        "Cash": lambda: blackrock_assumption(source, "US cash", "BlackRock US cash"),
    }

    out = []
    for asset in jpm_assets:
        assumption = mappings.get(asset["name"], lambda: None)()
        if assumption is None:
            out.append(None)
            continue
        out.append({
            **asset,
            "return": assumption["return"],
            "volatility": assumption["volatility"],
            "sourceMapping": assumption["sourceMapping"],
        })
    return out


def average_assumption_sets(source_sets: list[list[dict | None]], fallback_by_source: list[set[str]]) -> list[dict]:
    first_pass = []
    base_assets = source_sets[0]
    for index, base_asset in enumerate(base_assets):
        if base_asset is None:
            continue
        asset = dict(base_asset)
        available = []
        for source_index, source_assets in enumerate(source_sets):
            source_asset = source_assets[index]
            if source_asset is not None and asset["name"] not in fallback_by_source[source_index]:
                available.append(source_asset)
        if not available:
            available.append(base_asset)
        asset["return"] = sum(source["return"] for source in available) / len(available)
        asset["volatility"] = sum(source["volatility"] for source in available) / len(available)
        asset["_distinctSourceCount"] = len(available)
        first_pass.append(asset)

    averaged = []
    for index, asset in enumerate(first_pass):
        fallback_return = FALLBACK_RETURN_OVERRIDES.get(asset["name"])
        if fallback_return is not None:
            return_values = []
            for source_index, source_assets in enumerate(source_sets):
                source_asset = source_assets[index]
                if source_asset is not None and asset["name"] not in fallback_by_source[source_index]:
                    return_values.append(source_asset["return"])
                elif asset["name"] in fallback_by_source[source_index]:
                    return_values.append(fallback_return)
            if return_values:
                asset["return"] = sum(return_values) / len(return_values)
        asset["sourceMapping"] = "Average of available source assumptions"
        averaged.append(asset)
    return averaged


def apply_growth_proxy(source_assets: list[dict | None]) -> list[dict | None]:
    out = [dict(asset) if asset is not None else None for asset in source_assets]
    by_name = {
        optimizer.normalize_name(asset["name"]): index
        for index, asset in enumerate(out)
        if asset is not None
    }
    model_index_by_name = {
        optimizer.normalize_name(asset.name): index
        for index, asset in enumerate(optimizer.ASSETS)
    }
    growth_index = by_name.get(optimizer.normalize_name("U.S. Growth"), model_index_by_name.get(optimizer.normalize_name("U.S. Growth")))
    large_index = by_name.get(optimizer.normalize_name("U.S. Large Cap"))
    small_index = by_name.get(optimizer.normalize_name("U.S. Small Cap"))
    if growth_index is None or large_index is None or small_index is None:
        return out
    large = out[large_index]
    small = out[small_index]
    if large is None or small is None:
        return out
    model_asset = optimizer.ASSETS[growth_index]
    growth = dict(out[growth_index] or {
        "name": model_asset.name,
        "category": model_asset.category,
        "sourceNames": list(model_asset.source_names),
        "minWeight": model_asset.min_weight,
        "maxWeight": model_asset.max_weight,
    })
    growth["return"] = (large["return"] + small["return"]) / 2.0
    growth["volatility"] = (large["volatility"] + small["volatility"]) / 2.0
    growth["sourceMapping"] = ""
    out[growth_index] = growth
    return out


def apply_derived_proxies(source_assets: list[dict | None]) -> list[dict | None]:
    return apply_growth_proxy(source_assets)


def apply_average_fallback(source_assets: list[dict | None], average_assets: list[dict], source_name: str, fallback_names: set[str] | None = None) -> list[dict]:
    fallback_names = fallback_names or set()
    out = []
    for source_asset, average_asset in zip(source_assets, average_assets):
        if source_asset is not None and source_asset["name"] not in fallback_names:
            out.append(source_asset)
            continue
        asset = dict(average_asset)
        fallback_return = FALLBACK_RETURN_OVERRIDES.get(asset["name"])
        if fallback_return is not None:
            asset["return"] = fallback_return
            asset["sourceMapping"] = f"{source_name} was not given for this sleeve; fallback return input and AVERAGE volatility assumptions are used."
        else:
            asset["sourceMapping"] = f"{source_name} was not given for this sleeve; AVERAGE assumptions are used."
        out.append(asset)
    return out


def mapped_correlation_names(mapping_by_asset: dict[str, object], asset_name: str) -> list[str]:
    mapping = mapping_by_asset.get(asset_name)
    if mapping is None:
        return []
    if isinstance(mapping, tuple):
        return [optimizer.normalize_name(name) for name in mapping]
    return [optimizer.normalize_name(mapping)]


def source_correlation(source_corr: dict[str, dict[str, float]], left_names: list[str], right_names: list[str]) -> float | None:
    values = []
    for left_name in left_names:
        for right_name in right_names:
            value = source_corr.get(left_name, {}).get(right_name)
            if value is None:
                value = source_corr.get(right_name, {}).get(left_name)
            if value is not None:
                values.append(float(value))
    if not values:
        return None
    return sum(values) / len(values)


def blend_available_correlations(
    jpm_corr: np.ndarray,
    assets: list[dict],
    capital_group_file: Path | None,
    asset_allocation_interactive_file: Path | None,
) -> np.ndarray:
    providers = [
        (load_capital_group_correlation(capital_group_file), CAPITAL_GROUP_CORRELATION_MAP),
        (load_asset_allocation_interactive_correlation(asset_allocation_interactive_file), ASSET_ALLOCATION_INTERACTIVE_CORRELATION_MAP),
    ]
    blended = np.array(jpm_corr, copy=True)
    for i, left_asset in enumerate(assets):
        for j, right_asset in enumerate(assets):
            if i == j:
                blended[i, j] = 1.0
                continue
            values = [float(jpm_corr[i, j])]
            for provider_corr, provider_map in providers:
                left_names = mapped_correlation_names(provider_map, left_asset["name"])
                right_names = mapped_correlation_names(provider_map, right_asset["name"])
                if not left_names or not right_names:
                    continue
                provider_value = source_correlation(provider_corr, left_names, right_names)
                if provider_value is not None:
                    values.append(provider_value)
            blended[i, j] = sum(values) / len(values)
    return (blended + blended.T) / 2.0


def blend_capital_group_correlation(jpm_corr: np.ndarray, assets: list[dict], capital_group_file: Path | None = None) -> np.ndarray:
    capital_corr = load_capital_group_correlation(capital_group_file)
    if not capital_corr:
        return jpm_corr
    def mapped_names(asset_name: str) -> list[str]:
        mapping = CAPITAL_GROUP_CORRELATION_MAP.get(asset_name)
        if mapping is None:
            return []
        if isinstance(mapping, tuple):
            return [optimizer.normalize_name(name) for name in mapping]
        return [optimizer.normalize_name(mapping)]

    def capital_correlation(left_names: list[str], right_names: list[str]) -> float | None:
        values = []
        for left_name in left_names:
            for right_name in right_names:
                value = capital_corr.get(left_name, {}).get(right_name)
                if value is None:
                    value = capital_corr.get(right_name, {}).get(left_name)
                if value is not None:
                    values.append(float(value))
        if not values:
            return None
        return sum(values) / len(values)

    blended = np.array(jpm_corr, copy=True)
    for i, left_asset in enumerate(assets):
        left_names = mapped_names(left_asset["name"])
        if not left_names:
            continue
        for j, right_asset in enumerate(assets):
            if i == j:
                blended[i, j] = 1.0
                continue
            right_names = mapped_names(right_asset["name"])
            if not right_names:
                continue
            capital_value = capital_correlation(left_names, right_names)
            if capital_value is None:
                continue
            blended[i, j] = (float(jpm_corr[i, j]) + float(capital_value)) / 2.0
    return (blended + blended.T) / 2.0


def nearest_valid_correlation(corr: np.ndarray) -> np.ndarray:
    cleaned = (corr + corr.T) / 2.0
    values, vectors = np.linalg.eigh(cleaned)
    values = np.maximum(values, 1e-8)
    cleaned = (vectors @ np.diag(values) @ vectors.T)
    diagonal = np.sqrt(np.maximum(np.diag(cleaned), 1e-8))
    cleaned = cleaned / np.outer(diagonal, diagonal)
    cleaned = np.clip((cleaned + cleaned.T) / 2.0, -1.0, 1.0)
    np.fill_diagonal(cleaned, 1.0)
    return cleaned


def map_provider_assumptions(jpm_assets: list[dict], assumptions: dict[str, dict[str, float | str]]) -> list[dict | None]:
    mapped = []
    for asset in jpm_assets:
        assumption = assumptions.get(optimizer.normalize_name(asset["name"]))
        if assumption is None:
            mapped.append(None)
            continue
        mapped.append({
            **asset,
            "return": assumption["return"],
            "volatility": assumption["volatility"],
            "sourceMapping": assumption["sourceMapping"],
        })
    return apply_derived_proxies(mapped)


def build_year_data(year: str) -> dict[str, object]:
    source_files = year_source_files(year)
    jpm_path = source_files["jpm"]
    if jpm_path is None:
        raise FileNotFoundError(f"No JPM workbook is available for {year}.")
    jpm_data = optimizer.load_jpm_source_data(jpm_path, year)
    returns = np.array([optimizer.asset_return(asset, jpm_data) for asset in optimizer.ASSETS])
    cov = optimizer.covariance_matrix(optimizer.ASSETS, jpm_data)
    vols = np.sqrt(np.diag(cov))
    corr = cov / np.outer(vols, vols)
    corr = np.nan_to_num(corr, nan=0.0)

    jpm_assets = [
        {
            "name": asset.name,
            "category": asset.category,
            "sourceNames": list(asset.source_names),
            "return": float(returns[i]),
            "volatility": float(vols[i]),
            "minWeight": asset.min_weight,
            "maxWeight": asset.max_weight,
            "sourceMapping": asset.source_note,
        }
        for i, asset in enumerate(optimizer.ASSETS)
    ]
    jpm_assets = apply_derived_proxies(jpm_assets)

    source_sets: list[tuple[str, list[dict | None], set[str]]] = [
        ("JPM", jpm_assets, JPM_FALLBACK_TO_AVERAGE),
    ]

    if source_files["vanguard"] is not None:
        source_sets.append((
            "Vanguard",
            map_provider_assumptions(jpm_assets, load_vanguard_assumptions(source_files["vanguard"])),
            set(),
        ))
    if source_files["blackrock"] is not None:
        source_sets.append((
            "BlackRock",
            apply_derived_proxies(build_blackrock_assumptions(jpm_assets, source_files["blackrock"])),
            BLACKROCK_FALLBACK_TO_AVERAGE,
        ))
    if source_files["invesco"] is not None:
        source_sets.append((
            "Invesco",
            map_provider_assumptions(jpm_assets, load_invesco_assumptions(source_files["invesco"])),
            INVESCO_FALLBACK_TO_AVERAGE,
        ))
    if source_files["capital_group"] is not None:
        source_sets.append((
            "Capital Group",
            map_provider_assumptions(jpm_assets, load_capital_group_assumptions(source_files["capital_group"])),
            CAPITAL_GROUP_FALLBACK_TO_AVERAGE,
        ))
    if source_files["asset_allocation_interactive"] is not None:
        source_sets.append((
            "Asset Allocation Interactive",
            map_provider_assumptions(jpm_assets, load_asset_allocation_interactive_assumptions(source_files["asset_allocation_interactive"])),
            ASSET_ALLOCATION_INTERACTIVE_FALLBACK_TO_AVERAGE,
        ))

    average_assets = average_assumption_sets(
        [source_assets for _name, source_assets, _fallbacks in source_sets],
        [fallbacks for _name, _source_assets, fallbacks in source_sets],
    )
    assumption_sets = {"CORE": average_assets}
    for provider_name, source_assets, fallback_names in source_sets:
        label = f"{provider_name} {year}"
        assumption_sets[label] = apply_average_fallback(source_assets, average_assets, label, fallback_names)

    corr = blend_available_correlations(
        corr,
        average_assets,
        source_files["capital_group"],
        source_files["asset_allocation_interactive"],
    )
    corr = nearest_valid_correlation(corr)
    large_cap = next(asset for asset in average_assets if asset["name"] == "U.S. Large Cap")
    jpm_returns: dict[str, float] = jpm_data["returns"]  # type: ignore[assignment]
    jpm_vols: dict[str, float] = jpm_data["vols"]  # type: ignore[assignment]
    benchmarks = [
        {
            "name": "S&P 500",
            "return": large_cap["return"],
            "volatility": large_cap["volatility"],
            "sourceMapping": f"{year} Average U.S. Large Cap assumption",
        },
        {
            "name": "AGG",
            "return": jpm_returns[optimizer.normalize_name("U.S. Aggregate Bonds")],
            "volatility": jpm_vols[optimizer.normalize_name("U.S. Aggregate Bonds")],
            "sourceMapping": "JPM U.S. Aggregate Bonds assumption",
        },
    ]

    return {
        "generatedFrom": str(jpm_path),
        "selectedAssumptionSet": "CORE",
        "assets": average_assets,
        "assumptionSets": assumption_sets,
        "benchmarks": benchmarks,
        "correlation": corr.tolist(),
    }


def available_assumption_years() -> list[str]:
    years = []
    for path in INPUTS_DIR.iterdir():
        if not path.is_dir() or not path.name.isdigit():
            continue
        try:
            optimizer.jpm_matrix_path(path.name)
        except FileNotFoundError:
            continue
        years.append(path.name)
    return sorted(years)


def main() -> None:
    years = available_assumption_years()
    if DEFAULT_ASSUMPTION_YEAR not in years:
        raise FileNotFoundError(f"The default assumption year {DEFAULT_ASSUMPTION_YEAR} has no JPM source workbook.")
    assumption_years = {year: build_year_data(year) for year in years}
    active_year = assumption_years[DEFAULT_ASSUMPTION_YEAR]
    volatility_model = {
        "mode": "feasiblePercentile",
        "halfWidth": max(half_width for _offset, half_width in optimizer.TARGET_VOLATILITY_RULES.values()),
        "profiles": {},
    }
    for profile, (_offset, _half_width) in optimizer.TARGET_VOLATILITY_RULES.items():
        volatility_model["profiles"][profile] = {
            "percentile": optimizer.VOLATILITY_PERCENTILES[profile],
            "halfWidth": volatility_model["halfWidth"],
        }
    fund_models = load_fund_models()

    payload = {
        "generatedFrom": active_year["generatedFrom"],
        "cashTarget": optimizer.CASH_TARGET,
        "categories": optimizer.CATEGORIES,
        "defaultAssumptionYear": DEFAULT_ASSUMPTION_YEAR,
        "assumptionYears": assumption_years,
        "selectedAssumptionSet": "CORE",
        "assets": active_year["assets"],
        "assumptionSets": active_year["assumptionSets"],
        "volatilityModel": volatility_model,
        "benchmarks": active_year["benchmarks"],
        "fundModels": fund_models,
        "profiles": {
            profile: {
                "targetVolMin": config["target_volatility"][0],
                "targetVolMax": config["target_volatility"][1],
                "categoryBounds": {
                    category: {"min": bounds[0], "max": bounds[1]}
                    for category, bounds in config["category_bounds"].items()
                },
            }
            for profile, config in optimizer.PROFILES.items()
        },
        "correlation": active_year["correlation"],
    }

    WEB_DATA.parent.mkdir(parents=True, exist_ok=True)
    WEB_DATA.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(WEB_DATA)


if __name__ == "__main__":
    main()
