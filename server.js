// FarmVista Radar Backend (v2)
// Real NOAA RIDGE frame manifest using actual per-frame GIFs

const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 8080;

const RIDGE_INDEX_URL = "https://radar.weather.gov/ridge/standard/";
const CACHE_MS = 2 * 60 * 1000;

let cachedByRegion = new Map();

const REGION_MAP = {
  CONUS: "CONUS",
  CONUS_LARGE: "CONUS-LARGE",
  MIDWEST: "CENTGRLAKES",
  CENTGRLAKES: "CENTGRLAKES"
};

function normalizeRegion(input) {
  const key = String(input || "MIDWEST").trim().toUpperCase();
  return REGION_MAP[key] || "CENTGRLAKES";
}

function parseApacheDateToIso(dateStr) {
  // Example: 01-Apr-2026 23:03
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2})$/.exec(dateStr.trim());
  if (!m) return null;

  const [, dd, mon, yyyy, hh, mm] = m;
  const months = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12"
  };
  const month = months[mon];
  if (!month) return null;

  return `${yyyy}-${month}-${dd}T${hh}:${mm}:00Z`;
}

function buildFallbackFrames(region) {
  // NOAA standard ridge commonly shows 10 recent frames in this directory.
  const now = Date.now();
  const frames = [];

  for (let i = 9; i >= 0; i--) {
    const approxTs = new Date(now - i * 2 * 60 * 1000).toISOString();
    const frameNum = 9 - i; // oldest -> newest becomes 9..0 reverse mapping
    frames.push({
      frame: frameNum,
      time: approxTs,
      imageUrl: `${RIDGE_INDEX_URL}${region}_${frameNum}.gif`
    });
  }

  return frames;
}

function extractFramesFromIndex(html, region) {
  const escapedRegion = region.replace("-", "\\-");
  const regex = new RegExp(
    `href="${escapedRegion}_(\\d+)\\.gif"[^\\n\\r]*?(\\d{2}-[A-Za-z]{3}-\\d{4} \\d{2}:\\d{2})`,
    "g"
  );

  const found = [];
  let match;

  while ((match = regex.exec(html)) !== null) {
    const frameNum = Number(match[1]);
    const dateStr = match[2];
    const iso = parseApacheDateToIso(dateStr);

    found.push({
      frame: frameNum,
      time: iso,
      imageUrl: `${RIDGE_INDEX_URL}${region}_${frameNum}.gif`
    });
  }

  // Deduplicate in case regex picks up duplicates
  const deduped = [];
  const seen = new Set();

  for (const item of found) {
    const key = `${item.frame}|${item.imageUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  // RIDGE numbering is usually 0 = newest, 9 = oldest.
  // Return oldest -> newest for clean playback.
  deduped.sort((a, b) => b.frame - a.frame);

  return deduped;
}

async function buildManifest(region) {
  const now = Date.now();
  const cacheKey = region;
  const cached = cachedByRegion.get(cacheKey);

  if (cached && now - cached.lastFetch < CACHE_MS) {
    return cached.manifest;
  }

  let frames = [];

  try {
    const resp = await fetch(RIDGE_INDEX_URL, {
      headers: {
        "User-Agent": "FarmVista-Radar/1.0"
      },
      timeout: 15000
    });

    if (!resp.ok) {
      throw new Error(`RIDGE index fetch failed: ${resp.status}`);
    }

    const html = await resp.text();
    frames = extractFramesFromIndex(html, region);
  } catch (err) {
    console.error("RIDGE index fetch/parse failed, using fallback:", err.message);
  }

  if (!frames.length) {
    frames = buildFallbackFrames(region);
  }

  const latest = frames[frames.length - 1] || null;

  const manifest = {
    provider: "noaa-ridge",
    region,
    updatedAt: new Date().toISOString(),
    latestFrameTime: latest ? latest.time : null,
    frameCount: frames.length,
    defaultOpacity: 0.5,
    defaultSpeedMs: 400,
    frames
  };

  cachedByRegion.set(cacheKey, {
    lastFetch: now,
    manifest
  });

  return manifest;
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "farmvista-radar"
  });
});

app.get("/api/radar/manifest", async (req, res) => {
  try {
    const region = normalizeRegion(req.query.region);
    const manifest = await buildManifest(region);
    res.json(manifest);
  } catch (err) {
    console.error("manifest error:", err);
    res.status(500).json({
      error: "failed to build manifest"
    });
  }
});

app.listen(PORT, () => {
  console.log(`FarmVista radar service running on port ${PORT}`);
});