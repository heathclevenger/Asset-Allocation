const pct = (value) => `${(value * 100).toFixed(2)}%`;
const num = (value) => Number.parseFloat(value || 0);

let baseData;
let state;
let results = {};

const clone = (value) => JSON.parse(JSON.stringify(value));

function buildVolatilityModel(profiles) {
  const anchorProfile = "Moderate";
  const anchor = profiles[anchorProfile];
  const anchorTarget = (anchor.targetVolMin + anchor.targetVolMax) / 2;
  const model = { anchorProfile, anchorTarget, profiles: {} };
  Object.entries(profiles).forEach(([name, profile]) => {
    const midpoint = (profile.targetVolMin + profile.targetVolMax) / 2;
    model.profiles[name] = {
      offsetFromAnchor: midpoint - anchorTarget,
      halfWidth: (profile.targetVolMax - profile.targetVolMin) / 2,
    };
  });
  return model;
}

function ensureVolatilityModel() {
  state.volatilityModel ||= buildVolatilityModel(state.profiles);
}

function applyVolatilityModel() {
  ensureVolatilityModel();
  const model = state.volatilityModel;
  Object.entries(model.profiles).forEach(([name, rule]) => {
    const midpoint = model.anchorTarget + rule.offsetFromAnchor;
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

function normalizeCategoryMixes(assets) {
  const groups = {};
  assets.forEach((asset, index) => {
    groups[asset.category] ||= [];
    groups[asset.category].push({ asset, index });
  });
  const mixes = {};
  Object.entries(groups).forEach(([category, rows]) => {
    if (category === "Cash") {
      mixes[category] = [{ index: rows[0].index, share: 1 }];
      return;
    }
    let mids = rows.map(({ asset }) => (asset.minWeight + asset.maxWeight) / 2);
    const total = mids.reduce((a, b) => a + b, 0) || rows.length;
    if (!mids.some(Boolean)) mids = rows.map(() => 1);
    const denom = mids.reduce((a, b) => a + b, 0);
    mixes[category] = rows.map((row, i) => ({ index: row.index, share: mids[i] / denom }));
  });
  return mixes;
}

function expandWeights(categoryWeights, assets) {
  const weights = Array(assets.length).fill(0);
  const mixes = normalizeCategoryMixes(assets);
  Object.entries(mixes).forEach(([category, mix]) => {
    const total = categoryWeights[category] || 0;
    mix.forEach(({ index, share }) => {
      weights[index] = total * share;
    });
  });
  return weights;
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

function optimizeProfile(profileName, seedOffset = 17, draws = 12000) {
  const profile = state.profiles[profileName];
  const rand = seededRandom(profileName.length * 1009 + seedOffset);
  let best = null;
  let fallback = null;
  const categories = state.categories;

  for (let i = 0; i < draws; i += 1) {
    const categoryWeights = randomCategoryWeights(profile, categories, rand);
    const weights = expandWeights(categoryWeights, state.assets);
    const stats = portfolioStats(weights, state.assets, state.correlation);
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

function runOptimization() {
  applyVolatilityModel();
  results = {};
  Object.keys(state.profiles).forEach((profile) => {
    const mvo = optimizeProfile(profile, 17, 12000);
    const monteCarlo = optimizeProfile(profile, 7919, 12000);
    const weights = mvo.weights.map((weight, index) => (weight + monteCarlo.weights[index]) / 2);
    const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
    const normalizedWeights = weights.map((weight) => weight / total);
    const categoryWeights = {};
    state.categories.forEach((category) => {
      categoryWeights[category] = normalizedWeights.reduce((sum, weight, index) => (
        state.assets[index].category === category ? sum + weight : sum
      ), 0);
    });
    results[profile] = {
      profileName: profile,
      categoryWeights,
      weights: normalizedWeights,
      stats: portfolioStats(normalizedWeights, state.assets, state.correlation),
      methods: { mvo, monteCarlo },
    };
  });
  renderAll();
}

function statusFor(profileName, vol) {
  const profile = state.profiles[profileName];
  if (vol < profile.targetVolMin - 0.0001) return "Below target";
  if (vol > profile.targetVolMax + 0.0001) return "Above target";
  return "In target";
}

function renderMetrics() {
  const box = document.querySelector("#metrics");
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
  control.innerHTML = `<div>
    <label for="moderateVolTarget">Moderate Volatility Target</label>
    ${editableCell(model.anchorTarget, "volatilityModel.anchorTarget")}
  </div>
  <p>All portfolio target ranges are derived from this Moderate target using the current relative adjustments and band widths.</p>`;

  const table = document.querySelector("#profilesTable");
  table.innerHTML = `<thead><tr><th>Portfolio</th><th>Target Vol Min</th><th>Target Vol Max</th><th>Adjustment From Moderate</th>
    ${state.categories.flatMap((c) => [`<th>${c} Min</th>`, `<th>${c} Max</th>`]).join("")}
  </tr></thead><tbody>${Object.entries(state.profiles).map(([name, profile]) => `<tr>
    <td>${name}</td>
    <td>${pct(profile.targetVolMin)}</td>
    <td>${pct(profile.targetVolMax)}</td>
    <td>${pct(state.volatilityModel.profiles[name].offsetFromAnchor)}</td>
    ${state.categories.map((c) => `<td>${editableCell(profile.categoryBounds[c].min, `profiles.${name}.categoryBounds.${c}.min`)}</td><td>${editableCell(profile.categoryBounds[c].max, `profiles.${name}.categoryBounds.${c}.max`)}</td>`).join("")}
  </tr>`).join("")}</tbody>`;
}

function renderAssets() {
  const table = document.querySelector("#assetsTable");
  table.innerHTML = `<thead><tr><th>Asset</th><th>Category</th><th>Source</th><th>Return</th><th>Volatility</th><th>Min</th><th>Max</th><th>Pro Rata Mix</th></tr></thead>
  <tbody>${state.assets.map((asset, i) => {
    const mix = normalizeCategoryMixes(state.assets)[asset.category].find((m) => m.index === i)?.share || 0;
    return `<tr>
      <td class="text">${asset.name}</td><td>${asset.category}</td><td class="text">${asset.sourceNames.join(", ")}</td>
      <td>${editableCell(asset.return, `assets.${i}.return`)}</td>
      <td>${editableCell(asset.volatility, `assets.${i}.volatility`)}</td>
      <td>${editableCell(asset.minWeight, `assets.${i}.minWeight`)}</td>
      <td>${editableCell(asset.maxWeight, `assets.${i}.maxWeight`)}</td>
      <td>${pct(mix)}</td>
    </tr>`;
  }).join("")}</tbody>`;
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

function renderAll() {
  renderMetrics();
  renderSummary();
  renderProfiles();
  renderAssets();
  renderAllocationWeights();
  renderWeights();
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
  runOptimization();
}

document.addEventListener("input", (event) => {
  if (!event.target.matches("input[data-path]")) return;
  const input = event.target;
  const value = input.dataset.type === "percent" ? num(input.value) / 100 : num(input.value);
  setPath(input.dataset.path, value);
  if (input.dataset.path === "volatilityModel.anchorTarget") applyVolatilityModel();
});

document.addEventListener("change", (event) => {
  if (!event.target.matches("input[data-path]")) return;
  runOptimization();
});

document.addEventListener("click", (event) => {
  const tab = event.target.closest(".tab");
  if (tab) {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".page").forEach((x) => x.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector(`#${tab.dataset.tab}`).classList.add("active");
  }

  const dashboardTab = event.target.closest(".dashboard-tab");
  if (dashboardTab) {
    document.querySelectorAll(".dashboard-tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".dashboard-panel").forEach((x) => x.classList.remove("active"));
    dashboardTab.classList.add("active");
    document.querySelector(`#${dashboardTab.dataset.dashboardTab}`).classList.add("active");
  }

  if (event.target.id === "runModel") runOptimization();
  if (event.target.id === "resetModel") resetModel();
  if (event.target.dataset.reset) {
    const section = event.target.dataset.reset;
    if (section === "assets") state.assets = clone(baseData.assets);
    if (section === "profiles") {
      state.profiles = clone(baseData.profiles);
      state.volatilityModel = baseData.volatilityModel ? clone(baseData.volatilityModel) : buildVolatilityModel(state.profiles);
    }
    runOptimization();
  }
  if (event.target.id === "downloadJson") {
    const blob = new Blob([JSON.stringify({ state, results }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "asset-allocation-model.json";
    a.click();
    URL.revokeObjectURL(url);
  }
});

async function init() {
  baseData = await fetch("./data/model-data.json").then((r) => r.json());
  state = clone(baseData);
  ensureVolatilityModel();
  runOptimization();
}

init();
