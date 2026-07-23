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
let selectedAllocationPreset = "CORE";
let selectedSubAllocationPreset = "CORE";
let selectedAssumptionSet = "CORE";

const clone = (value) => JSON.parse(JSON.stringify(value));
const escapeHtml = (value) => String(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");
const defaultVolatilityPercentiles = {
  "Conservative": 5,
  "Balanced": 35,
  "Moderate": 55,
  "Growth": 75,
  "Aggressive Growth": 95,
};

const categoryColor = (category) => ({
  "Equity": "#007481",
  "Fixed Income": "#c99700",
  "Alternatives": "#8f3f71",
  "Cash": "#6c757d",
}[category] || "#6c757d");

const assetColor = (asset, index) => ({
  "U.S. Large Cap": "#005f73",
  "U.S. Value": "#d00000",
  "U.S. Growth": "#ffba08",
  "U.S. Mid Cap": "#9b2226",
  "U.S. Small Cap": "#ee9b00",
  "International Developed Equity": "#6a4c93",
  "Emerging Markets Equity": "#2a9d8f",
  "U.S. Income": "#4361ee",
  "U.S. Quality": "#2f6f4e",
  "U.S. REITs": "#bc6c25",
  "Commodities": "#7f4f24",
  "US Short Treasuries": "#1d3557",
  "US Intermediate Treasuries": "#457b9d",
  "US Long Treasuries": "#3a86ff",
  "Investment Grade Corporate": "#2d6a4f",
  "High Yield": "#e76f51",
  "International Fixed Income (H)": "#7209b7",
  "Cash": "#6c757d",
}[asset.name] || [
  "#005f73",
  "#d00000",
  "#ffba08",
  "#9b2226",
  "#ee9b00",
  "#6a4c93",
  "#2a9d8f",
  "#4361ee",
  "#2f6f4e",
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

function buildVolatilityModel(profiles) {
  const halfWidth = Math.max(...Object.values(profiles).map((profile) => (
    (profile.targetVolMax - profile.targetVolMin) / 2
  )));
  const model = { mode: "feasiblePercentile", halfWidth, profiles: {} };
  Object.entries(profiles).forEach(([name, profile]) => {
    model.profiles[name] = {
      percentile: defaultVolatilityPercentiles[name] ?? 50,
      halfWidth,
    };
  });
  return model;
}

function ensureVolatilityModel() {
  state.volatilityModel ||= buildVolatilityModel(state.profiles);
  state.volatilityModel.mode = "feasiblePercentile";
  const existingHalfWidths = Object.values(state.volatilityModel.profiles || {})
    .map((rule) => rule.halfWidth)
    .filter((value) => Number.isFinite(value));
  state.volatilityModel.halfWidth ??= existingHalfWidths.length
    ? Math.max(...existingHalfWidths)
    : Math.max(...Object.values(state.profiles).map((profile) => (profile.targetVolMax - profile.targetVolMin) / 2));
  Object.entries(state.profiles).forEach(([name, profile]) => {
    state.volatilityModel.profiles ||= {};
    state.volatilityModel.profiles[name] ||= {};
    state.volatilityModel.profiles[name].percentile ??= defaultVolatilityPercentiles[name] ?? 50;
    state.volatilityModel.profiles[name].halfWidth = state.volatilityModel.halfWidth;
  });
}

function applyAssumptionSet(name) {
  if (!state.assumptionSets?.[name]) return;
  selectedAssumptionSet = name;
  const assumptions = state.assumptionSets[name];
  state.assets.forEach((asset, index) => {
    const source = assumptions[index];
    asset.return = source.return;
    asset.volatility = source.volatility;
    asset.sourceMapping = source.sourceMapping;
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

function seedFromString(value, base = 0) {
  let hash = base >>> 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619) >>> 0;
  }
  return hash || 1;
}

function constraintSignature(profile) {
  const categoryPart = state.categories.map((category) => {
    const bounds = profile.categoryBounds[category] || { min: 0, max: 1 };
    return `${category}:${bounds.min.toFixed(5)}-${bounds.max.toFixed(5)}`;
  }).join("|");
  const assetPart = state.assets.map((asset) => (
    `${asset.name}:${asset.category}:${asset.minWeight.toFixed(5)}-${asset.maxWeight.toFixed(5)}`
  )).join("|");
  return `${categoryPart}::${assetPart}`;
}

function sharedConstraintProfile(profileName) {
  const baseProfile = state.profiles[profileName] || Object.values(state.profiles)[0];
  const categoryBounds = {};
  state.categories.forEach((category) => {
    const rows = Object.values(state.profiles)
      .map((profile) => profile.categoryBounds?.[category])
      .filter(Boolean);
    categoryBounds[category] = {
      min: rows.length ? Math.min(...rows.map((bounds) => bounds.min)) : 0,
      max: rows.length ? Math.max(...rows.map((bounds) => bounds.max)) : 1,
    };
  });
  return {
    ...baseProfile,
    categoryBounds,
  };
}

function feasibleVolatilities(profileName) {
  const profile = sharedConstraintProfile(profileName);
  const vols = [];
  const rand = seededRandom(seedFromString(constraintSignature(profile), 7051));
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
  if (!categoryWeights) return null;
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

function upperFrontierEnvelope(portfolios, bucketCount = 80) {
  const rows = portfolios
    .filter((portfolio) => Number.isFinite(portfolio.stats.volatility) && Number.isFinite(portfolio.stats.expectedReturn))
    .sort((a, b) => a.stats.volatility - b.stats.volatility);
  if (rows.length <= 2) return rows;

  const minVol = rows[0].stats.volatility;
  const maxVol = rows.at(-1).stats.volatility;
  const buckets = Array.from({ length: bucketCount }, () => null);
  rows.forEach((portfolio) => {
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor(((portfolio.stats.volatility - minVol) / Math.max(maxVol - minVol, 1e-8)) * bucketCount)));
    const current = buckets[index];
    if (!current || portfolio.stats.expectedReturn > current.stats.expectedReturn) buckets[index] = portfolio;
  });

  const bestByBucket = buckets.filter(Boolean).sort((a, b) => a.stats.volatility - b.stats.volatility);
  const frontier = [];
  bestByBucket.forEach((portfolio) => {
    if (!frontier.length || portfolio.stats.expectedReturn >= frontier.at(-1).stats.expectedReturn - 0.00005) {
      frontier.push(portfolio);
    }
  });
  return frontier.length >= 2 ? frontier : rows;
}

function concaveUpperFrontier(portfolios) {
  const rows = upperFrontierEnvelope(portfolios, 110)
    .sort((a, b) => a.stats.volatility - b.stats.volatility)
    .filter((portfolio, index, all) => index === 0 || portfolio.stats.volatility - all[index - 1].stats.volatility > 0.00008);
  const increasing = [];
  rows.forEach((portfolio) => {
    if (!increasing.length || portfolio.stats.expectedReturn >= increasing.at(-1).stats.expectedReturn - 0.00002) {
      increasing.push(portfolio);
    }
  });

  const hull = [];
  const slope = (a, b) => (
    (b.stats.expectedReturn - a.stats.expectedReturn) / Math.max(b.stats.volatility - a.stats.volatility, 1e-8)
  );
  increasing.forEach((portfolio) => {
    while (hull.length >= 2) {
      const previousSlope = slope(hull.at(-2), hull.at(-1));
      const nextSlope = slope(hull.at(-1), portfolio);
      if (nextSlope <= previousSlope + 0.03) break;
      hull.pop();
    }
    hull.push(portfolio);
  });
  return hull.length >= 4 ? hull : increasing;
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
  const minVarianceGradient = (weights) => {
    const covW = matVec(cov, weights);
    return covW.map((value) => -2 * value);
  };
  let warmStart = optimizeProjected(equal, minVarianceGradient, 180, 0.35);
  frontier.push({ weights: warmStart, stats: portfolioStats(warmStart, assets, state.correlation) });

  for (let i = 0; i < 140; i += 1) {
    const riskPenalty = Math.pow(10, 4.4 - (i / 139) * 7.0);
    const gradientFn = (weights) => {
      const covW = matVec(cov, weights);
      return returns.map((value, index) => value - 2 * riskPenalty * covW[index]);
    };
    const primary = optimizeProjected(warmStart, gradientFn, 85, 0.16);
    const secondary = optimizeProjected(i % 4 === 0 ? starts[(i / 4) % starts.length] : best.weights, gradientFn, 65, 0.12);
    warmStart = primary;
    frontier.push({ weights: primary, stats: portfolioStats(primary, assets, state.correlation) });
    if (i % 3 === 0) frontier.push({ weights: secondary, stats: portfolioStats(secondary, assets, state.correlation) });
  }

  const assetPoints = assets.map((asset, index) => {
    const weights = Array(count).fill(0);
    weights[index] = 1;
    return { asset, weights, stats: portfolioStats(weights, assets, state.correlation) };
  });

  const cleanFrontier = concaveUpperFrontier([...frontier, ...assetPoints, best]);

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

function categoryWeightsFromWeights(weights) {
  const categoryWeights = {};
  state.categories.forEach((category) => {
    categoryWeights[category] = weights.reduce((sum, weight, index) => (
      state.assets[index].category === category ? sum + weight : sum
    ), 0);
  });
  return categoryWeights;
}

function isFullyUnconstrainedPreset() {
  return selectedAllocationPreset === "Unconstrained" && selectedSubAllocationPreset === "Unconstrained";
}

function frontierAllowableRegion(frontier, selected) {
  const sorted = frontier
    .filter((point) => point?.stats && Number.isFinite(point.stats.volatility) && Number.isFinite(point.stats.expectedReturn))
    .sort((a, b) => a.stats.volatility - b.stats.volatility);
  if (sorted.length < 2) {
    return {
      points: [{ x: selected.stats.volatility, y: selected.stats.expectedReturn, stats: selected.stats, weights: selected.weights }],
      hull: [],
      mode: "efficient frontier allowable region",
    };
  }

  const returns = sorted.map((point) => point.stats.expectedReturn);
  const returnRange = Math.max(...returns) - Math.min(...returns);
  const ribbon = Math.max(returnRange * 0.018, 0.00045);
  const points = sorted.map((point) => ({
    x: point.stats.volatility,
    y: point.stats.expectedReturn,
    stats: point.stats,
    weights: point.weights,
  }));
  const upper = sorted.map((point) => ({
    x: point.stats.volatility,
    y: point.stats.expectedReturn + ribbon,
    stats: {
      volatility: point.stats.volatility,
      expectedReturn: point.stats.expectedReturn + ribbon,
    },
  }));
  const lower = [...sorted].reverse().map((point) => ({
    x: point.stats.volatility,
    y: Math.max(0, point.stats.expectedReturn - ribbon),
    stats: {
      volatility: point.stats.volatility,
      expectedReturn: Math.max(0, point.stats.expectedReturn - ribbon),
    },
  }));

  return {
    points,
    hull: upper.concat(lower),
    mode: "efficient frontier allowable region",
  };
}

function envelopeAllowableRegion(points, bucketCount = 56) {
  const sorted = points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .sort((a, b) => a.x - b.x);
  if (sorted.length < 8) return convexHull(sorted);

  const minVol = sorted[0].x;
  const maxVol = sorted.at(-1).x;
  const buckets = Array.from({ length: bucketCount }, () => ({
    count: 0,
    xSum: 0,
    min: null,
    max: null,
  }));

  sorted.forEach((point) => {
    const bucketIndex = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor(((point.x - minVol) / Math.max(maxVol - minVol, 1e-8)) * bucketCount))
    );
    const bucket = buckets[bucketIndex];
    bucket.count += 1;
    bucket.xSum += point.x;
    if (!bucket.min || point.y < bucket.min.y) bucket.min = point;
    if (!bucket.max || point.y > bucket.max.y) bucket.max = point;
  });

  const envelope = buckets
    .filter((bucket) => bucket.count > 0 && bucket.min && bucket.max)
    .map((bucket) => ({
      x: bucket.xSum / bucket.count,
      min: bucket.min,
      max: bucket.max,
    }));
  if (envelope.length < 3) return convexHull(sorted);

  const upper = envelope.map((bucket) => ({
    ...bucket.max,
    x: bucket.x,
    stats: {
      volatility: bucket.x,
      expectedReturn: bucket.max.y,
    },
  }));
  const lower = [...envelope].reverse().map((bucket) => ({
    ...bucket.min,
    x: bucket.x,
    stats: {
      volatility: bucket.x,
      expectedReturn: bucket.min.y,
    },
  }));

  return upper.concat(lower);
}

function globalFeasibleRegion(selected, frontier = []) {
  if (isFullyUnconstrainedPreset()) return frontierAllowableRegion(frontier, selected);

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

  const profile = sharedConstraintProfile(selected.profileName || selectedMvoProfile);
  if (profile) {
    const rand = seededRandom(seedFromString(constraintSignature(profile), 4409));
    for (let i = 0; i < 12500; i += 1) {
      try {
        addPoint(randomAssetWeights(profile, rand));
      } catch (_error) {
        break;
      }
    }
  }

  points.push({ x: selected.stats.volatility, y: selected.stats.expectedReturn, stats: selected.stats, weights: selected.weights });
  return {
    points,
    hull: convexHull(points),
    mode: "global allowable weighting region",
  };
}

function randomCategoryWeights(profile, categories, rand) {
  const groups = categoryGroups(state.assets);
  const effectiveBounds = {};
  for (const category of categories) {
    const indexes = groups[category] || [];
    const assetMin = indexes.reduce((sum, index) => sum + state.assets[index].minWeight, 0);
    const assetMax = indexes.reduce((sum, index) => sum + state.assets[index].maxWeight, 0);
    effectiveBounds[category] = {
      min: Math.max(profile.categoryBounds[category].min, assetMin),
      max: Math.min(profile.categoryBounds[category].max, assetMax),
    };
    if (effectiveBounds[category].min > effectiveBounds[category].max + 1e-10) return null;
  }

  const fixed = {};
  const variable = [];
  let remaining = 1;
  for (const category of categories) {
    const bounds = effectiveBounds[category];
    if (Math.abs(bounds.max - bounds.min) < 1e-10) {
      fixed[category] = bounds.min;
      remaining -= bounds.min;
    } else {
      variable.push(category);
    }
  }
  const variableMin = variable.reduce((sum, category) => sum + effectiveBounds[category].min, 0);
  const variableMax = variable.reduce((sum, category) => sum + effectiveBounds[category].max, 0);
  if (remaining < variableMin - 1e-10 || remaining > variableMax + 1e-10) return null;

  const out = { ...fixed };
  for (let i = 0; i < variable.length; i += 1) {
    const category = variable[i];
    if (i === variable.length - 1) {
      out[category] = remaining;
      break;
    }
    const next = variable.slice(i + 1);
    const minLeft = next.reduce((sum, c) => sum + effectiveBounds[c].min, 0);
    const maxLeft = next.reduce((sum, c) => sum + effectiveBounds[c].max, 0);
    const lo = Math.max(effectiveBounds[category].min, remaining - maxLeft);
    const hi = Math.min(effectiveBounds[category].max, remaining - minLeft);
    if (lo > hi + 1e-10) return null;
    out[category] = lo + rand() * Math.max(hi - lo, 0);
    remaining -= out[category];
  }
  if (Math.abs(Object.values(out).reduce((sum, value) => sum + value, 0) - 1) > 0.0001) return null;
  return out;
}

function optimizeProfile(profileName, seedOffset = 17, draws = 900) {
  const profile = sharedConstraintProfile(profileName);
  const rand = seededRandom(seedFromString(constraintSignature(profile), seedOffset));
  let best = null;
  let fallback = null;
  const categories = state.categories;

  for (let i = 0; i < draws; i += 1) {
    const weights = randomAssetWeights(profile, rand);
    if (!weights) continue;
    const stats = portfolioStats(weights, state.assets, state.correlation);
    const categoryWeights = categoryWeightsFromWeights(weights);
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
  if (!best && !fallback) {
    throw new Error(`No feasible portfolios found for ${profileName}. Check the allocation and sub-allocation constraint presets.`);
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
    const categoryWeights = categoryWeightsFromWeights(normalizedWeights);
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
  <div class="percentile-shift-field">
    <label for="percentileShiftInput">Shift All Percentiles</label>
    <div class="unit-input">
      <input id="percentileShiftInput" type="number" step="1" placeholder="0" />
      <span>%</span>
    </div>
  </div>
  <p>These percentiles set each portfolio's target volatility range from the portfolios that are feasible under the current allocation and sub-allocation constraints. Lower percentiles create lower-risk targets; higher percentiles create higher-risk targets. Starting defaults are 5%, 35%, 55%, 75%, and 95%.</p>`;

  const allocationPreset = document.querySelector("#allocationPresetSelect");
  if (allocationPreset) allocationPreset.value = selectedAllocationPreset;
  const subAllocationPreset = document.querySelector("#subAllocationPresetSelect");
  if (subAllocationPreset) subAllocationPreset.value = selectedSubAllocationPreset;

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

function assetSourceDisplay(asset) {
  const mapping = asset.sourceMapping || "";
  const usesAverage = /average/i.test(mapping);
  if (usesAverage) return mapping;
  if ((asset.sourceNames || []).length > 1) return asset.sourceNames.join(", ");
  return "";
}

function renderAssets() {
  const select = document.querySelector("#assumptionSetSelect");
  if (select && state.assumptionSets) {
    const names = Object.keys(state.assumptionSets);
    if (!names.includes(selectedAssumptionSet)) selectedAssumptionSet = names[0];
    select.innerHTML = names.map((name) => `<option value="${name}" ${name === selectedAssumptionSet ? "selected" : ""}>${name}</option>`).join("");
    select.value = selectedAssumptionSet;
  }

  const table = document.querySelector("#assetsTable");
  table.innerHTML = `<thead><tr><th>Asset</th><th>Category</th><th>Source</th><th>Return</th><th>Volatility</th></tr></thead>
  <tbody>${state.assets.map((asset, i) => `<tr>
      <td class="text">${asset.name}</td><td>${asset.category}</td><td class="text">${assetSourceDisplay(asset)}</td>
      <td>${editableCell(asset.return, `assets.${i}.return`)}</td>
      <td>${editableCell(asset.volatility, `assets.${i}.volatility`)}</td>
    </tr>`).join("")}</tbody>`;
}

function renderAllocationWeights() {
  const table = document.querySelector("#allocationWeightsTable");
  table.innerHTML = `<thead><tr><th>Allocation</th>${Object.keys(results).map((p) => `<th>${p}</th>`).join("")}</tr></thead>
  <tbody>${state.categories.map((category) => `<tr><td>${category}</td>${Object.values(results).map((result) => `<td>${pct(result.categoryWeights[category] || 0)}</td>`).join("")}</tr>`).join("")}</tbody>`;

  const charts = document.querySelector("#allocationPieCharts");
  if (charts) {
    charts.innerHTML = Object.entries(results).map(([profile, result]) => renderPieCard(
      profile,
      state.categories.map((category) => ({
        label: category,
        value: result.categoryWeights[category] || 0,
        color: categoryColor(category),
      }))
    )).join("");
  }
}

function renderWeights() {
  const table = document.querySelector("#weightsTable");
  table.innerHTML = `<thead><tr><th>Asset</th>${Object.keys(results).map((p) => `<th>${p}</th>`).join("")}</tr></thead>
  <tbody>${state.assets.map((asset, i) => `<tr><td>${asset.name}</td>${Object.values(results).map((result) => `<td>${pct(result.weights[i])}</td>`).join("")}</tr>`).join("")}</tbody>`;

  const charts = document.querySelector("#sleevePieCharts");
  if (charts) {
    charts.innerHTML = Object.entries(results).map(([profile, result]) => renderPieCard(
      profile,
      state.assets.map((asset, index) => ({
        label: asset.name,
        value: result.weights[index] || 0,
        color: assetColor(asset, index),
      })),
      { variant: "sleeve" }
    )).join("");
  }
}

function pieSlicePath(cx, cy, radius, startAngle, endAngle) {
  const start = {
    x: cx + radius * Math.cos(startAngle),
    y: cy + radius * Math.sin(startAngle),
  };
  const end = {
    x: cx + radius * Math.cos(endAngle),
    y: cy + radius * Math.sin(endAngle),
  };
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${start.x.toFixed(3)} ${start.y.toFixed(3)} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x.toFixed(3)} ${end.y.toFixed(3)} Z`;
}

function pieSliceMarkup(item, total, startAngle, endAngle) {
  const isFull = item.value / total > 0.999;
  const shape = isFull
    ? `<circle cx="62" cy="62" r="48" fill="${item.color}"></circle>`
    : `<path d="${pieSlicePath(62, 62, 48, startAngle, endAngle)}" fill="${item.color}"></path>`;
  const midAngle = isFull ? -Math.PI / 2 : (startAngle + endAngle) / 2;
  const anchorX = 62 + 34 * Math.cos(midAngle);
  const anchorY = 62 + 34 * Math.sin(midAngle);
  const tooltipW = 112;
  const tooltipH = 34;
  const tooltipX = Math.max(2, Math.min(124 - tooltipW - 2, anchorX - tooltipW / 2));
  const tooltipY = Math.max(2, Math.min(124 - tooltipH - 2, anchorY < 62 ? anchorY + 10 : anchorY - tooltipH - 10));
  const label = escapeHtml(item.label);
  const shortLabel = label.length > 28 ? `${label.slice(0, 25)}...` : label;
  return `<g class="pie-slice" tabindex="0" role="button" aria-label="${label}: ${pct(item.value)}" data-tooltip-title="${label}" data-tooltip-body="${pct(item.value)}">
    ${shape}
    <g class="pie-tooltip" transform="translate(${tooltipX.toFixed(1)}, ${tooltipY.toFixed(1)})">
      <rect x="0" y="0" width="${tooltipW}" height="${tooltipH}" rx="3"></rect>
      <text x="7" y="14">${shortLabel}</text>
      <text x="7" y="27">${pct(item.value)}</text>
    </g>
  </g>`;
}

function renderPieCard(title, items, options = {}) {
  const visible = items.filter((item) => item.value > 0.0005);
  const total = visible.reduce((sum, item) => sum + item.value, 0);
  if (!visible.length || total <= 0) {
    return `<div class="pie-card"><div class="pie-title">${title}</div><div class="pie-empty">No allocation</div></div>`;
  }
  let angle = -Math.PI / 2;
  const slices = visible.map((item) => {
    const nextAngle = angle + (item.value / total) * Math.PI * 2;
    const path = pieSliceMarkup(item, total, angle, nextAngle);
    angle = nextAngle;
    return path;
  }).join("");
  return `<div class="pie-card">
    <div class="pie-title">${title}</div>
    <div class="pie-content">
      <svg viewBox="0 0 124 124" role="img" aria-label="${title} allocation pie chart">
        ${slices}
        <circle cx="62" cy="62" r="48" fill="none" stroke="#ffffff" stroke-width="1.5"></circle>
      </svg>
      <div class="pie-legend">
        ${options.variant === "sleeve"
          ? visible
            .sort((a, b) => b.value - a.value)
            .map((item) => `<div class="sleeve-row">
              <div class="sleeve-row-label"><i style="--pie-color:${item.color}"></i><span>${item.label}</span><strong>${pct(item.value)}</strong></div>
              <div class="sleeve-bar"><span style="--pie-color:${item.color}; width:${Math.max(item.value * 100, 1).toFixed(2)}%"></span></div>
            </div>`).join("")
          : visible.map((item) => `<span><i style="--pie-color:${item.color}"></i>${item.label} <strong>${pct(item.value)}</strong></span>`).join("")}
      </div>
    </div>
  </div>`;
}

function renderAllocationSummaryCard(profileName, result, profile) {
  const percentile = state.volatilityModel?.profiles?.[profileName]?.percentile ?? "";
  const items = state.categories
    .map((category) => ({
      label: category,
      value: result.categoryWeights[category] || 0,
      color: categoryColor(category),
    }))
    .filter((item) => item.value > 0.0005);
  const total = items.reduce((sum, item) => sum + item.value, 0) || 1;
  let angle = -Math.PI / 2;
  const slices = items.map((item) => {
    const nextAngle = angle + (item.value / total) * Math.PI * 2;
    const path = pieSliceMarkup(item, total, angle, nextAngle);
    angle = nextAngle;
    return path;
  }).join("");

  return `<div class="pie-card allocation-summary-card">
    <div class="pie-title">Allocation Weights</div>
    <div class="allocation-summary-layout">
      <div class="allocation-context">
        <div class="allocation-context-box">
          <span>Portfolio</span>
          <strong class="allocation-profile">${profileName}</strong>
        </div>
        <div class="allocation-context-box">
          <span>Volatility Percentile</span>
          <strong>${Number(percentile).toFixed(0)}th</strong>
          <span class="allocation-target-label">Target Volatility</span>
          <strong>${pct(profile.targetVolMin)} - ${pct(profile.targetVolMax)}</strong>
        </div>
      </div>
      <div class="allocation-pie-block">
        <svg viewBox="0 0 124 124" role="img" aria-label="${profileName} allocation pie chart">
          ${slices}
          <circle cx="62" cy="62" r="48" fill="none" stroke="#ffffff" stroke-width="1.5"></circle>
        </svg>
        <div class="allocation-summary-list">
          ${items.map((item) => `<div style="--pie-color:${item.color}">
            <span><i style="--pie-color:${item.color}"></i>${item.label}</span>
            <strong>${pct(item.value)}</strong>
          </div>`).join("")}
        </div>
      </div>
    </div>
  </div>`;
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

function selectedMvoDisplayResult(profileName, baseResult, frontier) {
  if (!isFullyUnconstrainedPreset()) return baseResult;
  const profile = state.profiles[profileName];
  const rows = frontier
    .filter((point) => point?.weights && point?.stats)
    .sort((a, b) => a.stats.volatility - b.stats.volatility);
  if (!rows.length) return baseResult;

  const candidates = [...rows];
  for (let i = 0; i < rows.length - 1; i += 1) {
    const left = rows[i];
    const right = rows[i + 1];
    const lo = Math.min(left.stats.volatility, right.stats.volatility);
    const hi = Math.max(left.stats.volatility, right.stats.volatility);
    if (hi < profile.targetVolMin || lo > profile.targetVolMax) continue;
    for (let step = 1; step < 12; step += 1) {
      const mix = step / 12;
      const weights = left.weights.map((weight, index) => weight * (1 - mix) + right.weights[index] * mix);
      const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
      const normalized = weights.map((weight) => weight / total);
      candidates.push({
        weights: normalized,
        stats: portfolioStats(normalized, state.assets, state.correlation),
      });
    }
  }

  const inTarget = candidates.filter((point) => (
    point.stats.volatility >= profile.targetVolMin - 1e-8
    && point.stats.volatility <= profile.targetVolMax + 1e-8
  ));
  const targetMid = (profile.targetVolMin + profile.targetVolMax) / 2;
  const chosen = (inTarget.length ? inTarget : candidates).reduce((best, point) => {
    if (!best) return point;
    if (inTarget.length) return point.stats.expectedReturn > best.stats.expectedReturn ? point : best;
    const bestGap = Math.abs(best.stats.volatility - targetMid);
    const pointGap = Math.abs(point.stats.volatility - targetMid);
    if (pointGap < bestGap - 1e-8) return point;
    if (Math.abs(pointGap - bestGap) <= 1e-8 && point.stats.expectedReturn > best.stats.expectedReturn) return point;
    return best;
  }, null);

  return {
    ...baseResult,
    profileName,
    weights: chosen.weights,
    categoryWeights: categoryWeightsFromWeights(chosen.weights),
    stats: chosen.stats,
  };
}

function renderMvo() {
  renderMvoControls();
  if (!frontierResult) return;
  if (frontierResult.error) {
    document.querySelector("#mvoMetrics").innerHTML = `<div class="metric"><div class="label">Status</div><div class="value warn">Error</div><div class="status warn">${frontierResult.error}</div></div>`;
    document.querySelector("#frontierChart").innerHTML = `<p class="frontier-note">The MVO chart could not run. Check that Asset Assumptions have valid return and volatility numbers.</p>`;
    document.querySelector("#mvoWeightCharts").innerHTML = "";
    document.querySelector("#mvoConstraints").innerHTML = "";
    return;
  }
  const baseSelected = results[selectedMvoProfile];
  if (!baseSelected) return;
  const profile = state.profiles[selectedMvoProfile];
  const selected = selectedMvoDisplayResult(selectedMvoProfile, baseSelected, frontierResult.frontier);
  const metrics = document.querySelector("#mvoMetrics");
  const status = statusFor(selectedMvoProfile, selected.stats.volatility);
  metrics.innerHTML = [
    ["Portfolio", selectedMvoProfile],
    ["Expected Return", pct(selected.stats.expectedReturn)],
    ["Volatility", pct(selected.stats.volatility)],
    ["Target Volatility", `${pct(profile.targetVolMin)} - ${pct(profile.targetVolMax)}`],
    ["Status", status],
  ].map(([label, value]) => `<div class="metric"><div class="label">${label}</div><div class="value">${value}</div></div>`).join("");

  const charts = document.querySelector("#mvoWeightCharts");
  charts.innerHTML = [
    renderAllocationSummaryCard(selectedMvoProfile, selected, profile),
    renderPieCard(
      "Sub-Sleeve Weights",
      state.assets.map((asset, index) => ({
        label: asset.name,
        value: selected.weights[index] || 0,
        color: assetColor(asset, index),
      })),
      { variant: "sleeve" }
    ),
  ].join("");

  renderFrontierChart(selected, frontierResult.frontier, frontierResult.assetPoints, profile);
}

function renderFrontierChart(selected, frontier, assetPoints, profile) {
  const box = document.querySelector("#frontierChart");
  const region = globalFeasibleRegion(selected, frontier);
  const benchmarkPoints = (state.benchmarks || []).map((benchmark) => ({
    benchmark,
    stats: {
      expectedReturn: benchmark.return,
      volatility: benchmark.volatility,
    },
  }));
  const all = [...frontier, ...assetPoints, ...benchmarkPoints, selected, ...region.points.map((point) => ({ stats: point.stats })), ...region.hull.map((point) => ({ stats: point.stats }))];
  const regionDotStep = Math.max(1, Math.ceil(region.points.length / 950));
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
  const smoothPath = (points) => {
    if (points.length < 2) return "";
    const coords = points.map((point) => ({
      x: xScale(point.stats.volatility),
      y: yScale(point.stats.expectedReturn),
    }));
    if (coords.length === 2) return `M ${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)} L ${coords[1].x.toFixed(1)} ${coords[1].y.toFixed(1)}`;
    let path = `M ${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)}`;
    for (let i = 0; i < coords.length - 1; i += 1) {
      const p0 = coords[Math.max(0, i - 1)];
      const p1 = coords[i];
      const p2 = coords[i + 1];
      const p3 = coords[Math.min(coords.length - 1, i + 2)];
      const cp1 = {
        x: p1.x + (p2.x - p0.x) / 6,
        y: p1.y + (p2.y - p0.y) / 6,
      };
      const cp2 = {
        x: p2.x - (p3.x - p1.x) / 6,
        y: p2.y - (p3.y - p1.y) / 6,
      };
      path += ` C ${cp1.x.toFixed(1)} ${cp1.y.toFixed(1)}, ${cp2.x.toFixed(1)} ${cp2.y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    }
    return path;
  };
  const frontierPath = smoothPath(frontier);
  const regionPolygon = region.hull.map((point) => `${xScale(point.x).toFixed(1)},${yScale(point.y).toFixed(1)}`).join(" ");
  const xTicks = Array.from({ length: 6 }, (_, i) => xMin + ((xMax - xMin) * i) / 5);
  const yTicks = Array.from({ length: 6 }, (_, i) => yMin + ((yMax - yMin) * i) / 5);
  const bandX = xScale(profile.targetVolMin);
  const bandWidth = Math.max(2, xScale(profile.targetVolMax) - bandX);
  const selectedX = xScale(selected.stats.volatility);
  const selectedY = yScale(selected.stats.expectedReturn);
  const regionShape = region.hull.length >= 3
    ? `<polygon points="${regionPolygon}" fill="#8ecae6" opacity="0.32" stroke="#2f80b7" stroke-width="2" stroke-linejoin="round"></polygon>`
    : region.hull.length === 2
      ? `<line x1="${xScale(region.hull[0].x).toFixed(1)}" y1="${yScale(region.hull[0].y).toFixed(1)}" x2="${xScale(region.hull[1].x).toFixed(1)}" y2="${yScale(region.hull[1].y).toFixed(1)}" stroke="#8ecae6" stroke-width="14" stroke-linecap="round" opacity="0.42"></line>
        <line x1="${xScale(region.hull[0].x).toFixed(1)}" y1="${yScale(region.hull[0].y).toFixed(1)}" x2="${xScale(region.hull[1].x).toFixed(1)}" y2="${yScale(region.hull[1].y).toFixed(1)}" stroke="#2f80b7" stroke-width="2.2" stroke-linecap="round"></line>`
      : "";
  const constraintStatus = (actual, min, max) => (actual >= min - 0.0001 && actual <= max + 0.0001 ? "In range" : "Out of range");
  const constraintProfile = sharedConstraintProfile(selected.profileName || selectedMvoProfile);
  const categoryRows = state.categories.map((category) => {
    const bounds = constraintProfile.categoryBounds[category];
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
    "US Short Treasuries": "Short Treasuries",
    "US Intermediate Treasuries": "Interm Treasuries",
    "US Long Treasuries": "Long Treasuries",
    "Investment Grade Corporate": "IG Corporate",
    "High Yield": "High Yield",
    "International Fixed Income (H)": "Intl Fixed Income (H)",
  }[name] || name);
  const trianglePoints = (x, y, size = 6) => `${x.toFixed(1)},${(y - size).toFixed(1)} ${(x - size).toFixed(1)},${(y + size).toFixed(1)} ${(x + size).toFixed(1)},${(y + size).toFixed(1)}`;
  const benchmarkColor = (name) => ({
    "S&P 500": "#101820",
    "AGG": "#8a8f98",
  }[name] || "#101820");
  const tooltipPosition = (x, y, tooltipW = 190, tooltipH = 48) => ({
    x: x + tooltipW + 16 > width - pad.right ? x - tooltipW - 14 : x + 12,
    y: Math.max(pad.top + 8, Math.min(y - 34, height - pad.bottom - tooltipH - 8)),
  });
  const selectedTooltip = tooltipPosition(selectedX, selectedY, 190, 48);

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
    ${regionShape}
    ${visibleRegionPoints.map((point) => `<circle cx="${xScale(point.x).toFixed(1)}" cy="${yScale(point.y).toFixed(1)}" r="1.45" fill="#2f80b7" opacity="0.18"></circle>`).join("")}
    ${assetPoints.map((p, index) => {
      const x = xScale(p.stats.volatility);
      const y = yScale(p.stats.expectedReturn);
      const tooltipW = 190;
      const tooltipH = 48;
      const tooltip = tooltipPosition(x, y, tooltipW, tooltipH);
      return `<g class="asset-point" tabindex="0" role="button" aria-label="${p.asset.name}: return ${pct(p.stats.expectedReturn)}, volatility ${pct(p.stats.volatility)}" data-tooltip-title="${escapeHtml(p.asset.name)}" data-tooltip-body="Return ${pct(p.stats.expectedReturn)} | Vol ${pct(p.stats.volatility)}">
        <polygon points="${trianglePoints(x, y, 6)}" fill="${assetColor(p.asset, index)}" stroke="#101820" stroke-width="1.1"></polygon>
        <g class="asset-tooltip" transform="translate(${tooltip.x.toFixed(1)}, ${tooltip.y.toFixed(1)})">
          <rect x="0" y="0" width="${tooltipW}" height="${tooltipH}" rx="3"></rect>
          <text x="10" y="18">${p.asset.name}</text>
          <text x="10" y="36">Return ${pct(p.stats.expectedReturn)} | Vol ${pct(p.stats.volatility)}</text>
        </g>
      </g>`;
    }).join("")}
    ${benchmarkPoints.map((p) => {
      const x = xScale(p.stats.volatility);
      const y = yScale(p.stats.expectedReturn);
      const tooltipW = 190;
      const tooltipH = 48;
      const tooltip = tooltipPosition(x, y, tooltipW, tooltipH);
      return `<g class="benchmark-point" tabindex="0" role="button" aria-label="${p.benchmark.name} benchmark" data-tooltip-title="${escapeHtml(p.benchmark.name)}" data-tooltip-body="Reference benchmark">
        <rect x="${(x - 6).toFixed(1)}" y="${(y - 6).toFixed(1)}" width="12" height="12" fill="${benchmarkColor(p.benchmark.name)}" stroke="#101820" stroke-width="1.2"></rect>
        <g class="asset-tooltip" transform="translate(${tooltip.x.toFixed(1)}, ${tooltip.y.toFixed(1)})">
          <rect x="0" y="0" width="${tooltipW}" height="${tooltipH}" rx="3"></rect>
          <text x="10" y="18">${p.benchmark.name}</text>
          <text x="10" y="36">Reference benchmark</text>
        </g>
      </g>`;
    }).join("")}
    <path d="${frontierPath}" fill="none" stroke="#101820" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path>
    <g class="selected-point" tabindex="0" role="button" aria-label="${selected.profileName}: return ${pct(selected.stats.expectedReturn)}, volatility ${pct(selected.stats.volatility)}" data-tooltip-title="${escapeHtml(selected.profileName)}" data-tooltip-body="Return ${pct(selected.stats.expectedReturn)} | Vol ${pct(selected.stats.volatility)}">
      <circle cx="${selectedX.toFixed(1)}" cy="${selectedY.toFixed(1)}" r="8" fill="#00a95a" stroke="#101820" stroke-width="2"></circle>
      <g class="asset-tooltip" transform="translate(${selectedTooltip.x.toFixed(1)}, ${selectedTooltip.y.toFixed(1)})">
        <rect x="0" y="0" width="190" height="48" rx="3"></rect>
        <text x="10" y="18">${selected.profileName}</text>
        <text x="10" y="36">Return ${pct(selected.stats.expectedReturn)} | Vol ${pct(selected.stats.volatility)}</text>
      </g>
    </g>
    <g transform="translate(${pad.left + 8}, 14)">
      <circle cx="0" cy="0" r="6" fill="#00a95a" stroke="#101820" stroke-width="1.5"></circle><text x="14" y="4" class="frontier-axis">Selected portfolio</text>
      <rect x="168" y="-7" width="16" height="14" fill="#8ecae6" opacity="0.45" stroke="#2f80b7"></rect><text x="192" y="4" class="frontier-axis">Allowable region</text>
      <rect x="350" y="-7" width="16" height="14" fill="#00a95a" opacity="0.11" stroke="#00a95a"></rect>
      <line x1="350" y1="-8" x2="350" y2="8" stroke="#00a95a" stroke-width="1.4" stroke-dasharray="4 3"></line>
      <line x1="366" y1="-8" x2="366" y2="8" stroke="#00a95a" stroke-width="1.4" stroke-dasharray="4 3"></line>
      <text x="374" y="4" class="frontier-axis">Target Volatility</text>
      <rect x="550" y="-6" width="12" height="12" fill="#101820" stroke="#101820" stroke-width="1.2"></rect><text x="568" y="4" class="frontier-axis">S&amp;P 500</text>
      <rect x="635" y="-6" width="12" height="12" fill="#8a8f98" stroke="#101820" stroke-width="1.2"></rect><text x="653" y="4" class="frontier-axis">AGG</text>
    </g>
    <text x="${width / 2}" y="${height - 6}" text-anchor="middle" class="frontier-axis">Annualized volatility</text>
    <text x="16" y="${height / 2}" text-anchor="middle" transform="rotate(-90 16 ${height / 2})" class="frontier-axis">Compound return</text>
  </svg>
  </div>
  `;

  const constraintsBox = document.querySelector("#mvoConstraints");
  if (constraintsBox) {
    constraintsBox.innerHTML = `<div class="chart-constraints">
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
  </div>`;
  }
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
  selectedAssumptionSet = state.selectedAssumptionSet || "CORE";
  applyAssumptionSet(selectedAssumptionSet);
  selectedAllocationPreset = "CORE";
  selectedSubAllocationPreset = "CORE";
  applySubAllocationPreset(selectedSubAllocationPreset);
  ensureVolatilityModel();
  applyVolatilityModel();
  renderEditableInputs();
  runOptimization();
}

function applyAllocationPreset(name) {
  selectedAllocationPreset = name;
  Object.entries(state.profiles).forEach(([profileName, profile]) => {
    state.categories.forEach((category) => {
      if (name === "Unconstrained") {
        profile.categoryBounds[category] = { min: 0, max: 1 };
      } else {
        profile.categoryBounds[category] = clone(baseData.profiles[profileName].categoryBounds[category]);
      }
    });
  });
}

function applySubAllocationPreset(name) {
  selectedSubAllocationPreset = name;
  state.assets.forEach((asset, index) => {
    if (name === "Unconstrained") {
      asset.minWeight = 0;
      asset.maxWeight = 1;
    } else {
      asset.minWeight = baseData.assets[index].minWeight;
      asset.maxWeight = baseData.assets[index].maxWeight;
    }
  });
}

function refreshMvo() {
  if (!mvoDirty && frontierResult) {
    renderMvo();
    return;
  }
  document.querySelector("#mvoMetrics").innerHTML = `<div class="metric"><div class="label">Status</div><div class="value">Calculating</div></div>`;
  document.querySelector("#frontierChart").innerHTML = `<p class="frontier-note">Calculating efficient frontier...</p>`;
  document.querySelector("#mvoWeightCharts").innerHTML = `<p class="frontier-note">Calculating weights...</p>`;
  document.querySelector("#mvoConstraints").innerHTML = "";
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

function applyPercentileShift(input) {
  const shift = Number.parseFloat(input.value);
  if (!Number.isFinite(shift) || Math.abs(shift) < 1e-9) {
    input.value = "";
    return;
  }
  ensureVolatilityModel();
  Object.values(state.volatilityModel.profiles).forEach((rule) => {
    rule.percentile = Math.max(0, Math.min(100, (rule.percentile || 0) + shift));
  });
  input.value = "";
  runOptimization();
}

function showHoverTooltip(target, event = null) {
  const title = target.dataset.tooltipTitle;
  const body = target.dataset.tooltipBody;
  if (!title) return;
  let tooltip = document.querySelector("#hoverTooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "hoverTooltip";
    tooltip.className = "hover-tooltip";
    document.body.appendChild(tooltip);
  }
  tooltip.replaceChildren();
  const titleNode = document.createElement("strong");
  titleNode.textContent = title;
  tooltip.appendChild(titleNode);
  if (body) {
    const bodyNode = document.createElement("span");
    bodyNode.textContent = body;
    tooltip.appendChild(bodyNode);
  }
  tooltip.classList.add("visible");
  moveHoverTooltip(event, target);
}

function moveHoverTooltip(event, fallbackTarget = null) {
  const tooltip = document.querySelector("#hoverTooltip");
  if (!tooltip?.classList.contains("visible")) return;
  const rect = tooltip.getBoundingClientRect();
  const sourceRect = fallbackTarget?.getBoundingClientRect?.();
  const sourceX = event?.clientX ?? (sourceRect ? sourceRect.left + sourceRect.width / 2 : 24);
  const sourceY = event?.clientY ?? (sourceRect ? sourceRect.top + sourceRect.height / 2 : 24);
  let left = sourceX + 14;
  let top = sourceY + 14;
  if (left + rect.width > window.innerWidth - 10) left = sourceX - rect.width - 14;
  if (top + rect.height > window.innerHeight - 10) top = sourceY - rect.height - 14;
  tooltip.style.left = `${Math.max(10, left)}px`;
  tooltip.style.top = `${Math.max(10, top)}px`;
}

function hideHoverTooltip() {
  document.querySelector("#hoverTooltip")?.classList.remove("visible");
}

document.addEventListener("mouseover", (event) => {
  const target = event.target.closest("[data-tooltip-title]");
  if (target) showHoverTooltip(target, event);
});

document.addEventListener("mousemove", (event) => {
  if (event.target.closest("[data-tooltip-title]")) moveHoverTooltip(event);
});

document.addEventListener("mouseout", (event) => {
  const target = event.target.closest("[data-tooltip-title]");
  if (target && !target.contains(event.relatedTarget)) hideHoverTooltip();
});

document.addEventListener("focusin", (event) => {
  const target = event.target.closest("[data-tooltip-title]");
  if (target) showHoverTooltip(target);
});

document.addEventListener("focusout", (event) => {
  if (event.target.closest("[data-tooltip-title]")) hideHoverTooltip();
});

document.addEventListener("input", (event) => {
  if (!event.target.matches("input[data-path]")) return;
  updateInputState(event.target);
  scheduleLiveUpdate();
});

document.addEventListener("change", (event) => {
  if (event.target.matches("#percentileShiftInput")) {
    applyPercentileShift(event.target);
    return;
  }
  if (event.target.matches("#assumptionSetSelect")) {
    applyAssumptionSet(event.target.value);
    runOptimization();
    return;
  }
  if (event.target.matches("#mvoProfileSelect")) {
    selectedMvoProfile = event.target.value;
    renderMvo();
    return;
  }
  if (event.target.matches("#allocationPresetSelect")) {
    applyAllocationPreset(event.target.value);
    runOptimization();
    return;
  }
  if (event.target.matches("#subAllocationPresetSelect")) {
    applySubAllocationPreset(event.target.value);
    runOptimization();
    return;
  }
  if (!event.target.matches("input[data-path]")) return;
  commitInputUpdate(event.target);
});

document.addEventListener("keydown", (event) => {
  if (event.target.matches("#percentileShiftInput") && event.key === "Enter") {
    event.preventDefault();
    applyPercentileShift(event.target);
  }
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
  if (button?.id === "resetModel") resetModel();
});

async function init() {
  try {
    baseData = await fetch("./data/model-data.json?v=20260723-allowable-12500", { cache: "no-store" }).then((r) => {
      if (!r.ok) throw new Error(`Could not load model-data.json (${r.status})`);
      return r.json();
    });
    state = clone(baseData);
    selectedAssumptionSet = state.selectedAssumptionSet || "CORE";
    applyAssumptionSet(selectedAssumptionSet);
    applySubAllocationPreset(selectedSubAllocationPreset);
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
