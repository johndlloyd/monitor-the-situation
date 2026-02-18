/**
 * MTS — openclaw Tool Integration
 *
 * Drop this file (or symlink it) into your openclaw extensions or tools directory.
 * It exposes a "mts" tool that agents can call to get UDOT camera data.
 *
 * Tool schema follows the Claude tool_use format.
 *
 * To register manually in an openclaw agent prompt, describe the tool as:
 *
 *   Name: mts
 *   Description: Query UDOT traffic cameras in Utah. Can show camera feeds by area,
 *     route, or coordinates. Returns camera locations and image URLs. Useful for
 *     checking road conditions, weather, and traffic visually.
 *   Input schema: see TOOL_SCHEMA below
 */

'use strict';

const { execSync, spawnSync } = require('child_process');
const path = require('path');

const CLI_PATH = path.join(__dirname, 'mts-cli.js');

// ── Tool Schema (Claude tool_use format) ────────
const TOOL_SCHEMA = {
  name: 'mts',
  description: `Query UDOT (Utah Department of Transportation) traffic cameras.
Returns a list of camera locations and image URLs for the requested area or route.
Use this when the user asks about:
- Traffic conditions, road conditions, or travel in Utah
- Weather conditions on Utah roads (visual via camera)
- Specific routes: I-15, I-80, I-84, I-70, SR-201, US-6, etc.
- Cities: Salt Lake City, Ogden, Provo, St. George, Logan, Moab, Park City
- Any request to "see" or "view" current road/traffic/weather conditions`,

  input_schema: {
    type: 'object',
    properties: {
      query_type: {
        type: 'string',
        enum: ['cameras', 'weather', 'show'],
        description: 'Type of query: "cameras" for camera list, "weather" for weather conditions, "show" for specific camera'
      },
      area: {
        type: 'string',
        description: 'Area name: slc, ogden, provo, stgeorge, logan, moab, parkcity, i15, i80, i84, i70, wasatch, utah'
      },
      route: {
        type: 'string',
        description: 'Highway or road name, e.g. "I-15", "SR-201", "US-6"'
      },
      lat: {
        type: 'number',
        description: 'Latitude for coordinate-based search'
      },
      lng: {
        type: 'number',
        description: 'Longitude for coordinate-based search'
      },
      radius: {
        type: 'number',
        description: 'Search radius in miles (default 20)'
      },
      camera_id: {
        type: 'string',
        description: 'Specific camera ID (for query_type=show)'
      },
      limit: {
        type: 'number',
        description: 'Maximum number of cameras to return (default 20)'
      },
      natural_language: {
        type: 'string',
        description: 'Natural language query, e.g. "show me cameras on I-15 near Salt Lake"'
      }
    },
    required: ['query_type']
  }
};

// ── Tool Executor ───────────────────────────────
function executeTool(input) {
  const { query_type, area, route, lat, lng, radius, camera_id, limit, natural_language } = input;

  // Build CLI args
  const args = [CLI_PATH];

  if (natural_language) {
    args.push('ask', natural_language);
  } else {
    args.push(query_type);
    if (area)      args.push('--area',   area);
    if (route)     args.push('--route',  route);
    if (lat)       args.push('--lat',    String(lat));
    if (lng)       args.push('--lng',    String(lng));
    if (radius)    args.push('--radius', String(radius));
    if (camera_id) args.push(camera_id);
    if (limit)     args.push('--limit',  String(limit));
    args.push('--json');
  }

  try {
    const result = spawnSync('node', args, {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, NO_OPEN: '1' },
    });

    if (result.error) {
      return { error: result.error.message };
    }

    const stdout = result.stdout || '';
    const stderr = result.stderr || '';

    // Try to parse JSON output
    try {
      return JSON.parse(stdout);
    } catch (_) {
      return { raw_output: stdout, stderr };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ── Format for Agent ────────────────────────────
function formatCameraResult(data) {
  if (data.error) return `Error: ${data.error}`;

  // Array of cameras
  const cameras = Array.isArray(data) ? data : (data.cameras || []);

  if (!cameras.length) return 'No cameras found for the specified area/filters.';

  const lines = [
    `Found ${cameras.length} UDOT traffic camera${cameras.length !== 1 ? 's' : ''}:`,
    ''
  ];

  cameras.forEach((cam, i) => {
    lines.push(
      `${i+1}. **${cam.location || `Camera ${cam.id}`}**` +
      (cam.roadway ? ` (${cam.roadway})` : '')
    );
    lines.push(`   ID: ${cam.id} | Coords: ${cam.lat?.toFixed(4)}, ${cam.lng?.toFixed(4)}`);
    lines.push(`   Image: ${cam.imgUrl}`);
    lines.push('');
  });

  return lines.join('\n');
}

// ── Export for openclaw plugin use ─────────────
module.exports = {
  TOOL_SCHEMA,
  executeTool,
  formatCameraResult,
};

// ── Direct invocation test ──────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log('Tool schema:');
    console.log(JSON.stringify(TOOL_SCHEMA, null, 2));
    return;
  }

  // Test: node openclaw-tool.js cameras slc
  const input = {
    query_type: args[0] || 'cameras',
    area: args[1] || undefined,
    limit: 5,
  };

  const result = executeTool(input);
  console.log(formatCameraResult(result));
}
