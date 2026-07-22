const pct = (value) => `${(value * 100).toFixed(2)}%`;
const num = (value) => Number.parseFloat(value || 0);

let baseData;
let state;
let results = {};
let frontierResult = null;
let mvoDirty = true;
let mvoTimer = null;
let liveUpdateTimer = null;
let selectedMvoProfile = "Moderate";

const clone = (value) => JSON.parse(JSON.stringify(value));
const defaultVolatilityPercentiles = {
  "Conservative": 25,
  "Balanced": 40,
  "Moderate": 55,
  "Growth": 70,
  "Aggressive Growth": 85,
};

function buildVolatilityModel(profiles) {
  const model = { mode: "feasiblePercentile", profiles: {} };
  Object.entries(profiles).forEach(([name, profile]) => {
    model.profiles[name] = {
      percentile: defaultVolatilityPercentiles[name] ?? 50,
      halfWidth: (profile.targetVolMax - profile.targetVolMin) / 2,
    };
  });
  return model;
}

function ensureVolatilityModel() {
  state.volatilityModel ||= buildVolatilityModel(state.profiles);
  state.volatilityModel.mode = "feasiblePercentile";
  Object.entries(state.profiles).forEach(([name, profile]) => {
    state.volatilityModel.profiles ||= {};
    state.volatilityModel.profiles[name] ||= {};
    state.volatilityModel.profiles[name].percentile ??= defaultVolatilityPercentiles[name] ?? 50;
    state.volatilityModel.profiles[name].halfWidth ??= (profile.targetVolMax - profile.targetVolMin) / 2;
  });
}

function percentileValue(values, percentile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.max(0, Math.min(100, percentile));
  const pos = (clamped / 100) * (sorted.length - 1);
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower];
  const weight = pos - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function feasibleVolatilities(profileName) {
  const profile = state.profiles[profileName];
  const vols = [];
  const rand = seededRandom(7051 + profileName.length * 509);
  for (let i = 0; i < 2200; i += 1) {
    const weights = randomAssetWeights(profile, rand);
    if (!weights) continue;
    vols.push(portfolioStats(weights, state.assets, state.correlation).volatility);
  }
  return vols;
}

function applyVolatilityModel() {
  ensureVolatilityModel();
  const model = state.volatilityModel;
  Object.entries(model.profiles).forEach(([name, rule]) => {
    const feasible = feasibleVolatilities(name);
    const fallbackMidpoint = (state.profiles[name].targetVolMin + state.profiles[name].targetVolMax) / 2;
    const midpoint = feasible.length ? percentileValue(feasible, rule.percentile) : fallbackMidpoint;
    state.profiles[name].targetVolMin = Math.max(0, midpoint - rule.halfWidth);
    state.profiles[name].targetVolMax = Math.max(0, midpoint + rule.halfWidth);
  });
}

function seededRandom(seed) {
  let x = seed >>> 0;
  return () => {
    x = (1664525 * x + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

function categoryGroups(assets) {
  const groups = {};
  assets.forEach((asset, index) => {
    groups[asset.category] ||= [];
    groups[asset.category].push(index);
  });
  return groups;
}

function allocateWithinBounds(total, indexes, rand) {
  const mins = indexes.map((index) => state.assets[index].minWeight);
  const maxes = indexes.map((index) => state.assets[index].maxWeight);
  const minTotal = mins.reduce((sum, value) => sum + value, 0);
  const maxTotal = maxes.reduce((sum, value) => sum + value, 0);
  if (total < minTotal - 1e-9 || total > maxTotal + 1e-9) return null;
  if (indexes.length === 1) return [total];

  const values = [...mins];
  let remaining = total - minTotal;
  for (let pass = 0; pass < 40 && remaining > 1e-10; pass += 1) {
    const active = values
      .map((value, i) => ({ i, capacity: maxes[i] - value }))
      .filter((row) => row.capacity > 1e-10);
    if (!active.length) break;
    const draws = active.map((row) => row.capacity * (0.15 + rand()));
    const drawTotal = draws.reduce((sum, value) => sum + value, 0) || 1;
    active.forEach((row, i) => {
      const add = Math.min(row.capacity, remaining * draws[i] / drawTotal);
      values[row.i] += add;
    });
    remaining = total - values.reduce((sum, value) => sum + value, 0);
  }
  if (Math.abs(remaining) > 1e-7) {
    const target = remaining > 0
      ? values.findIndex((value, i) => maxes[i] - value > remaining - 1e-9)
      : values.findIndex((value, i) => value - mins[i] > -remaining - 1e-9);
    if (target >= 0) values[target] += remaining;
  }
  return values;
}

function randomAssetWeights(profile, rand) {
  const categoryWeights = randomCategoryWeights(profile, state.categories, rand);
  const weights = Array(state.assets.length).fill(0);
  const groups = categoryGroups(state.assets);
  for (const [category, indexes] of Object.entries(groups)) {
    const allocation = allocateWithinBounds(categoryWeights[category] || 0, indexes, rand);
    if (!allocation) return null;
    indexes.forEach((assetIndex, i) => {
      weights[assetIndex] = allocation[i];
    });
  }
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 0.0001) return null;
  return weights.map((weight) => weight / total);
}

function portfolioStats(weights, assets, corr) {
  const expectedReturn = weights.reduce((sum, w, i) => sum + w * assets[i].return, 0);
  let variance = 0;
  for (let i = 0; i < weights.length; i += 1) {
    for (let j = 0; j < weights.length; j += 1) {
      variance += weights[i] * weights[j] * assets[i].volatility * assets[j].volatility * corr[i][j];
    }
  }
  const volatility = Math.sqrt(Math.max(variance, 0));
  return { expectedReturn, volatility, sharpe: volatility ? (expectedReturn - 0.031) / volatility : 0 };
}

function covarianceMatrix(assets, corr) {
  return assets.map((assetI, i) => assets.map((assetJ, j) => assetI.volatility * assetJ.volatility * corr[i][j]));
}

function matVec(matrix, vector) {
  return matrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index], 0));
}

