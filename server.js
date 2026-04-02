// FarmVista Radar Backend (v4)
// Hybrid animated radar manifest:
// - Recent frames use fast cached IEM TMS mosaic tiles (best for smooth animation)
// - Older frames fall back to IEM historical WMS-T
//
// Why:
// IEM documents:
//   1) cache-friendly TMS endpoints at /c/tile.py/1.0.0/ and /cache/tile.py/1.0.0/
//   2) current NEXRAD mosaic names like nexrad-n0q and nexrad-n0q-mXXm
//   3) historical radar via WMS/WMS-T
//
// This backend gives the frontend one manifest that can animate both.
//
// Notes:
// - "Recent" cached tile frames are available only for the documented current/minutes-old
//   mosaic window (05..55 minutes old, modulo 5), plus current.
// - Older lookback frames are returned as WMS-T frame descriptors.
// - Frontend should prefer tile frames when frame.source === "tms"
//   and use viewport WMS overlay when frame.source === "wms".
//
// Endpoints:
//   GET /health
//   GET /api/radar/manifest?minutes=300

const express = require("express");

const app = express();
const PORT = process.env.PORT || 8080;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

const CACHE_MS = 2 * 60 * 1000;
let cachedManifest = null;
let lastFetch = 0;

const DEFAULT_MINUTES = 300;
const MIN_LOOKBACK_MINUTES = 15;
const MAX_LOOKBACK_MINUTES = 360;
const STEP_MINUTES = 5;

// IEM documented cache endpoints
const IEM_TMS_LONG_CACHE_BASE = "https://mesonet.agron.iastate.edu/c/tile.py/1.0.0";
const IEM_WMS_BASE = "https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function snapToFiveMinutes(date) {
  const d = new Date(date);
  d.setUTCSeconds(0, 0);
  const mins = d.getUTCMinutes();
  d.setUTCMinutes(mins - (mins % 5));
  return d;
}

function formatIsoNoSeconds(date) {
  const y = date.getUTCFullYear();
  const m = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  const hh = pad2(date.getUTCHours());
  const mm = pad2(date.getUTCMinutes());
  return `${y}-${m}-${d}T${hh}:${mm}:00Z`;
}

function formatTimestampForLayer(date) {
  const y = date.getUTCFullYear();
  const m = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  const hh = pad2(date.getUTCHours());
  const mm = pad2(date.getUTCMinutes());
  return `${y}${m}${d}${hh}${mm}`;
}

function clampLookbackMinutes(value) {
  const n = Number(value || DEFAULT_MINUTES);
  if (!Number.isFinite(n)) return DEFAULT_MINUTES;
  return Math.max(MIN_LOOKBACK_MINUTES, Math.min(MAX_LOOKBACK_MINUTES, Math.round(n)));
}

function buildRecentTmsLayer(minutesOld) {
  if (minutesOld <= 0) return "nexrad-n0q";
  return `nexrad-n0q-m${pad2(minutesOld)}m`;
}

function buildTmsTileTemplate(layerName) {
  return `${IEM_TMS_LONG_CACHE_BASE}/${layerName}/{z}/{x}/{y}.png`;
}

function buildWmsDescriptor(ts) {
  return {
    baseUrl: IEM_WMS_BASE,
    layers: "nexrad-n0q-wmst",
    format: "image/png",
    transparent: true,
    version: "1.1.1",
    srs: "EPSG:3857",
    time: formatIsoNoSeconds(ts)
  };
}

function buildFrames(minutes) {
  const end = snapToFiveMinutes(new Date());
  const frameCount = Math.floor(minutes / STEP_MINUTES) + 1;
  const frames = [];

  for (let i = frameCount - 1; i >= 0; i -= 1) {
    const ts = new Date(end.getTime() - i * STEP_MINUTES * 60 * 1000);
    const minutesOld = i * STEP_MINUTES;
    const iso = formatIsoNoSeconds(ts);

    // Best smooth-play path:
    // Use documented current/minutes-old mosaic tile layers for 0..55 minutes old.
    if (minutesOld <= 55) {
      const layerName = buildRecentTmsLayer(minutesOld);

      frames.push({
        time: iso,
        timeLabelUtc: iso,
        source: "tms",
        cacheClass: "long",
        layerName,
        tileTemplate: buildTmsTileTemplate(layerName),
        ageMinutes: minutesOld
      });
      continue;
    }

    // Older history:
    // Return historical WMS-T frame descriptor.
    frames.push({
      time: iso,
      timeLabelUtc: iso,
      source: "wms",
      cacheClass: "dynamic",
      archivedLayerTimestamp: formatTimestampForLayer(ts),
      wms: buildWmsDescriptor(ts),
      ageMinutes: minutesOld
    });
  }

  return { end, frames };
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "farmvista-radar"
  });
});

app.get("/api/radar/manifest", (req, res) => {
  try {
    const now = Date.now();
    const minutes = clampLookbackMinutes(req.query.minutes);

    if (
      cachedManifest &&
      now - lastFetch < CACHE_MS &&
      cachedManifest.minutes === minutes
    ) {
      return res.json(cachedManifest);
    }

    const { end, frames } = buildFrames(minutes);

    const tileFrames = frames.filter((f) => f.source === "tms").length;
    const wmsFrames = frames.filter((f) => f.source === "wms").length;

    const manifest = {
      provider: "iem-hybrid",
      product: "n0q",
      minutes,
      stepMinutes: STEP_MINUTES,
      updatedAt: new Date().toISOString(),
      latestFrameTime: formatIsoNoSeconds(end),
      frameCount: frames.length,
      tileFrameCount: tileFrames,
      wmsFrameCount: wmsFrames,
      defaultOpacity: 0.5,
      defaultSpeedMs: 700,
      recommendedRenderMode: tileFrames > 0 && wmsFrames === 0 ? "tiles" : "hybrid",
      notes: {
        tileFramesWindowMinutes: 55,
        tileFramesBestForSmoothPlayback: true,
        olderFramesRequireViewportWmsOverlay: true
      },
      frames
    };

    cachedManifest = manifest;
    lastFetch = now;

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