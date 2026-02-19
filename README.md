# [MTS] — Monitor the Situation (Montana)

A command-center dashboard and CLI for monitoring MDT RWIS traffic cameras across Montana.

## Quick Start

```bash
cd monitor-the-situation
node cli/mts-cli.js serve
```

Then open http://localhost:8080

> The web app requires the local proxy server to resolve CORS restrictions on the MDT API.

---

## Web UI Features

- Montana map (Leaflet / CartoDB Dark Matter) with live camera pins
- **Browse mode**: pan/zoom to filter cameras by viewport
- **Quick select**: Missoula, Helena, Billings, Bozeman, Great Falls, Kalispell, and more
- **Column slider**: 1–20 columns (up to 20×20 = 400 feeds)
- **Pop-out modal**: click any camera; `←` `→` arrow keys to navigate, `ESC` to close
- **Auto-refresh**: 30s / 60s / 2m / 5m intervals
- **Keyboard shortcuts**: `R` refresh all · `ESC` reset

---

## CLI Usage

```bash
# List cameras by area
node cli/mts-cli.js cameras --area missoula
node cli/mts-cli.js cameras --area billings --route I-90 --limit 20
node cli/mts-cli.js cameras --area bozeman

# By coordinates + radius
node cli/mts-cli.js cameras --lat 46.87 --lng -113.99 --radius 15

# Visual weather assessment
node cli/mts-cli.js weather --area missoula
node cli/mts-cli.js weather --area bozeman

# Show/open a specific camera
node cli/mts-cli.js show 150000 --open
node cli/mts-cli.js show 150000 --save cam.jpg

# JSON output (for scripting/agents)
node cli/mts-cli.js cameras --area helena --json

# Natural language (agent mode)
node cli/mts-cli.js ask "show me cameras on I-90 near Missoula"
node cli/mts-cli.js ask "what are road conditions on Lookout Pass"
```

### Known Areas

| Key        | Name             |
|------------|------------------|
| missoula   | Missoula         |
| helena     | Helena           |
| butte      | Butte            |
| kalispell  | Kalispell        |
| billings   | Billings         |
| bozeman    | Bozeman          |
| greatfalls | Great Falls      |
| havre      | Havre            |
| lewistown  | Lewistown        |
| milescity  | Miles City       |
| glendive   | Glendive         |
| wolfpoint  | Wolf Point       |
| livingston | Livingston       |
| i90        | I-90 Corridor    |
| i15        | I-15 Corridor    |
| i94        | I-94 Corridor    |
| montana    | All Montana      |

---

## Self-Hosting on Vercel

1. Fork this repository on GitHub
2. Import your fork in the Vercel dashboard
3. Deploy — no build step required, Vercel serves static files automatically
4. The `api/mdt.js` and `api/mdt-image.js` serverless functions handle MDT API proxying

The app runs entirely on Vercel's free hobby tier.

---

## Pull Request / Collaboration

This branch is Montana's adaptation of [monitor-the-situation](https://github.com/scottew/monitor-the-situation) originally built for Utah. The architecture is identical — only the data source (MDT RWIS instead of UDOT) and map content differ.

To submit a PR to the original repo:
```bash
git push origin montana
# Then open a PR from your fork's montana branch → scottew/monitor-the-situation main
```

---

## Data Source

MDT (Montana Department of Transportation) public RWIS camera API.

- Camera positions: `https://ftp.mdt.mt.gov/travinfo/weather/rwis.xml` (~120 Montana RWIS stations)
- Camera images: `https://app.mdt.mt.gov/atms/public/camera/lastFiveImages/{positionId}` (JPEG, 720×480, refreshed every ~15 min during daylight)

No API key required.

---

## Project Structure

```
monitor-the-situation/
├── index.html
├── style.css
├── app.js
├── package.json
├── vercel.json
└── api/
│   ├── mdt.js           MDT camera manifest proxy (parses RWIS XML)
│   ├── mdt-image.js     MDT image redirect proxy (resolves dynamic URLs)
│   ├── presence.js      Presence counter (disabled by default)
│   └── test.js          API test endpoint
└── cli/
    ├── mts-cli.js       CLI + local dev proxy server
    └── package.json
```

---

## Original Project

Based on [Monitor the Situation](https://utah.monitorit.app) by scottew — originally built for Utah DOT cameras.