function projectToSimplex(values) {
  const sorted = [...values].sort((a, b) => b - a);
  let cumulative = 0;
  let theta = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    cumulative += sorted[i];
    const candidate = (cumulative - 1) / (i + 1);
    if (i === sorted.length - 1 || sorted[i + 1] <= candidate) {
      theta = candidate;
      break;
    }
  }
  return values.map((value) => Math.max(value - theta, 0));
}

function optimizeProjected(start, gradientFn, iterations = 120, step = 0.08) {
  let weights = projectToSimplex(start);
  for (let i = 0; i < iterations; i += 1) {
    const gradient = gradientFn(weights);
    const rate = step / Math.sqrt(i + 1);
    weights = projectToSimplex(weights.map((weight, index) => weight + rate * gradient[index]));
  }
  return weights;
}

function calculateEfficientFrontier() {
  const assets = state.assets;
  const returns = assets.map((asset) => asset.return);
  const excessReturns = returns.map((value) => value - 0.031);
  const cov = covarianceMatrix(assets, state.correlation);
  const count = assets.length;
  const equal = Array(count).fill(1 / count);
  const starts = [equal];

  assets.forEach((_, index) => {
    const weights = Array(count).fill(0);
    weights[index] = 1;
    starts.push(weights);
  });

  returns.forEach((_, index) => {
    const anchor = Array(count).fill(0);
    anchor[index] = 0.72;
    const rest = (1 - anchor[index]) / (count - 1);
    for (let j = 0; j < count; j += 1) {
      if (j !== index) anchor[j] = rest;
    }
    starts.push(anchor);
  });

  const sharpeGradient = (weights) => {
    const covW = matVec(cov, weights);
    const variance = Math.max(weights.reduce((sum, weight, index) => sum + weight * covW[index], 0), 1e-10);
    const volatility = Math.sqrt(variance);
    const excessReturn = weights.reduce((sum, weight, index) => sum + weight * excessReturns[index], 0);
    return excessReturns.map((value, index) => value / volatility - (excessReturn * covW[index]) / Math.pow(volatility, 3));
  };

  const candidates = starts.map((start) => {
    const weights = optimizeProjected(start, sharpeGradient, 90, 0.08);
    return { weights, stats: portfolioStats(weights, assets, state.correlation) };
  });

  let best = candidates.reduce((winner, candidate) => (candidate.stats.sharpe > winner.stats.sharpe ? candidate : winner), candidates[0]);

  const frontier = [];
  for (let i = 0; i < 56; i += 1) {
    const riskPenalty = Math.pow(10, -3 + (i / 55) * 5.2);
    const gradientFn = (weights) => {
      const covW = matVec(cov, weights);
      return returns.map((value, index) => value - 2 * riskPenalty * covW[index]);
    };
    const start = starts[i % starts.length];
    const weights = optimizeProjected(start, gradientFn, 120, 0.18);
    frontier.push({ weights, stats: portfolioStats(weights, assets, state.correlation) });
  }

  const assetPoints = assets.map((asset, index) => {
    const weights = Array(count).fill(0);
    weights[index] = 1;
    return { asset, weights, stats: portfolioStats(weights, assets, state.correlation) };
  });

  const frontierCandidates = [...frontier, ...assetPoints, best]
    .sort((a, b) => a.stats.volatility - b.stats.volatility)
    .filter((portfolio, index, rows) => index === 0 || portfolio.stats.expectedReturn >= Math.max(...rows.slice(0, index).map((row) => row.stats.expectedReturn)) - 1e-6);

  const cleanFrontier = frontierCandidates.filter((portfolio, index, rows) => (
    index === 0 || Math.abs(portfolio.stats.volatility - rows[index - 1].stats.volatility) > 0.00035
  ));

  return { best, frontier: cleanFrontier, assetPoints };
}

