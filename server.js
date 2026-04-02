// FarmVista Radar Backend (v3)
// Historical radar frame manifest for animated playback
// Source model: IEM historical CONUS NEXRAD Base Reflectivity WMS-T

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

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "farmvista-radar"
  });
});

app.get("/api/radar/manifest", (req, res) => {
  try {
    const now = Date.now();

    const minutes = Math.max(15, Math.min(360, Number(req.query.minutes || 300)));
    const stepMinutes = 5;

    if (
      cachedManifest &&
      now - lastFetch < CACHE_MS &&
      cachedManifest.minutes === minutes
    ) {
      return res.json(cachedManifest);
    }

    const end = snapToFiveMinutes(new Date());
    const frameCount = Math.floor(minutes / stepMinutes) + 1;

    const frames = [];
    for (let i = frameCount - 1; i >= 0; i -= 1) {
      const ts = new Date(end.getTime() - i * stepMinutes * 60 * 1000);

      frames.push({
        time: formatIsoNoSeconds(ts),
        timeLabelUtc: formatIsoNoSeconds(ts),
        // Frontend will use this with Google Maps tile requests.
        // TIME is the key thing the animation will swap.
        wms: {
          baseUrl: "https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi",
          layers: "nexrad-n0q-wmst",
          format: "image/png",
          transparent: true,
          version: "1.1.1",
          srs: "EPSG:3857",
          time: formatIsoNoSeconds(ts)
        }
      });
    }

    const manifest = {
      provider: "iem-wms-t",
      product: "n0q",
      minutes,
      stepMinutes,
      updatedAt: new Date().toISOString(),
      latestFrameTime: frames.length ? frames[frames.length - 1].time : null,
      frameCount: frames.length,
      defaultOpacity: 0.5,
      defaultSpeedMs: 400,
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