from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import portfolio_optimizer as optimizer


ROOT = Path(__file__).resolve().parents[1]
WEB_DATA = ROOT / "web" / "data" / "model-data.json"


def main() -> None:
    jpm_data = optimizer.load_jpm_source_data()
    returns = np.array([optimizer.asset_return(asset, jpm_data) for asset in optimizer.ASSETS])
    cov = optimizer.covariance_matrix(optimizer.ASSETS, jpm_data)
    vols = np.sqrt(np.diag(cov))
    corr = cov / np.outer(vols, vols)
    corr = np.nan_to_num(corr, nan=0.0)
    results = optimizer.calculate_results()
    volatility_model = {
        "mode": "feasiblePercentile",
        "profiles": {},
    }
    for profile, (offset, half_width) in optimizer.TARGET_VOLATILITY_RULES.items():
        volatility_model["profiles"][profile] = {
            "percentile": optimizer.VOLATILITY_PERCENTILES[profile],
            "halfWidth": half_width,
        }

    payload = {
        "generatedFrom": str(optimizer.jpm_matrix_path()),
        "cashTarget": optimizer.CASH_TARGET,
        "categories": optimizer.CATEGORIES,
        "assets": [
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
        ],
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
        "currentOutputs": {
            profile: {
                "return": data["stats"][0],
                "volatility": data["stats"][1],
                "sharpe": data["stats"][2],
                "weights": data["weights"].tolist(),
            }
            for profile, data in results["mvo"].items()
        },
    }

    WEB_DATA.parent.mkdir(parents=True, exist_ok=True)
    WEB_DATA.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(WEB_DATA)


if __name__ == "__main__":
    main()
