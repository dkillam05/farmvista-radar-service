// FarmVista Radar Backend (v1)
// Simple manifest service using NOAA RIDGE radar

const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 8080;

// ---- SIMPLE IN-MEMORY CACHE ----
let cachedManifest = null;
let lastFetch = 0;
const CACHE_MS = 2 * 60 * 1000; // 2 minutes

// ---- NOAA RIDGE BASE (CONUS composite) ----
// NOTE: this is a working public radar image pattern
// We simulate frames by stepping timestamps
const BASE_URL =
  "https://radar.weather.gov/ridge/standard/CONUS_loop.gif";

// ---- HEALTH CHECK ----
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "farmvista-radar" });
});

// ---- RADAR MANIFEST ----
app.get("/api/radar/manifest", async (req, res) => {
  try {
    const now = Date.now();

    // ---- RETURN CACHE IF FRESH ----
    if (cachedManifest && now - lastFetch < CACHE_MS) {
      return res.json(cachedManifest);
    }

    // ---- BUILD FRAMES (SIMULATED TIMELINE) ----
    const frames = [];
    const FRAME_COUNT = 30; // ~5 hours at 10 min steps
    const STEP_MINUTES = 10;

    for (let i = FRAME_COUNT - 1; i >= 0; i--) {
      const ts = new Date(now - i * STEP_MINUTES * 60 * 1000);

      frames.push({
        time: ts.toISOString(),

        // NOAA GIF loop (simple v1)
        // later we replace with real tile frames
        imageUrl: BASE_URL + `?t=${ts.getTime()}`
      });
    }

    const manifest = {
      provider: "noaa-ridge",
      updatedAt: new Date().toISOString(),
      defaultOpacity: 0.5,
      defaultSpeedMs: 400,
      frames
    };

    // ---- CACHE IT ----
    cachedManifest = manifest;
    lastFetch = now;

    res.json(manifest);
  } catch (err) {
    console.error("manifest error:", err);
    res.status(500).json({ error: "failed to build manifest" });
  }
});

// ---- START SERVER ----
app.listen(PORT, () => {
  console.log(`Radar service running on port ${PORT}`);
});
