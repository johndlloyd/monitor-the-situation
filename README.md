# [MTS] — Monitor the Situation

A command-center dashboard and CLI for monitoring UDOT traffic cameras across Utah.

## Quick Start

```bash
cd monitor-the-situation
node cli/mts-cli.js serve
```

Then open http://localhost:8080

> The web app requires the local proxy server to resolve CORS restrictions on the UDOT API.

---

## Web UI Features

- Utah map (Leaflet / CartoDB Dark Matter) with live camera pins
- **Browse mode**: pan/zoom to filter cameras by viewport
- **Circle mode**: click the map to place a monitoring radius (1–50 miles)
- **Quick select**: SLC, Ogden, Provo, St. George, Logan, All Utah
- **Route / text search** filters
- **Column slider**: 1–20 columns (up to 20×20 = 400 feeds)
- **Pop-out modal**: click any camera; `←` `→` arrow keys to navigate, `ESC` to close
- **Auto-refresh**: 30s / 60s / 2m / 5m intervals
- **Keyboard shortcuts**: `F` focus search · `R` refresh all · `ESC` reset

---

## CLI Usage

```bash
# List cameras by area
node cli/mts-cli.js cameras --area slc
node cli/mts-cli.js cameras --area wasatch --limit 20
node cli/mts-cli.js cameras --area slc --route I-15

# By coordinates + radius
node cli/mts-cli.js cameras --lat 40.76 --lng -111.89 --radius 5

# Visual weather assessment
node cli/mts-cli.js weather --area slc
node cli/mts-cli.js weather --area i80

# Show/open a specific camera
node cli/mts-cli.js show 55982 --open
node cli/mts-cli.js show 55982 --save cam.jpg

# JSON output (for scripting/agents)
node cli/mts-cli.js cameras --area provo --json

# Natural language (agent mode)
node cli/mts-cli.js ask "show me webcam weather on I-15 near Salt Lake"
node cli/mts-cli.js ask "cameras near ogden"
```

### Known Areas

| Key       | Name              |
|-----------|-------------------|
| slc       | Salt Lake City    |
| ogden     | Ogden             |
| provo     | Provo/Orem        |
| stgeorge  | St. George        |
| logan     | Logan             |
| moab      | Moab              |
| parkcity  | Park City         |
| i15       | I-15 Corridor     |
| i80       | I-80 Corridor     |
| i84       | I-84 Corridor     |
| i70       | I-70 Corridor     |
| wasatch   | Wasatch Front     |
| utah      | All Utah          |

---

## openclaw Agent Integration

`cli/mts-openclaw-tool.js` exports a tool schema (Claude `tool_use` format) and executor for openclaw agents.

```javascript
const { TOOL_SCHEMA, executeTool, formatCameraResult } = require('./cli/mts-openclaw-tool');

const result = executeTool({ query_type: 'weather', area: 'slc' });
console.log(formatCameraResult(result));
```

Agent natural language examples:
- `"what do road conditions look like on I-15 right now"`
- `"show me cameras near Provo"`
- `"I-80 weather conditions"`

---

## Data Source

UDOT public traffic API at [udottraffic.utah.gov](https://www.udottraffic.utah.gov). No API key required.

- Camera positions: `/map/mapIcons/Cameras` (~2,000+ cameras statewide)
- Camera images: `/map/Cctv/{id}` (JPEG, ~1280×720, refreshed every ~60s)

---

## Project Structure

```
monitor-the-situation/
├── index.html
├── style.css
├── app.js
├── package.json
└── cli/
    ├── mts-cli.js            CLI (cameras, weather, show, serve, ask)
    ├── mts-openclaw-tool.js  openclaw agent integration
    └── package.json
```