function convexHull(points) {
  if (points.length <= 2) return points;
  const sorted = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (origin, a, b) => (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  const lower = [];
  sorted.forEach((point) => {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
    lower.push(point);
  });
  const upper = [];
  [...sorted].reverse().forEach((point) => {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
    upper.push(point);
  });
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function globalFeasibleRegion(selected) {
  const points = [];
  const seen = new Set();
  const addPoint = (weights) => {
    if (!weights) return;
    const stats = portfolioStats(weights, state.assets, state.correlation);
    const key = `${stats.volatility.toFixed(5)}|${stats.expectedReturn.toFixed(5)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const point = { x: stats.volatility, y: stats.expectedReturn, stats, weights };
    points.push(point);
  };

  Object.entries(state.profiles).forEach(([profileName, profile]) => {
    const rand = seededRandom(4409 + profileName.length * 733);
    for (let i = 0; i < 850; i += 1) {
      try {
        addPoint(randomAssetWeights(profile, rand));
      } catch (_error) {
        break;
      }
    }
  });

  points.push({ x: selected.stats.volatility, y: selected.stats.expectedReturn, stats: selected.stats, weights: selected.weights });
  return {
    points,
    hull: convexHull(points),
    mode: "global allowable weighting region",
  };
}

function randomCategoryWeights(profile, categories, rand) {
  const fixed = {};
  const variable = [];
  let remaining = 1;
  categories.forEach((category) => {
    const bounds = profile.categoryBounds[category];
    if (Math.abs(bounds.max - bounds.min) < 1e-10) {
      fixed[category] = bounds.min;
      remaining -= bounds.min;
    } else {
      variable.push(category);
    }
  });

  const out = { ...fixed };
  variable.forEach((category, i) => {
    if (i === variable.length - 1) {
      out[category] = remaining;
      return;
    }
    const next = variable.slice(i + 1);
    const minLeft = next.reduce((sum, c) => sum + profile.categoryBounds[c].min, 0);
    const maxLeft = next.reduce((sum, c) => sum + profile.categoryBounds[c].max, 0);
    const lo = Math.max(profile.categoryBounds[category].min, remaining - maxLeft);
    const hi = Math.min(profile.categoryBounds[category].max, remaining - minLeft);
    out[category] = lo + rand() * Math.max(hi - lo, 0);
    remaining -= out[category];
  });
  return out;
}

function optimizeProfile(profileName, seedOffset = 17, draws = 900) {
  const profile = state.profiles[profileName];
  const rand = seededRandom(profileName.length * 1009 + seedOffset);
  let best = null;
  let fallback = null;
  const categories = state.categories;

  for (let i = 0; i < draws; i += 1) {
    const weights = randomAssetWeights(profile, rand);
    if (!weights) continue;
    const stats = portfolioStats(weights, state.assets, state.correlation);
    const categoryWeights = {};
    categories.forEach((category) => {
      categoryWeights[category] = weights.reduce((sum, weight, index) => (
        state.assets[index].category === category ? sum + weight : sum
      ), 0);
    });
    const inTarget = stats.volatility >= profile.targetVolMin && stats.volatility <= profile.targetVolMax;
    const candidate = { profileName, categoryWeights, weights, stats };
    if (inTarget && (!best || stats.expectedReturn > best.stats.expectedReturn)) best = candidate;
    const gap = stats.volatility < profile.targetVolMin
      ? profile.targetVolMin - stats.volatility
      : stats.volatility > profile.targetVolMax
        ? stats.volatility - profile.targetVolMax
        : 0;
    const fallbackScore = -gap + stats.expectedReturn * 0.001;
    if (!fallback || fallbackScore > fallback.score) fallback = { ...candidate, score: fallbackScore };
  }
  return best || fallback;
}

function calculateConstrainedResults() {
  const nextResults = {};
  Object.keys(state.profiles).forEach((profile) => {
    const mvo = optimizeProfile(profile, 17, 900);
    const weights = mvo.weights;
    const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
    const normalizedWeights = weights.map((weight) => weight / total);
    const categoryWeights = {};
    state.categories.forEach((category) => {
      categoryWeights[category] = normalizedWeights.reduce((sum, weight, index) => (
        state.assets[index].category === category ? sum + weight : sum
      ), 0);
    });
    nextResults[profile] = {
      profileName: profile,
      categoryWeights,
      weights: normalizedWeights,
      stats: portfolioStats(normalizedWeights, state.assets, state.correlation),
      methods: { mvo },
    };
  });
  return nextResults;
}

function runOptimization() {
  applyVolatilityModel();
  results = calculateConstrainedResults();
  renderAll();
  mvoDirty = true;
  if (mvoIsActive()) refreshMvo();
}

function statusFor(profileName, vol) {
  const profile = state.profiles[profileName];
  if (vol < profile.targetVolMin - 0.0001) return "Below target";
  if (vol > profile.targetVolMax + 0.0001) return "Above target";
  return "In target";
}

function renderMetrics() {
  const box = document.querySelector("#metrics");
  if (!box) return;
  box.innerHTML = Object.entries(results).map(([name, result]) => {
    const status = statusFor(name, result.stats.volatility);
    const cls = status === "In target" ? "pos" : "warn";
    return `<div class="metric">
      <div class="label">${name}</div>
      <div class="value">${pct(result.stats.volatility)}</div>
      <div class="status ${cls}">${status}</div>
    </div>`;
  }).join("");
}

function renderSummary() {
  const table = document.querySelector("#summaryTable");
  if (!table) return;
  table.innerHTML = `<thead><tr>
    <th>Portfolio</th><th>Return</th><th>Volatility</th><th>Status</th>
    ${state.categories.map((c) => `<th>${c}</th>`).join("")}
  </tr></thead><tbody>${Object.entries(results).map(([name, result]) => {
    const status = statusFor(name, result.stats.volatility);
    return `<tr><td>${name}</td><td>${pct(result.stats.expectedReturn)}</td><td>${pct(result.stats.volatility)}</td>
    <td class="${status === "In target" ? "pos" : "warn"}">${status}</td>
    ${state.categories.map((c) => `<td>${pct(result.categoryWeights[c] || 0)}</td>`).join("")}</tr>`;
  }).join("")}</tbody>`;
}

function editableCell(value, path, type = "percent") {
  const display = type === "percent" ? (value * 100).toFixed(2) : value;
  return `<input data-path="${path}" data-type="${type}" value="${display}" />`;
}

function renderProfiles() {
  applyVolatilityModel();
  const control = document.querySelector("#volatilityControl");
  const model = state.volatilityModel;
  control.innerHTML = `<div class="percentile-grid">
    ${Object.keys(state.profiles).map((name) => `<div class="percentile-field">
      <label>${name} Volatility Percentile</label>
      <div class="unit-input">
        ${editableCell(model.profiles[name].percentile || 0, `volatilityModel.profiles.${name}.percentile`, "number")}
        <span>%</span>
      </div>
    </div>`).join("")}
  </div>
  <p>These percentiles set each portfolio's target volatility range from the portfolios that are feasible under the current allocation and sub-allocation constraints. Lower percentiles create lower-risk targets; higher percentiles create higher-risk targets. Starting defaults are 25%, 40%, 55%, 70%, and 85%.</p>`;

  const table = document.querySelector("#profilesTable");
  table.innerHTML = `<thead><tr><th>Portfolio</th><th>Target Vol Min</th><th>Target Vol Max</th><th>Volatility Percentile</th>
    ${state.categories.flatMap((c) => [`<th>${c} Min</th>`, `<th>${c} Max</th>`]).join("")}
  </tr></thead><tbody>${Object.entries(state.profiles).map(([name, profile]) => `<tr>
    <td>${name}</td>
    <td>${pct(profile.targetVolMin)}</td>
    <td>${pct(profile.targetVolMax)}</td>
    <td>${(state.volatilityModel.profiles[name].percentile || 0).toFixed(1)}%</td>
    ${state.categories.map((c) => `<td>${editableCell(profile.categoryBounds[c].min, `profiles.${name}.categoryBounds.${c}.min`)}</td><td>${editableCell(profile.categoryBounds[c].max, `profiles.${name}.categoryBounds.${c}.max`)}</td>`).join("")}
  </tr>`).join("")}</tbody>`;

  const subTable = document.querySelector("#subConstraintsTable");
  subTable.innerHTML = `<thead><tr><th>Asset</th><th>Category</th><th>Min Weight</th><th>Max Weight</th></tr></thead>
  <tbody>${state.assets.map((asset, i) => `<tr>
      <td class="text">${asset.name}</td>
      <td>${asset.category}</td>
      <td>${editableCell(asset.minWeight, `assets.${i}.minWeight`)}</td>
      <td>${editableCell(asset.maxWeight, `assets.${i}.maxWeight`)}</td>
    </tr>`).join("")}</tbody>`;
}

function renderAssets() {
  const table = document.querySelector("#assetsTable");
  table.innerHTML = `<thead><tr><th>Asset</th><th>Category</th><th>Source</th><th>Return</th><th>Volatility</th></tr></thead>
  <tbody>${state.assets.map((asset, i) => `<tr>
      <td class="text">${asset.name}</td><td>${asset.category}</td><td class="text">${asset.sourceNames.join(", ")}</td>
      <td>${editableCell(asset.return, `assets.${i}.return`)}</td>
      <td>${editableCell(asset.volatility, `assets.${i}.volatility`)}</td>
    </tr>`).join("")}</tbody>`;
}

function renderAllocationWeights() {
  const table = document.querySelector("#allocationWeightsTable");
  table.innerHTML = `<thead><tr><th>Allocation</th>${Object.keys(results).map((p) => `<th>${p}</th>`).join("")}</tr></thead>
  <tbody>${state.categories.map((category) => `<tr><td>${category}</td>${Object.values(results).map((result) => `<td>${pct(result.categoryWeights[category] || 0)}</td>`).join("")}</tr>`).join("")}</tbody>`;
}

function renderWeights() {
  const table = document.querySelector("#weightsTable");
  table.innerHTML = `<thead><tr><th>Asset</th>${Object.keys(results).map((p) => `<th>${p}</th>`).join("")}</tr></thead>
  <tbody>${state.assets.map((asset, i) => `<tr><td>${asset.name}</td>${Object.values(results).map((result) => `<td>${pct(result.weights[i])}</td>`).join("")}</tr>`).join("")}</tbody>`;
}

function renderMvoControls() {
  const select = document.querySelector("#mvoProfileSelect");
  if (!select) return;
  const profileNames = Object.keys(state.profiles);
  if (!profileNames.includes(selectedMvoProfile)) selectedMvoProfile = profileNames[0];
  select.innerHTML = profileNames.map((name) => `<option value="${name}" ${name === selectedMvoProfile ? "selected" : ""}>${name}</option>`).join("");
  select.value = selectedMvoProfile;
  select.onchange = () => {
    selectedMvoProfile = select.value;
    renderMvo();
  };
}

function renderMvo() {
  renderMvoControls();
  if (!frontierResult) return;
  if (frontierResult.error) {
    document.querySelector("#mvoMetrics").innerHTML = `<div class="metric"><div class="label">Status</div><div class="value warn">Error</div><div class="status warn">${frontierResult.error}</div></div>`;
    document.querySelector("#frontierChart").innerHTML = `<p class="frontier-note">The MVO chart could not run. Check that Asset Assumptions have valid return and volatility numbers.</p>`;
    document.querySelector("#mvoWeightsTable").innerHTML = "";
    return;
  }
  const selected = results[selectedMvoProfile];
  if (!selected) return;
  const profile = state.profiles[selectedMvoProfile];
  const metrics = document.querySelector("#mvoMetrics");
  const status = statusFor(selectedMvoProfile, selected.stats.volatility);
  metrics.innerHTML = [
    ["Portfolio", selectedMvoProfile],
    ["Expected Return", pct(selected.stats.expectedReturn)],
    ["Volatility", pct(selected.stats.volatility)],
    ["Target Volatility", `${pct(profile.targetVolMin)} - ${pct(profile.targetVolMax)}`],
    ["Status", status],
  ].map(([label, value]) => `<div class="metric"><div class="label">${label}</div><div class="value">${value}</div></div>`).join("");

  const table = document.querySelector("#mvoWeightsTable");
  table.innerHTML = `<thead><tr><th>Asset</th><th>Category</th><th>Weight</th></tr></thead>
    <tbody>${state.assets.map((asset, index) => `<tr><td>${asset.name}</td><td>${asset.category}</td><td>${pct(selected.weights[index])}</td></tr>`).join("")}
    <tr><td>Total</td><td>Check</td><td>${pct(selected.weights.reduce((sum, weight) => sum + weight, 0))}</td></tr></tbody>`;

  renderFrontierChart(selected, frontierResult.frontier, frontierResult.assetPoints, profile);
}

function renderFrontierChart(selected, frontier, assetPoints, profile) {
  const box = document.querySelector("#frontierChart");
  const region = globalFeasibleRegion(selected);
  const all = [...frontier, ...assetPoints, selected, ...region.points.map((point) => ({ stats: point.stats }))];
  const regionDotStep = Math.max(1, Math.ceil(region.points.length / 260));
  const visibleRegionPoints = region.points.filter((_, index) => index % regionDotStep === 0);
  const minVol = Math.min(...all.map((p) => p.stats.volatility));
  const maxVol = Math.max(...all.map((p) => p.stats.volatility));
  const minReturn = Math.min(...all.map((p) => p.stats.expectedReturn));
  const maxReturn = Math.max(...all.map((p) => p.stats.expectedReturn));
  const xMin = Math.max(0, minVol - (maxVol - minVol) * 0.025);
  const xMax = maxVol + (maxVol - minVol) * 0.035;
  const yMin = Math.max(0, minReturn - (maxReturn - minReturn) * 0.06);
  const yMax = maxReturn + (maxReturn - minReturn) * 0.055;
  const width = 820;
  const height = 430;
  const pad = { left: 66, right: 32, top: 34, bottom: 64 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const xScale = (value) => pad.left + ((value - xMin) / Math.max(xMax - xMin, 1e-8)) * plotW;
  const yScale = (value) => pad.top + (1 - ((value - yMin) / Math.max(yMax - yMin, 1e-8))) * plotH;
  const frontierPath = frontier.map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.stats.volatility).toFixed(1)} ${yScale(p.stats.expectedReturn).toFixed(1)}`).join(" ");
  const regionPolygon = region.hull.map((point) => `${xScale(point.x).toFixed(1)},${yScale(point.y).toFixed(1)}`).join(" ");
  const xTicks = Array.from({ length: 6 }, (_, i) => xMin + ((xMax - xMin) * i) / 5);
  const yTicks = Array.from({ length: 6 }, (_, i) => yMin + ((yMax - yMin) * i) / 5);
  const bandX = xScale(profile.targetVolMin);
  const bandWidth = Math.max(2, xScale(profile.targetVolMax) - bandX);
  const bandMid = bandX + bandWidth / 2;
  const bandLabelX = Math.min(Math.max(bandMid, pad.left + 92), width - pad.right - 92);
  const selectedX = xScale(selected.stats.volatility);
  const selectedY = yScale(selected.stats.expectedReturn);
  const regionShape = region.hull.length >= 3
    ? `<polygon points="${regionPolygon}" fill="#8ecae6" opacity="0.32" stroke="#2f80b7" stroke-width="2" stroke-linejoin="round"></polygon>`
    : region.hull.length === 2
      ? `<line x1="${xScale(region.hull[0].x).toFixed(1)}" y1="${yScale(region.hull[0].y).toFixed(1)}" x2="${xScale(region.hull[1].x).toFixed(1)}" y2="${yScale(region.hull[1].y).toFixed(1)}" stroke="#8ecae6" stroke-width="14" stroke-linecap="round" opacity="0.42"></line>
        <line x1="${xScale(region.hull[0].x).toFixed(1)}" y1="${yScale(region.hull[0].y).toFixed(1)}" x2="${xScale(region.hull[1].x).toFixed(1)}" y2="${yScale(region.hull[1].y).toFixed(1)}" stroke="#2f80b7" stroke-width="2.2" stroke-linecap="round"></line>`
      : "";
  const constraintStatus = (actual, min, max) => (actual >= min - 0.0001 && actual <= max + 0.0001 ? "In range" : "Out of range");
  const categoryRows = state.categories.map((category) => {
    const bounds = profile.categoryBounds[category];
    const actual = selected.categoryWeights?.[category] || 0;
    return `<tr>
      <td>${category}</td>
      <td>${pct(actual)}</td>
      <td>${pct(bounds.min)}</td>
      <td>${pct(bounds.max)}</td>
      <td class="${constraintStatus(actual, bounds.min, bounds.max) === "In range" ? "pos" : "warn"}">${constraintStatus(actual, bounds.min, bounds.max)}</td>
    </tr>`;
  }).join("");
  const subRows = state.assets.map((asset, index) => {
    const actual = selected.weights[index] || 0;
    return `<tr>
      <td>${asset.name}</td>
      <td>${asset.category}</td>
      <td>${pct(actual)}</td>
      <td>${pct(asset.minWeight)}</td>
      <td>${pct(asset.maxWeight)}</td>
      <td class="${constraintStatus(actual, asset.minWeight, asset.maxWeight) === "In range" ? "pos" : "warn"}">${constraintStatus(actual, asset.minWeight, asset.maxWeight)}</td>
    </tr>`;
  }).join("");
  const chartLabel = (name) => ({
    "International Developed Equity": "Intl Developed",
    "Emerging Markets Equity": "EM Equity",
    "Income U.S. - U.S. Treasury": "U.S. Treasury",
    "Income U.S. Government Related": "Govt Related",
    "Income U.S. Corporate": "U.S. Corporate",
    "Income U.S. Securitized": "Securitized",
    "Fixed Income International": "Intl Fixed Income",
    "Other Fixed Income": "Other FI",
  }[name] || name);
  const assetColor = (asset, index) => ({
    "U.S. Large Cap": "#005f73",
    "U.S. Mid Cap": "#9b2226",
    "U.S. Small Cap": "#ee9b00",
    "International Developed Equity": "#6a4c93",
    "Emerging Markets Equity": "#2a9d8f",
    "U.S. REITs": "#bc6c25",
    "Commodities": "#7f4f24",
    "Income U.S. - U.S. Treasury": "#1d3557",
    "Income U.S. Government Related": "#457b9d",
    "Income U.S. Corporate": "#2d6a4f",
    "Income U.S. Securitized": "#e76f51",
    "Fixed Income International": "#3a86ff",
    "Other Fixed Income": "#7209b7",
    "Cash": "#6c757d",
  }[asset.name] || [
    "#005f73",
    "#9b2226",
    "#ee9b00",
    "#6a4c93",
    "#2a9d8f",
    "#bc6c25",
    "#7f4f24",
    "#1d3557",
    "#457b9d",
    "#2d6a4f",
    "#e76f51",
    "#3a86ff",
    "#7209b7",
    "#6c757d",
  ][index % 14]);
  const trianglePoints = (x, y, size = 6) => `${x.toFixed(1)},${(y - size).toFixed(1)} ${(x - size).toFixed(1)},${(y + size).toFixed(1)} ${(x + size).toFixed(1)},${(y + size).toFixed(1)}`;

  box.innerHTML = `<div class="frontier-chart-grid">
  <div class="asset-color-legend side-legend">
    <div class="legend-heading">Asset Legend</div>
    ${state.assets.map((asset, index) => `<span><i style="--asset-color:${assetColor(asset, index)}"></i>${asset.name}</span>`).join("")}
  </div>
  <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Efficient frontier chart showing MVO portfolio volatility and expected return">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"></rect>
    <rect x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}" fill="#f6f7f8" stroke="#ccd5dd"></rect>
    ${yTicks.map((tick) => `<line x1="${pad.left}" y1="${yScale(tick)}" x2="${width - pad.right}" y2="${yScale(tick)}" stroke="#dce3e9"></line>
      <text x="${pad.left - 12}" y="${yScale(tick) + 4}" text-anchor="end" class="frontier-axis">${pct(tick)}</text>`).join("")}
    ${xTicks.map((tick) => `<line x1="${xScale(tick)}" y1="${pad.top}" x2="${xScale(tick)}" y2="${height - pad.bottom}" stroke="#e6ebef"></line>
      <text x="${xScale(tick)}" y="${height - 26}" text-anchor="middle" class="frontier-axis">${pct(tick)}</text>`).join("")}
    <rect x="${bandX.toFixed(1)}" y="${pad.top}" width="${bandWidth.toFixed(1)}" height="${plotH}" fill="#00a95a" opacity="0.11"></rect>
    <line x1="${bandX.toFixed(1)}" y1="${pad.top}" x2="${bandX.toFixed(1)}" y2="${height - pad.bottom}" stroke="#00a95a" stroke-width="1.4" stroke-dasharray="5 5"></line>
    <line x1="${(bandX + bandWidth).toFixed(1)}" y1="${pad.top}" x2="${(bandX + bandWidth).toFixed(1)}" y2="${height - pad.bottom}" stroke="#00a95a" stroke-width="1.4" stroke-dasharray="5 5"></line>
    <g transform="translate(${bandLabelX.toFixed(1)}, ${pad.top + 18})">
      <rect x="-88" y="-13" width="176" height="24" rx="3" fill="#ffffff" opacity="0.92" stroke="#00a95a"></rect>
      <text x="0" y="4" text-anchor="middle" class="frontier-axis">Target Vol ${pct(profile.targetVolMin)} - ${pct(profile.targetVolMax)}</text>
    </g>
    ${regionShape}
    ${visibleRegionPoints.map((point) => `<circle cx="${xScale(point.x).toFixed(1)}" cy="${yScale(point.y).toFixed(1)}" r="1.8" fill="#2f80b7" opacity="0.22"></circle>`).join("")}
    ${assetPoints.map((p, index) => {
      const x = xScale(p.stats.volatility);
      const y = yScale(p.stats.expectedReturn);
      return `<polygon points="${trianglePoints(x, y, 6)}" fill="${assetColor(p.asset, index)}" stroke="#101820" stroke-width="1.1"></polygon>`;
    }).join("")}
    <path d="${frontierPath}" fill="none" stroke="#101820" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path>
    <circle cx="${selectedX.toFixed(1)}" cy="${selectedY.toFixed(1)}" r="8" fill="#00a95a" stroke="#101820" stroke-width="2"></circle>
    <g transform="translate(${pad.left}, 14)">
      <line x1="0" y1="0" x2="36" y2="0" stroke="#101820" stroke-width="2.2"></line><text x="44" y="4" class="frontier-axis">Efficient frontier</text>
      <circle cx="178" cy="0" r="6" fill="#00a95a" stroke="#101820" stroke-width="1.5"></circle><text x="190" y="4" class="frontier-axis">Selected portfolio</text>
      <rect x="330" y="-7" width="16" height="14" fill="#8ecae6" opacity="0.45" stroke="#2f80b7"></rect><text x="354" y="4" class="frontier-axis">Allowable region</text>
    </g>
    <text x="${width / 2}" y="${height - 6}" text-anchor="middle" class="frontier-axis">Annualized volatility</text>
    <text x="16" y="${height / 2}" text-anchor="middle" transform="rotate(-90 16 ${height / 2})" class="frontier-axis">Compound return</text>
  </svg>
  </div>
  <div class="chart-region-note">
    <strong>Global Allowable Weight Region</strong>
    <span>Uses live Asset Assumptions plus all Model Constraints to estimate the full risk/return area possible from the allowable weighting ranges. It will usually sit inside the no-shorting frontier because it adds allocation and sub-allocation constraints.</span>
  </div>
  <div class="chart-constraints">
    <div class="constraint-grid">
      <div>
        <div class="constraint-title">Allocation Constraints</div>
        <table class="constraint-table">
          <thead><tr><th>Allocation</th><th>Actual</th><th>Min</th><th>Max</th><th>Status</th></tr></thead>
          <tbody>${categoryRows}</tbody>
        </table>
      </div>
      <div>
        <div class="constraint-title">Sub Allocation Constraints</div>
        <table class="constraint-table">
          <thead><tr><th>Asset</th><th>Category</th><th>Actual</th><th>Min</th><th>Max</th><th>Status</th></tr></thead>
          <tbody>${subRows}</tbody>
        </table>
      </div>
    </div>
  </div>
  <p class="frontier-note">The black curve is the no-shorting efficient frontier from the live Asset Assumptions. The light-blue area is the estimated global allowable weight region after Model Constraints are applied. The green vertical band is the selected portfolio's target-volatility range, and the green dot is the selected constrained MVO portfolio.</p>`;
}

function renderAll() {
  renderMetrics();
  renderSummary();
  renderProfiles();
  renderAssets();
  renderAllocationWeights();
  renderWeights();
  renderMvo();
}

function renderEditableInputs() {
  renderProfiles();
  renderAssets();
}

function setPath(path, value) {
  const parts = path.split(".");
  let target = state;
  for (let i = 0; i < parts.length - 1; i += 1) target = target[parts[i]];
  target[parts.at(-1)] = value;
}

function resetModel() {
  state = clone(baseData);
  ensureVolatilityModel();
  applyVolatilityModel();
  renderEditableInputs();
  runOptimization();
}

function refreshMvo() {
  if (!mvoDirty && frontierResult) {
    renderMvo();
    return;
  }
  document.querySelector("#mvoMetrics").innerHTML = `<div class="metric"><div class="label">Status</div><div class="value">Calculating</div></div>`;
  document.querySelector("#frontierChart").innerHTML = `<p class="frontier-note">Calculating efficient frontier...</p>`;
  document.querySelector("#mvoWeightsTable").innerHTML = `<tbody><tr><td>Calculating weights...</td></tr></tbody>`;
  setTimeout(() => {
    try {
      frontierResult = calculateEfficientFrontier();
      mvoDirty = false;
      renderMvo();
    } catch (error) {
      frontierResult = { error: error.message };
      mvoDirty = false;
      renderMvo();
    }
  }, 25);
}

function mvoIsActive() {
  return document.querySelector("#mvo")?.classList.contains("active");
}

function scheduleMvoRefresh(force = false) {
  mvoDirty = true;
  if (!force && !mvoIsActive()) return;
  window.clearTimeout(mvoTimer);
  mvoTimer = window.setTimeout(runOptimization, 90);
}

function refreshLiveOutputs() {
  applyVolatilityModel();
  results = calculateConstrainedResults();
  mvoDirty = true;
  renderAllocationWeights();
  renderWeights();
  if (mvoIsActive()) refreshMvo();
}

function scheduleLiveUpdate() {
  window.clearTimeout(liveUpdateTimer);
  liveUpdateTimer = window.setTimeout(refreshLiveOutputs, 180);
}

function updateInputState(input) {
  const value = input.dataset.type === "percent" ? num(input.value) / 100 : num(input.value);
  setPath(input.dataset.path, value);
  applyVolatilityModel();
  mvoDirty = true;
}

function commitInputUpdate(input) {
  updateInputState(input);
  runOptimization();
}

document.addEventListener("input", (event) => {
  if (!event.target.matches("input[data-path]")) return;
  updateInputState(event.target);
  scheduleLiveUpdate();
});

document.addEventListener("change", (event) => {
  if (event.target.matches("#mvoProfileSelect")) {
    selectedMvoProfile = event.target.value;
    renderMvo();
    return;
  }
  if (!event.target.matches("input[data-path]")) return;
  commitInputUpdate(event.target);
});

document.addEventListener("click", (event) => {
  const tab = event.target.closest(".tab");
  if (tab) {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".page").forEach((x) => x.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector(`#${tab.dataset.tab}`).classList.add("active");
    if (tab.dataset.tab === "mvo") refreshMvo();
  }

  const dashboardTab = event.target.closest(".dashboard-tab");
  if (dashboardTab) {
    document.querySelectorAll(".dashboard-tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".dashboard-panel").forEach((x) => x.classList.remove("active"));
    dashboardTab.classList.add("active");
    document.querySelector(`#${dashboardTab.dataset.dashboardTab}`).classList.add("active");
  }

  const button = event.target.closest("button");
  if (button?.id === "runModel") {
    scheduleMvoRefresh(true);
  }
  if (button?.id === "resetModel") resetModel();
});

async function init() {
  try {
    baseData = await fetch("./data/model-data.json").then((r) => {
      if (!r.ok) throw new Error(`Could not load model-data.json (${r.status})`);
      return r.json();
    });
    state = clone(baseData);
    ensureVolatilityModel();
    applyVolatilityModel();
    runOptimization();
  } catch (error) {
    const message = `Model data did not load: ${error.message}`;
    document.querySelector("#mvoMetrics").innerHTML = `<div class="metric"><div class="label">Status</div><div class="value warn">No Data</div><div class="status warn">${message}</div></div>`;
    document.querySelector("#frontierChart").innerHTML = `<p class="frontier-note">${message}</p>`;
  }
}

init();
