from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import portfolio_optimizer as optimizer


ROOT = Path(__file__).resolve().parents[1]
WEB_DATA = ROOT / "web" / "data" / "model-data.json"


VANGUARD_ASSUMPTIONS = {
    "U.S. Large Cap": {
        "return": 0.051,
        "volatility": 0.150,
        "sourceMapping": "Vanguard U.S. large-cap",
    },
    "U.S. Value": {
        "return": 0.074,
        "volatility": 0.190,
        "sourceMapping": "Vanguard U.S. value",
    },
    "U.S. Growth": {
        "return": 0.046,
        "volatility": 0.163,
        "sourceMapping": "Vanguard U.S. growth",
    },
    "U.S. Mid Cap": {
        "return": 0.052,
        "volatility": 0.151,
        "sourceMapping": "Vanguard U.S. equities proxy",
    },
    "U.S. Small Cap": {
        "return": 0.057,
        "volatility": 0.197,
        "sourceMapping": "Vanguard U.S. small-cap",
    },
    "International Developed Equity": {
        "return": 0.055,
        "volatility": 0.180,
        "sourceMapping": "Vanguard developed markets ex-U.S. equities (unhedged)",
    },
    "Emerging Markets Equity": {
        "return": 0.030,
        "volatility": 0.251,
        "sourceMapping": "Vanguard emerging markets equities (unhedged)",
    },
    "U.S. REITs": {
        "return": 0.044,
        "volatility": 0.179,
        "sourceMapping": "Vanguard U.S. REITs",
    },
    "Commodities": {
        "return": 0.057,
        "volatility": 0.167,
        "sourceMapping": "Vanguard Commodities",
    },
    "Income U.S. - U.S. Treasury": {
        "return": (0.042 + 0.057 + 0.038) / 3,
        "volatility": (0.051 + 0.104 + 0.049) / 3,
        "sourceMapping": "Equal-weight Vanguard U.S. intermediate-term Treasury bonds, U.S. long-term Treasury bonds, and U.S. TIPS",
    },
    "Income U.S. Government Related": {
        "return": (0.048 + 0.040) / 2,
        "volatility": (0.062 + 0.047) / 2,
        "sourceMapping": "Equal-weight Vanguard U.S. aggregate bonds and U.S. municipal bonds",
    },
    "Income U.S. Corporate": {
        "return": (0.048 + 0.052) / 2,
        "volatility": (0.064 + 0.096) / 2,
        "sourceMapping": "Equal-weight Vanguard U.S. credit and U.S. high-yield corporate bonds",
    },
    "Income U.S. Securitized": {
        "return": 0.052,
        "volatility": 0.039,
        "sourceMapping": "Vanguard U.S. mortgage-backed securities",
    },
    "Fixed Income International": {
        "return": (0.050 + 0.060) / 2,
        "volatility": (0.050 + 0.111) / 2,
        "sourceMapping": "Equal-weight Vanguard global ex-U.S. aggregate bonds hedged and emerging markets sovereign bonds hedged",
    },
    "Other Fixed Income": {
        "return": (0.060 + 0.045) / 2,
        "volatility": (0.111 + 0.081) / 2,
        "sourceMapping": "Equal-weight Vanguard emerging markets sovereign bonds hedged and U.S. high-yield municipal bonds",
    },
    "Cash": {
        "return": 0.035,
        "volatility": 0.011,
        "sourceMapping": "Vanguard U.S. cash",
    },
}


JPM_FALLBACK_TO_AVERAGE = {"U.S. Growth"}


def average_assumption_sets(jpm_assets: list[dict], vanguard_assets: list[dict | None]) -> list[dict]:
    averaged = []
    for jpm_asset, vanguard_asset in zip(jpm_assets, vanguard_assets):
        asset = dict(jpm_asset)
        available = []
        if asset["name"] not in JPM_FALLBACK_TO_AVERAGE:
            available.append(jpm_asset)
        if vanguard_asset is not None:
            available.append(vanguard_asset)
        if not available:
            available.append(jpm_asset)
        asset["return"] = sum(source["return"] for source in available) / len(available)
        asset["volatility"] = sum(source["volatility"] for source in available) / len(available)
        asset["sourceMapping"] = "Average of available source assumptions"
        averaged.append(asset)
    return averaged


def apply_average_fallback(source_assets: list[dict | None], average_assets: list[dict], source_name: str, fallback_names: set[str] | None = None) -> list[dict]:
    fallback_names = fallback_names or set()
    out = []
    for source_asset, average_asset in zip(source_assets, average_assets):
        if source_asset is not None and source_asset["name"] not in fallback_names:
            out.append(source_asset)
            continue
        asset = dict(average_asset)
        asset["sourceMapping"] = f"{source_name} did not publish a distinct assumption for this sleeve; AVERAGE assumptions are used."
        out.append(asset)
    return out


def main() -> None:
    jpm_data = optimizer.load_jpm_source_data()
    returns = np.array([optimizer.asset_return(asset, jpm_data) for asset in optimizer.ASSETS])
    cov = optimizer.covariance_matrix(optimizer.ASSETS, jpm_data)
    vols = np.sqrt(np.diag(cov))
    corr = cov / np.outer(vols, vols)
    corr = np.nan_to_num(corr, nan=0.0)
    volatility_model = {
        "mode": "feasiblePercentile",
        "profiles": {},
    }
    for profile, (offset, half_width) in optimizer.TARGET_VOLATILITY_RULES.items():
        volatility_model["profiles"][profile] = {
            "percentile": optimizer.VOLATILITY_PERCENTILES[profile],
            "halfWidth": half_width,
        }

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
    raw_vanguard_assets = []
    for asset in jpm_assets:
        if asset["name"] in VANGUARD_ASSUMPTIONS:
            raw_vanguard_assets.append({
                **asset,
                "return": VANGUARD_ASSUMPTIONS[asset["name"]]["return"],
                "volatility": VANGUARD_ASSUMPTIONS[asset["name"]]["volatility"],
                "sourceMapping": VANGUARD_ASSUMPTIONS[asset["name"]]["sourceMapping"],
            })
        else:
            raw_vanguard_assets.append(None)
    average_assets = average_assumption_sets(jpm_assets, raw_vanguard_assets)
    jpm_assets = apply_average_fallback(jpm_assets, average_assets, "JPM 2026", JPM_FALLBACK_TO_AVERAGE)
    vanguard_assets = apply_average_fallback(raw_vanguard_assets, average_assets, "Vanguard 2026")

    payload = {
        "generatedFrom": str(optimizer.jpm_matrix_path()),
        "cashTarget": optimizer.CASH_TARGET,
        "categories": optimizer.CATEGORIES,
        "selectedAssumptionSet": "CORE",
        "assets": average_assets,
        "assumptionSets": {
            "CORE": average_assets,
            "JPM 2026": jpm_assets,
            "Vanguard 2026": vanguard_assets,
        },
        "volatilityModel": volatility_model,
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
        "correlation": corr.tolist(),
    }

    WEB_DATA.parent.mkdir(parents=True, exist_ok=True)
    WEB_DATA.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(WEB_DATA)


if __name__ == "__main__":
    main()
