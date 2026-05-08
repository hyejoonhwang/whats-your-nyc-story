// Step 3: integrate Pretext. Real stories load from /stories and are laid out as typography.
// CITY tier → titles only (recency wins per dot). BOROUGH → title + author/snippet. BLOCKS → full wrapped story.

import {
  prepareWithSegments,
  walkLineRanges,
  measureNaturalWidth,
  materializeLineRange,
} from "/vendor/pretext/layout.js";

const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");
const DPR = window.devicePixelRatio || 1;

const BASE_CELL = 12;
const GRID_W = COLS * BASE_CELL;
const GRID_H = ROWS * BASE_CELL;

const TIER_BOROUGH = 2.0;
const TIER_BLOCKS = 5.0;
const MIN_SCALE = 0.3;
const MAX_SCALE = 25;

const FONT_FAMILY = 'ui-monospace, "SF Mono", Menlo, monospace';
const FONT_SIZE = 10;
const LINE_HEIGHT = 12;
const FONT = `${FONT_SIZE}px ${FONT_FAMILY}`;

// Post-it visual params. Each story dot gets its own paper-textured rectangle
// with deterministic color + tilt. Post-its fade in as the user zooms from
// CITY into BOROUGH; below that they're invisible and we fall back to the
// existing typography-only rendering.
const POSTIT_COLORS = [
  "#fff0a0",  // yellow
  "#ffc1c4",  // pink
  "#bce8a8",  // mint
  "#bedeed",  // sky
  "#ffd1a3",  // orange
  "#dcc6e8",  // lavender
];
const POSTIT_PAD = 3;                             // inner padding (text -> edge)
const POSTIT_MAX_INNER = 120;                     // max post-it inner width (screen px)
const POSTIT_FADE_START = 10;                     // post-it snaps in at this scale (matches ASCII v=78)
const POSTIT_STAGGER = 0.25;                      // each subsequent (older) post-it appears this many zoom units later
const POSTIT_MAX_ROT = 5 * Math.PI / 180;         // ±5° random tilt per dot
const POSTIT_INK = "rgba(40,40,40,0.95)";         // dark pencil/ink color on paper
const POSTIT_TOP_PIN_R_MIN = 2.5;                 // top-of-post-it pin: min screen radius
const POSTIT_TOP_PIN_R_MAX = 5;                   // top-of-post-it pin: max screen radius

// Pin-head visual params. At low zoom, each story is represented by a 3D
// glossy pin clustered around its dot — number of pins matches story count.
// Pins cross-fade with post-its over the same range (pin out / post-it in).
const PIN_RADIUS_WORLD = 1.8;                     // pin radius in world units
const PIN_RADIUS_MIN_SCREEN = 2;                  // never below this on screen
const PIN_RADIUS_MAX_SCREEN = 5;                  // matches the top-pin size on the smallest post-it
const PIN_CLUSTER_RADIUS_WORLD = BASE_CELL * 0.5; // pins fan out within the dot footprint
const PIN_FADE_START = POSTIT_FADE_START;                       // pins start fading exactly when the first post-it appears
const PIN_FADE_END = POSTIT_FADE_START + 0.3;                   // pins gone shortly after the first post-it pops in
// Empty-cell dots scale with zoom too — small dots at zoom-out so they
// don't overshadow the pins, modest at zoom-in so the unwritten grid stays
// visible behind post-its.
const DOT_RADIUS_WORLD = 0.6;
const DOT_RADIUS_MIN_SCREEN = 0.4;
const DOT_RADIUS_MAX_SCREEN = 2.5;

const PIN_PALETTE = [
  { mid: "#e83a26", light: "#ffb1a0", dark: "#7c1410" }, // red
  { mid: "#f7c920", light: "#fff4a8", dark: "#a8870a" }, // yellow
  { mid: "#1e6dd4", light: "#7bb5ff", dark: "#0a3672" }, // blue
  { mid: "#2ea84a", light: "#88dba0", dark: "#155a26" }, // green
  { mid: "#f0ebde", light: "#ffffff", dark: "#a89e8a" }, // white-ish
  { mid: "#2a2825", light: "#7a766c", dark: "#0a0908" }, // black
  { mid: "#7a2eb8", light: "#c79be0", dark: "#3a1265" }, // purple
  { mid: "#e8722e", light: "#ffb98a", dark: "#8c3a0e" }, // orange
];

const view = { scale: 1, tx: 0, ty: 0 };
let currentTier = "CITY";

// Stories live as a flat array now — each story has its own (wx, wy) world
// coordinates from the click point that placed it. No cell clustering.
const stories = [];
const storiesById = new Map();

// Each click gets its own dot — only stories at the EXACT same world
// point cluster (covers duplicate test data). Rebuilt whenever a new
// story arrives.
const STACK_THRESHOLD = 0.5;
let clusters = [];

function buildClusters() {
  // Preserve activeIdx + drag offset by anchor (wx, wy) where possible.
  const oldState = new Map();
  for (const c of clusters) {
    const key = `${Math.round(c.wx)},${Math.round(c.wy)}`;
    oldState.set(key, { activeIdx: c.activeIdx, dx: c.dx || 0, dy: c.dy || 0 });
  }
  clusters = [];
  for (const story of stories) {
    if (story.wx == null || story.wy == null) continue;
    let found = null;
    for (const c of clusters) {
      if (Math.hypot(c.wx - story.wx, c.wy - story.wy) < STACK_THRESHOLD) {
        found = c;
        break;
      }
    }
    if (found) {
      found.stories.push(story);
    } else {
      clusters.push({ stories: [story], activeIdx: 0, dx: 0, dy: 0, wx: story.wx, wy: story.wy });
    }
  }
  // Sort each cluster newest-first; restore prior state (clamped).
  for (const c of clusters) {
    c.stories.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    c.wx = c.stories[0].wx;
    c.wy = c.stories[0].wy;
    const key = `${Math.round(c.wx)},${Math.round(c.wy)}`;
    const prev = oldState.get(key);
    if (prev) {
      c.activeIdx = Math.min(prev.activeIdx, c.stories.length - 1);
      c.dx = prev.dx;
      c.dy = prev.dy;
    }
  }
}

// Peer cursor state (populated via socket events; declared up here to avoid TDZ issues
// since render() is called during init before the socket section is reached).
const peers = new Map();
let selfColor = null;

// Active in-progress drafts by peer socket id: { dotIndex, name, spot, story, color }
const liveDrafts = new Map();
// Exact world coords of the story currently being authored (or null).
let authoringWx = null;
let authoringWy = null;

// Whether any photos are visible and floating (drives continuous animation).
let hasPhotos = false;

// Socket — declared early so writer/draft code can reference it.
const socket = io();

function resize() {
  canvas.width = window.innerWidth * DPR;
  canvas.height = window.innerHeight * DPR;
  canvas.style.width = window.innerWidth + "px";
  canvas.style.height = window.innerHeight + "px";
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  render();
}

// Locked-in zoom-out floor: set once on page load (or on explicit fit) so
// the user can't zoom out past the initial "see all of NYC" view.
let _zoomFloor = MIN_SCALE;

// Default zoom is 1.23x of the natural fit-to-viewport scale, so the map
// Default zoom + centering match the ASCII version: load at s=4.5 with
// Manhattan anchored to the upper-right of the viewport so the intro
// panel in the upper-left has clear room and Brooklyn / Queens flow
// downward into view. _zoomFloor relaxes to the fit-the-whole-grid
// scale so users can still zoom out for the overview.
const DEFAULT_ZOOM = 4.5;

function fitToViewport() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const pad = 40;
  const fit = Math.min((W - pad * 2) / GRID_W, (H - pad * 2) / GRID_H);
  _zoomFloor = fit;
  view.scale = DEFAULT_ZOOM;
  const [manhattanWX, manhattanWY] = lonLatToWorld([-73.965, 40.789]);
  view.tx = W * 0.58 - manhattanWX * DEFAULT_ZOOM;
  view.ty = H * 0.18 - manhattanWY * DEFAULT_ZOOM;
  updateTier();
}

function updateTier() {
  const next =
    view.scale >= TIER_BLOCKS ? "BLOCKS" : view.scale >= TIER_BOROUGH ? "BOROUGH" : "CITY";
  if (next !== currentTier) {
    currentTier = next;
    console.log("tier:", currentTier, "scale:", view.scale.toFixed(2));
  }
}

// ---- data loading ----
async function loadStories() {
  const res = await fetch("/stories");
  const { stories } = await res.json();
  for (const s of stories) ingestStory(s);
  render();
}

function ingestStory(s) {
  // Skip duplicates if the same story arrives via /stories then story:commit.
  if (s._id && storiesById.has(s._id)) return;
  // Backward compat: derive wx/wy from dotIndex if missing (old DB rows).
  if ((s.wx == null || s.wy == null) && s.dotIndex != null) {
    const col = s.dotIndex % COLS;
    const row = Math.floor(s.dotIndex / COLS);
    s.wx = col * BASE_CELL + BASE_CELL / 2;
    s.wy = row * BASE_CELL + BASE_CELL / 2;
  }
  if (s._id) storiesById.set(s._id, s);
  stories.push(s);
  buildClusters();
  // If the story landed in water, snap to nearest land cell + persist.
  setTimeout(() => migrateIfInWater(s), 0);
  // Per-story prep happens lazily in renderStories the first time a story is drawn.
}

// Quick land check using the cell grid (independent of the borough polygon
// load state — the grid was generated from those polygons).
function _isOnLandCell(wx, wy) {
  const col = Math.floor(wx / BASE_CELL);
  const row = Math.floor(wy / BASE_CELL);
  if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return false;
  return NYC_GRID[row * COLS + col] === 1;
}

// Returns the world coords of the nearest land-cell center (brute-force scan
// of the 58×76 grid; ~4400 ops, runs fast).
function _nearestLandCellCenter(wx, wy) {
  let bestSq = Infinity, bestX = wx, bestY = wy;
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (NYC_GRID[row * COLS + col] !== 1) continue;
      const cx = col * BASE_CELL + BASE_CELL / 2;
      const cy = row * BASE_CELL + BASE_CELL / 2;
      const dsq = (cx - wx) * (cx - wx) + (cy - wy) * (cy - wy);
      if (dsq < bestSq) { bestSq = dsq; bestX = cx; bestY = cy; }
    }
  }
  return [bestX, bestY];
}

function migrateIfInWater(story) {
  if (story.wx == null || story.wy == null) return;
  if (_isOnLandCell(story.wx, story.wy)) return;
  const [nx, ny] = _nearestLandCellCenter(story.wx, story.wy);
  story.wx = nx;
  story.wy = ny;
  buildClusters();
  render();
  if (story._id) {
    fetch(`/story/${story._id}/position`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wx: nx, wy: ny }),
    }).catch((err) => console.warn("position migration failed:", err));
  }
}

// Lazily prepare a single story's Pretext layout, photo, and float physics.
// Each story now owns its own visual state (was per-dot before).
function ensureStoryPrepared(story) {
  if (story.prepared) return;
  // Single run of "name / spot / story" — Pretext handles the wrapping.
  // Skip empty pieces so old rows without a `spot` still render cleanly.
  const fullText = [story.name, story.spot, story.story]
    .filter((p) => p && String(p).trim())
    .join(" / ");
  story.prepared = prepareWithSegments(fullText, FONT);
  story.capW = null; // computed on first render via computeFullFitCap

  if (story.photo && !story.photoImg) {
    const img = new Image();
    img.src = story.photo;
    img.onload = () => {
      story.photoImg = img;
      story.photoBounds = computePhotoRowBounds(img);
      render();
      // If this is an unprocessed JPEG from before bg-removal existed,
      // run it through the segmenter in the background and persist.
      queuePhotoReprocess(story);
    };
  }

  // Photo motion offsets in SCREEN px relative to post-it center.
  if (!story.float) {
    story.float = {
      ox: (Math.random() - 0.5) * 8,
      oy: (Math.random() - 0.5) * 8,
      vx: (Math.random() > 0.5 ? 1 : -1) * 0.4,
      vy: (Math.random() > 0.5 ? 1 : -1) * 0.4,
    };
  }
  // Text block motion (vertical only, since text fills width).
  if (!story.textFloat) {
    story.textFloat = {
      oy: (Math.random() - 0.5) * 4,
      vy: (Math.random() > 0.5 ? 1 : -1) * 0.25,
    };
  }
}

// ============================================================================
// Vintage paper map background — progressive layers based on view.scale.
// Each lat/lon point is mapped onto the same world coordinate system as the
// hand-drawn dot grid (stretched to fit), so the map and dots share the same
// pan/zoom transform.
// ============================================================================
const MAP_WEST = -74.27, MAP_EAST = -73.68, MAP_SOUTH = 40.48, MAP_NORTH = 40.92;
const MAP_W_DEG = MAP_EAST - MAP_WEST;
const MAP_H_DEG = MAP_NORTH - MAP_SOUTH;
const MAP_GRID_W = COLS * BASE_CELL;   // world width  (696)
const MAP_GRID_H = ROWS * BASE_CELL;   // world height (912)

// Letterbox: real NYC is roughly square (~1.017 aspect at this latitude),
// so we fit its WIDTH to the grid and center it vertically. Without this
// the boroughs would be stretched ~32% taller than they should be.
const _MID_LAT_RAD = ((MAP_NORTH + MAP_SOUTH) / 2) * Math.PI / 180;
const MAP_NYC_ASPECT = MAP_W_DEG * Math.cos(_MID_LAT_RAD) / MAP_H_DEG;
const MAP_WIDTH = MAP_GRID_W;
const MAP_HEIGHT = MAP_WIDTH / MAP_NYC_ASPECT;
const MAP_TOP_PAD = (MAP_GRID_H - MAP_HEIGHT) / 2;

function lonLatToWorld([lon, lat]) {
  const fx = (lon - MAP_WEST) / MAP_W_DEG;
  const fy = (MAP_NORTH - lat) / MAP_H_DEG;
  return [fx * MAP_WIDTH, MAP_TOP_PAD + fy * MAP_HEIGHT];
}

const BOROUGH_FILLS = {
  "Manhattan":     "#e8c896",
  "Brooklyn":      "#cdd9a4",
  "Queens":        "#dabd84",
  "Bronx":         "#e0b094",
  "Staten Island": "#c4c89a",
};
const BOROUGH_LABEL_POINTS = {
  "Manhattan":     [-73.965, 40.789],
  "Brooklyn":      [-73.950, 40.650],
  "Queens":        [-73.815, 40.730],
  "Bronx":         [-73.865, 40.853],
  "Staten Island": [-74.135, 40.585],
};

// Layer thresholds in view.scale units. Map detail emerges as you zoom in.
const mapLayers = {
  boroughs:     { url: "/data/nyc-boroughs.geojson",      threshold: 0,    data: null },
  nta:          { url: "/data/nyc-neighborhoods.geojson", threshold: 1.3,  data: null },
  parks:        { url: "/data/nyc-parks.geojson",         threshold: 1.7,  data: null },
  streetsMajor: { url: "/data/nyc-streets-major.geojson", threshold: 2.5,  data: null },
  streetsAll:   { url: "/data/nyc-streets-all.geojson",   threshold: 5.0,  data: null },
};

// Pre-project geometry to world coords + compute bbox for fast culling.
function preprocessMapFeature(f) {
  if (!f.geometry) return null;
  const t = f.geometry.type;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function pt(p) {
    const w = lonLatToWorld(p);
    if (w[0] < minX) minX = w[0]; if (w[0] > maxX) maxX = w[0];
    if (w[1] < minY) minY = w[1]; if (w[1] > maxY) maxY = w[1];
    return w;
  }
  let world;
  if (t === "Polygon" || t === "MultiPolygon") {
    const polys = t === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    world = polys.map(poly => poly.map(ring => ring.map(pt)));
  } else if (t === "LineString") {
    world = f.geometry.coordinates.map(pt);
  } else if (t === "MultiLineString") {
    world = f.geometry.coordinates.map(line => line.map(pt));
  } else {
    return null;
  }
  return { type: t, properties: f.properties || {}, world, bbox: [minX, minY, maxX, maxY] };
}

async function loadMapLayer(name) {
  const layer = mapLayers[name];
  try {
    const res = await fetch(layer.url);
    const json = await res.json();
    const features = [];
    for (const f of json.features) {
      const pre = preprocessMapFeature(f);
      if (pre) features.push(pre);
    }
    layer.data = features;
    render();
  } catch (err) {
    console.warn("map layer load failed:", name, err);
  }
}

let _mapPaperPattern = null;
function ensureMapPaperPattern() {
  if (_mapPaperPattern) return;
  const tile = document.createElement("canvas");
  tile.width = tile.height = 110;
  const tx = tile.getContext("2d");
  const img = tx.createImageData(110, 110);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i + 0] = 90; img.data[i + 1] = 60; img.data[i + 2] = 25;
    img.data[i + 3] = Math.max(0, (Math.random() - 0.55) * 70);
  }
  tx.putImageData(img, 0, 0);
  _mapPaperPattern = ctx.createPattern(tile, "repeat");
}

function bboxIntersectsView(b, vb) {
  return !(b[2] < vb[0] || b[0] > vb[2] || b[3] < vb[1] || b[1] > vb[3]);
}

function tracePolygonFeature(feat) {
  ctx.beginPath();
  for (const poly of feat.world) {
    for (const ring of poly) {
      const [x0, y0] = ring[0];
      ctx.moveTo(view.tx + x0 * view.scale, view.ty + y0 * view.scale);
      for (let i = 1; i < ring.length; i++) {
        const [x, y] = ring[i];
        ctx.lineTo(view.tx + x * view.scale, view.ty + y * view.scale);
      }
      ctx.closePath();
    }
  }
}

function traceLineFeature(feat) {
  ctx.beginPath();
  if (feat.type === "LineString") {
    const ws = feat.world;
    ctx.moveTo(view.tx + ws[0][0] * view.scale, view.ty + ws[0][1] * view.scale);
    for (let i = 1; i < ws.length; i++) {
      ctx.lineTo(view.tx + ws[i][0] * view.scale, view.ty + ws[i][1] * view.scale);
    }
  } else {
    for (const line of feat.world) {
      ctx.moveTo(view.tx + line[0][0] * view.scale, view.ty + line[0][1] * view.scale);
      for (let i = 1; i < line.length; i++) {
        ctx.lineTo(view.tx + line[i][0] * view.scale, view.ty + line[i][1] * view.scale);
      }
    }
  }
}

function renderMapBackground() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const s = view.scale;

  // Aged paper background with radial gradient (lighter center).
  const bg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.15,
                                       W / 2, H / 2, Math.max(W, H) * 0.85);
  bg.addColorStop(0, "#f6eed8");
  bg.addColorStop(1, "#e3d4b0");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const vb = [-view.tx / s, -view.ty / s, (W - view.tx) / s, (H - view.ty) / s];

  // Borough fills (always)
  if (mapLayers.boroughs.data) {
    for (const f of mapLayers.boroughs.data) {
      if (!bboxIntersectsView(f.bbox, vb)) continue;
      tracePolygonFeature(f);
      ctx.fillStyle = BOROUGH_FILLS[f.properties.BoroName] || "#d8c8a8";
      ctx.fill();
    }
  }

  // Parks (s > 1.7)
  if (mapLayers.parks.data && s > mapLayers.parks.threshold) {
    ctx.fillStyle = "rgba(135, 165, 100, 0.55)";
    for (const f of mapLayers.parks.data) {
      if (!bboxIntersectsView(f.bbox, vb)) continue;
      tracePolygonFeature(f);
      ctx.fill();
    }
  }

  // NTA boundaries (s > 1.3) — dashed sepia
  if (mapLayers.nta.data && s > mapLayers.nta.threshold) {
    ctx.save();
    ctx.strokeStyle = "rgba(85, 50, 20, 0.30)";
    ctx.lineWidth = 0.5;
    ctx.setLineDash([3, 3]);
    for (const f of mapLayers.nta.data) {
      if (!bboxIntersectsView(f.bbox, vb)) continue;
      tracePolygonFeature(f);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Major streets (s > 2.5)
  if (mapLayers.streetsMajor.data && s > mapLayers.streetsMajor.threshold) {
    ctx.strokeStyle = "rgba(85, 50, 20, 0.50)";
    ctx.lineWidth = 1.4;
    ctx.lineCap = "round";
    for (const f of mapLayers.streetsMajor.data) {
      if (!bboxIntersectsView(f.bbox, vb)) continue;
      traceLineFeature(f);
      ctx.stroke();
    }
  }

  // All streets (s > 5)
  if (mapLayers.streetsAll.data && s > mapLayers.streetsAll.threshold) {
    ctx.strokeStyle = "rgba(85, 50, 20, 0.32)";
    ctx.lineWidth = 0.55;
    ctx.lineCap = "round";
    for (const f of mapLayers.streetsAll.data) {
      if (!bboxIntersectsView(f.bbox, vb)) continue;
      traceLineFeature(f);
      ctx.stroke();
    }
  }

  // Borough labels — always visible, slightly bigger when zoomed in.
  ctx.save();
  ctx.fillStyle = "rgba(75, 45, 20, 0.85)";
  const labelSize = Math.max(13, Math.min(22, 13 * s));
  ctx.font = `bold ${labelSize}px Georgia, "Times New Roman", serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const [name, lp] of Object.entries(BOROUGH_LABEL_POINTS)) {
    const [wx, wy] = lonLatToWorld(lp);
    const sx = view.tx + wx * s;
    const sy = view.ty + wy * s;
    if (sx < -100 || sx > W + 100 || sy < -50 || sy > H + 50) continue;
    ctx.fillText(name.toUpperCase(), sx, sy);
  }
  ctx.restore();

  // Paper grain overlay
  ensureMapPaperPattern();
  ctx.save();
  ctx.fillStyle = _mapPaperPattern;
  ctx.globalAlpha = 0.25;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // Vignette
  const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45,
                                       W / 2, H / 2, Math.max(W, H) * 0.85);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(50, 25, 5, 0.32)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
}

// ============================================================================
// Corkboard intro panel — fixed in screen space (does NOT pan or zoom).
// Sits at the top-left of the viewport with two pinned papers: a title
// and a personal note about what the project is.
// ============================================================================
const CORK_SX = 24;       // screen-space top-left position
const CORK_SY = 60;
const CORK_SW = 180;      // screen-space size (fixed, no scaling)
const CORK_SH = 410;      // taller now to fit the how-to paper

function renderCorkboard() {
  const sx = CORK_SX, sy = CORK_SY, sw = CORK_SW, sh = CORK_SH;

  ctx.save();

  // Cork board with drop shadow
  ctx.shadowColor = "rgba(0,0,0,0.4)";
  ctx.shadowBlur = 6;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = "#a87146";
  ctx.fillRect(sx, sy, sw, sh);
  ctx.shadowColor = "transparent";

  // Cork grain
  ensureMapPaperPattern();
  if (_mapPaperPattern) {
    ctx.save();
    ctx.fillStyle = _mapPaperPattern;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(sx, sy, sw, sh);
    ctx.restore();
  }

  // Dark wooden frame
  ctx.strokeStyle = "#3a2615";
  ctx.lineWidth = 2;
  ctx.strokeRect(sx + 1, sy + 1, sw - 2, sh - 2);

  // Title paper
  _drawCorkPaperFixed(sx + 18, sy + 12, 145, 50, -0.05, "#fef8df", [
    { text: "What's Your", size: 13, weight: "bold",        fam: "Georgia, serif" },
    { text: "NYC Story?",  size: 15, weight: "italic bold", fam: "Georgia, serif" },
  ]);

  // Personal note paper
  _drawCorkPaperFixed(sx + 12, sy + 76, 155, 142, 0.035, "#f4ebd4", [
    { text: "everyone has their",   size: 9 },
    { text: "own version of nyc —", size: 9 },
    { text: "on every corner,",     size: 9 },
    { text: "in every building.",   size: 9 },
    { text: "",                     size: 4 },
    { text: "we live in the same",  size: 9 },
    { text: "city, but is it",      size: 9 },
    { text: "really the same?",     size: 9 },
    { text: "",                     size: 4 },
    { text: "i'd love to know",     size: 9 },
    { text: "what nyc means to",    size: 9 },
    { text: "you, and what",        size: 9 },
    { text: "stories you hold.",    size: 9 },
  ]);

  // How-to paper
  _drawCorkPaperFixed(sx + 14, sy + 230, 152, 168, -0.03, "#ffeac9", [
    { text: "how to leave a",       size: 9, weight: "bold" },
    { text: "story:",               size: 9, weight: "bold" },
    { text: "",                     size: 4 },
    { text: "1. zoom in and click", size: 9 },
    { text: "   the spot where",    size: 9 },
    { text: "   your story lives.", size: 9 },
    { text: "",                     size: 3 },
    { text: "2. write your name,",  size: 9 },
    { text: "   the place, and",    size: 9 },
    { text: "   what happened.",    size: 9 },
    { text: "",                     size: 3 },
    { text: "3. take a quick",      size: 9 },
    { text: "   selfie.",           size: 9 },
    { text: "",                     size: 3 },
    { text: "4. hit 'leave your",   size: 9 },
    { text: "   story here.'",      size: 9 },
  ]);

  ctx.restore();
}

function _drawCorkPaperFixed(sx, sy, sw, sh, tilt, color, lines) {
  ctx.save();
  ctx.translate(sx + sw / 2, sy + sh / 2);
  ctx.rotate(tilt);

  // Paper with drop shadow
  ctx.shadowColor = "rgba(0,0,0,0.4)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = color;
  ctx.fillRect(-sw / 2, -sh / 2, sw, sh);
  ctx.shadowColor = "transparent";

  // Small pin at top center
  const pinR = 4;
  const pinColorIdx = (Math.round(sx + sy)) % PIN_PALETTE.length;
  drawPin(0, -sh / 2 + pinR + 2, pinR, PIN_PALETTE[pinColorIdx], 1);

  // Text lines (vertically centered, fixed font sizes)
  ctx.fillStyle = "rgba(50, 30, 10, 0.92)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  let totalH = 0;
  for (const ln of lines) totalH += ln.size * 1.25;
  let y = -totalH / 2;
  for (const ln of lines) {
    const lineH = ln.size * 1.25;
    if (ln.text) {
      const weight = ln.weight ? ln.weight + " " : "";
      const fam = ln.fam || "ui-monospace, monospace";
      ctx.font = `${weight}${ln.size}px ${fam}`;
      ctx.fillText(ln.text, 0, y + lineH / 2);
    }
    y += lineH;
  }
  ctx.restore();
}

// ---- render ----
function render() {
  const W = window.innerWidth;
  const H = window.innerHeight;

  renderMapBackground();

  const s = view.scale;

  const worldMinX = -view.tx / s;
  const worldMinY = -view.ty / s;
  const worldMaxX = worldMinX + W / s;
  const worldMaxY = worldMinY + H / s;
  const colMin = Math.max(0, Math.floor(worldMinX / BASE_CELL) - 1);
  const colMax = Math.min(COLS, Math.ceil(worldMaxX / BASE_CELL) + 1);
  const rowMin = Math.max(0, Math.floor(worldMinY / BASE_CELL) - 1);
  const rowMax = Math.min(ROWS, Math.ceil(worldMaxY / BASE_CELL) + 1);

  // No empty-dot grid anymore — pins and post-its are placed at the exact
  // world coordinates of each click, so there's no underlying grid to draw.
  renderStories();

  renderDrafts();
  renderPeerCursors();

  // Corkboard intro panel — drawn last so it overlays everything except HUD.
  renderCorkboard();

  // HUD.
  ctx.fillStyle = "rgba(75, 45, 20, 0.7)";
  ctx.font = `11px ${FONT_FAMILY}`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillText(`${currentTier}  ·  ${s.toFixed(2)}x  ·  ${stories.length} stories`, 12, H - 14);

  // Keep the comments panel glued to its post-it as the user pans / zooms.
  if (typeof syncCommentsPosition === "function") syncCommentsPosition();
}

// Photo thumbnail size (screen px).
const PHOTO_SIZE = 70;
const PHOTO_ALPHA_THRESHOLD = 30;   // pixels with alpha above this count as "figure"

// Pre-compute per-row left/right opaque bounds of a photo's alpha channel,
// so text can flow around the actual figure silhouette (not just the bbox).
// Returns an array of length PHOTO_SIZE; each entry is null (empty row) or
// { leftX, rightX } in photo-local pixel coords.
function computePhotoRowBounds(img) {
  const c = document.createElement("canvas");
  c.width = c.height = PHOTO_SIZE;
  const cx = c.getContext("2d");
  cx.drawImage(img, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
  const data = cx.getImageData(0, 0, PHOTO_SIZE, PHOTO_SIZE).data;
  const out = new Array(PHOTO_SIZE);
  for (let y = 0; y < PHOTO_SIZE; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < PHOTO_SIZE; x++) {
      if (data[(y * PHOTO_SIZE + x) * 4 + 3] > PHOTO_ALPHA_THRESHOLD) {
        if (l === -1) l = x;
        r = x;
      }
    }
    out[y] = l === -1 ? null : { leftX: l, rightX: r };
  }
  return out;
}

// Returns the union of opaque-pixel x-bounds across the rows that overlap a
// text line spanning [lineY, lineY + lineH] (post-it local coords). Returns
// null if the line doesn't overlap any opaque rows.
function getPhotoOccupiedRange(bounds, photoX, photoY, lineY, lineH) {
  const yStart = Math.max(0, Math.floor(lineY - photoY));
  const yEnd = Math.min(PHOTO_SIZE, Math.ceil(lineY + lineH - photoY));
  if (yEnd <= yStart) return null;
  let leftX = Infinity, rightX = -Infinity;
  for (let y = yStart; y < yEnd; y++) {
    const b = bounds[y];
    if (!b) continue;
    if (b.leftX < leftX) leftX = b.leftX;
    if (b.rightX > rightX) rightX = b.rightX;
  }
  if (leftX === Infinity) return null;
  return { pLeft: photoX + leftX - 2, pRight: photoX + rightX + 2 };
}

// Cache character widths to avoid expensive measureText calls every frame.
const charWidthCache = new Map();
function getCharWidth(ch) {
  let w = charWidthCache.get(ch);
  if (w === undefined) {
    w = ctx.measureText(ch).width;
    charWidthCache.set(ch, w);
  }
  return w;
}

// Deterministic [0,1) per-story noise seeded by id (or timestamp as fallback).
function storySeed(story) {
  const key = String(story._id || story.timestamp || 0);
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

// Per-render list of clickable arrow buttons (for cycling stacked clusters).
const clusterArrowHits = [];
const ARROW_HIT_RADIUS = 12;

function renderStories() {
  const s = view.scale;
  hasPhotos = false;
  clusterArrowHits.length = 0;
  // Clear last-frame box rects; only clusters whose post-it actually
  // renders this frame will get a fresh one set below. Used by
  // syncCommentsPosition() to track the panel against its post-it.
  for (const c of clusters) c._boxRect = null;

  ctx.font = FONT;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  // View bbox in world coords (with a small margin) for off-screen culling.
  const W = window.innerWidth, H = window.innerHeight;
  const vbMinX = -view.tx / s - 60;
  const vbMaxX = (W - view.tx) / s + 60;
  const vbMinY = -view.ty / s - 60;
  const vbMaxY = (H - view.ty) / s + 60;

  const pinAlpha = clamp(
    1 - (s - PIN_FADE_START) / (PIN_FADE_END - PIN_FADE_START), 0, 1);
  const postitVisible = s >= POSTIT_FADE_START;
  const pinScreenR = clamp(PIN_RADIUS_WORLD * s, PIN_RADIUS_MIN_SCREEN, PIN_RADIUS_MAX_SCREEN);
  const topPinR = clamp(s * 0.7, POSTIT_TOP_PIN_R_MIN, POSTIT_TOP_PIN_R_MAX);

  // Post-it grows linearly across the entire visible zoom range:
  // size = LINE_HEIGHT at POSTIT_FADE_START → POSTIT_MAX_INNER at MAX_SCALE.
  const _t = clamp((s - POSTIT_FADE_START) / (MAX_SCALE - POSTIT_FADE_START), 0, 1);
  const innerMax = LINE_HEIGHT + _t * (POSTIT_MAX_INNER - LINE_HEIGHT);

  // ---- Pass 1: pins (under the post-its + above the map) ----
  for (let ci = 0; ci < clusters.length; ci++) {
    const cluster = clusters[ci];
    const effectiveWx = cluster.wx + (cluster.dx || 0);
    const effectiveWy = cluster.wy + (cluster.dy || 0);
    if (effectiveWx < vbMinX || effectiveWx > vbMaxX) continue;
    if (effectiveWy < vbMinY || effectiveWy > vbMaxY) continue;

    const story = cluster.stories[cluster.activeIdx] || cluster.stories[0];
    if (!story) continue;

    const cx = view.tx + effectiveWx * s;
    const cy = view.ty + effectiveWy * s;
    const seed = storySeed(story);
    // Match the formula used for the top-pin on the rendered post-it (pass 2)
    // so the same story's pin keeps the same color across zoom levels.
    const pinPaletteIdx = Math.floor(((seed * 13.7) % 1) * PIN_PALETTE.length);
    if (pinAlpha > 0) {
      drawPin(cx, cy, pinScreenR, PIN_PALETTE[pinPaletteIdx], pinAlpha);
    }
  }

  // ---- Pass 2: post-its (always above pins so overlapping pins from other
  // clusters never bleed onto a card) ----
  if (!postitVisible) return;

  for (let ci = 0; ci < clusters.length; ci++) {
    const cluster = clusters[ci];
    const effectiveWx = cluster.wx + (cluster.dx || 0);
    const effectiveWy = cluster.wy + (cluster.dy || 0);
    if (effectiveWx < vbMinX || effectiveWx > vbMaxX) continue;
    if (effectiveWy < vbMinY || effectiveWy > vbMaxY) continue;

    const story = cluster.stories[cluster.activeIdx] || cluster.stories[0];
    if (!story) continue;

    const cx = view.tx + effectiveWx * s;
    const cy = view.ty + effectiveWy * s;

    const seed = storySeed(story);
    const tilt = (seed - 0.5) * 2 * POSTIT_MAX_ROT;
    const colorIdx = Math.floor(((seed * 7.31) % 1) * POSTIT_COLORS.length);
    const postitColor = POSTIT_COLORS[colorIdx];
    const topPinColor = PIN_PALETTE[Math.floor(((seed * 13.7) % 1) * PIN_PALETTE.length)];

    ensureStoryPrepared(story);
    story.boxW = innerMax;
    story.boxH = innerMax;

    const showPhoto = story.photoImg && story.boxW > PHOTO_SIZE + 20;
    if (showPhoto) hasPhotos = true;
    // Even without a photo we want the render loop running so text drifts.
    hasPhotos = hasPhotos || true;

    const postitFullW = story.boxW + POSTIT_PAD * 2;
    const postitFullH = story.boxH + POSTIT_PAD * 2;

    // Underneath post-its (the rest of the stack) peek out at small random
    // offsets behind the active one — paper backdrops only, no content.
    if (cluster.stories.length > 1) {
      const stackToShow = Math.min(3, cluster.stories.length - 1);
      const offsetMag = postitFullW * 0.06;
      for (let d = stackToShow; d >= 1; d--) {
        const otherIdx = (cluster.activeIdx + d) % cluster.stories.length;
        const otherStory = cluster.stories[otherIdx];
        const oSeed = storySeed(otherStory);
        const oTilt = (oSeed - 0.5) * 2 * POSTIT_MAX_ROT;
        const oCol = POSTIT_COLORS[Math.floor(((oSeed * 7.31) % 1) * POSTIT_COLORS.length)];
        const oOx = (((oSeed * 13.7) % 1) - 0.5) * offsetMag * 2 * d;
        const oOy = (((oSeed * 23.1) % 1) - 0.5) * offsetMag * 2 * d;
        ctx.save();
        ctx.translate(cx + oOx, cy + oOy);
        ctx.rotate(oTilt);
        drawPostitBackdrop(postitFullW, postitFullH, oCol, 1);
        ctx.restore();
      }
    }

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(tilt);

    drawPostitBackdrop(postitFullW, postitFullH, postitColor, 1);

    // Clip everything that follows (photo + text) to the post-it's INNER
    // area so it can never bleed past the paper edge.
    ctx.save();
    ctx.beginPath();
    ctx.rect(-story.boxW / 2, -story.boxH / 2, story.boxW, story.boxH);
    ctx.clip();

    // Photo physics: bounds in screen px relative to post-it center.
    let photoLocalX = 0, photoLocalY = 0;
    if (showPhoto) {
      const f = story.float;
      const maxOx = (story.boxW - PHOTO_SIZE) / 2 - 4;
      const maxOy = (story.boxH - PHOTO_SIZE) / 2 - 4;
      if (maxOx > 0 && maxOy > 0) {
        f.ox += f.vx;
        f.oy += f.vy;
        if (f.ox < -maxOx || f.ox > maxOx) { f.vx *= -1; f.ox = clamp(f.ox, -maxOx, maxOx); }
        if (f.oy < -maxOy || f.oy > maxOy) { f.vy *= -1; f.oy = clamp(f.oy, -maxOy, maxOy); }
      } else {
        f.ox = 0; f.oy = 0;
      }
      photoLocalX = f.ox - PHOTO_SIZE / 2;
      photoLocalY = f.oy - PHOTO_SIZE / 2;
      ctx.drawImage(story.photoImg, photoLocalX, photoLocalY, PHOTO_SIZE, PHOTO_SIZE);
    }

    // Text layout (Pretext).
    const maxLines = Math.max(1, Math.floor(story.boxH / LINE_HEIGHT));
    const lines = [];
    walkLineRanges(story.prepared, story.boxW, (line) => {
      if (lines.length < maxLines) lines.push(materializeLineRange(story.prepared, line));
    });
    const blockH = lines.length * LINE_HEIGHT;

    // Text stays put (only photos drift).
    const textBlockLeft = -story.boxW / 2;
    let y = -blockH / 2;

    ctx.fillStyle = "rgba(40,40,40,0.95)";
    ctx.font = FONT;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";

    for (const line of lines) {
      // Per-line obstacle: prefer the photo's actual silhouette (alpha
      // bounds) when available; fall back to the bbox for old JPEG photos
      // and during the brief moment between photo load and bounds compute.
      let pLeft = null, pRight = null;
      if (showPhoto) {
        if (story.photoBounds) {
          const r = getPhotoOccupiedRange(story.photoBounds, photoLocalX,
                                          photoLocalY, y, LINE_HEIGHT);
          if (r) { pLeft = r.pLeft; pRight = r.pRight; }
        } else if (y + LINE_HEIGHT > photoLocalY && y < photoLocalY + PHOTO_SIZE) {
          pLeft = photoLocalX - 2;
          pRight = photoLocalX + PHOTO_SIZE + 2;
        }
      }

      let lx = textBlockLeft;
      if (pLeft != null) {
        let inRightRegion = false;
        for (const ch of line.text) {
          const cw = getCharWidth(ch);
          if (!inRightRegion && lx + cw > pLeft) {
            lx = pRight;
            inRightRegion = true;
          }
          ctx.fillText(ch, lx, y);
          lx += cw;
        }
      } else {
        for (const ch of line.text) {
          const cw = getCharWidth(ch);
          ctx.fillText(ch, lx, y);
          lx += cw;
        }
      }
      y += LINE_HEIGHT;
    }

    // Arrow + count rendered as text (still inside clip — FONT + style match
    // the body text exactly, so it reads as one continuous typographic system).
    if (cluster.stories.length > 1) {
      const labelRight = story.boxW / 2 - 2;
      const labelBottom = story.boxH / 2 - 2;
      const aabb = drawArrowLabel(labelRight, labelBottom,
                                  cluster.stories.length, cluster.activeIdx);
      clusterArrowHits.push({ cluster, cx, cy, tilt, aabb });
    }

    ctx.restore();  // exit clip — pin lives at the post-it's edge

    // Top ball-head pin holding the post-it down.
    const pinTopY = -postitFullH / 2 + topPinR + 2;
    drawPin(0, pinTopY, topPinR, topPinColor, 1);

    ctx.restore();

    // Stash the unrotated AABB on the cluster so the comments panel can
    // anchor below this post-it. Tilt is small (~5°) so this matches the
    // visible bottom edge closely.
    cluster._boxRect = {
      x: cx - postitFullW / 2,
      y: cy - postitFullH / 2,
      w: postitFullW,
      h: postitFullH,
    };
  }
}

// Renders the "n/N →" indicator as plain monospace text (using FONT, the
// same as the story body) so it blends in seamlessly. Returns the AABB of
// the rendered text in the local rotated frame, for click hit-testing.
function drawArrowLabel(rightX, bottomY, total, currentIdx) {
  const label = `${currentIdx + 1}/${total} →`;
  ctx.fillStyle = "rgba(40,40,40,0.95)";
  ctx.font = FONT;
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText(label, rightX, bottomY);
  const w = ctx.measureText(label).width;
  return { x: rightX - w, y: bottomY - LINE_HEIGHT, w, h: LINE_HEIGHT };
}

// Returns true if the screen click hit any arrow label; advances that
// cluster's activeIdx and re-renders. Hit area is the label's AABB
// (slightly inflated so finger taps work) in the rotated post-it frame.
function handleArrowClick(sx, sy) {
  const PAD = 4;
  for (const a of clusterArrowHits) {
    const dx = sx - a.cx;
    const dy = sy - a.cy;
    const c = Math.cos(a.tilt), si = Math.sin(a.tilt);
    const lx = dx * c + dy * si;
    const ly = -dx * si + dy * c;
    const b = a.aabb;
    if (lx >= b.x - PAD && lx <= b.x + b.w + PAD &&
        ly >= b.y - PAD && ly <= b.y + b.h + PAD) {
      a.cluster.activeIdx = (a.cluster.activeIdx + 1) % a.cluster.stories.length;
      render();
      return true;
    }
  }
  return false;
}

// Draws any in-progress drafts from peers as "live text" inside their target dots,
// with a pulsing ring to show someone is writing right there.
function renderDrafts() {
  const s = view.scale;
  const cellScreen = BASE_CELL * s;
  const now = performance.now();
  const pulse = 0.5 + 0.5 * Math.sin(now / 400);

  for (const [id, d] of liveDrafts) {
    // Backward compat: derive wx/wy from dotIndex if a peer is on an old client.
    let wx = d.wx, wy = d.wy;
    if ((wx == null || wy == null) && d.dotIndex != null) {
      const col = d.dotIndex % COLS;
      const row = Math.floor(d.dotIndex / COLS);
      wx = col * BASE_CELL + BASE_CELL / 2;
      wy = row * BASE_CELL + BASE_CELL / 2;
    }
    if (wx == null) continue;
    const cx = view.tx + wx * s;
    const cy = view.ty + wy * s;

    // Pulse ring around the dot.
    const ringR = 8 + pulse * 6;
    ctx.strokeStyle = d.color || "#fff";
    ctx.globalAlpha = 0.3 + 0.4 * pulse;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Draft text — same "name / spot / story" format as committed posts.
    const text = [d.name, d.spot, d.story]
      .filter((p) => p && String(p).trim())
      .join(" / ");
    if (!text) continue;
    const prepared = prepareWithSegments(text, FONT);
    const rawBox = cellScreen * 1.8;
    const cap = computeFullFitCap(prepared);
    const boxW = Math.min(Math.max(rawBox, 30), cap.w);
    const boxH = Math.min(Math.max(rawBox, LINE_HEIGHT), cap.h);
    const maxLines = Math.max(1, Math.floor(boxH / LINE_HEIGHT));
    const lines = [];
    walkLineRanges(prepared, boxW, (line) => {
      if (lines.length < maxLines) lines.push(materializeLineRange(prepared, line));
    });

    ctx.font = FONT;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillStyle = d.color || "#e8e8e8";
    const blockH = lines.length * LINE_HEIGHT;
    let y = cy - blockH / 2;
    for (const line of lines) {
      ctx.fillText(line.text, cx - boxW / 2, y);
      y += LINE_HEIGHT;
    }
  }

}

function renderPeerCursors() {
  const s = view.scale;
  for (const p of peers.values()) {
    if (p.wx === undefined) continue;
    const sx = view.tx + p.wx * s;
    const sy = view.ty + p.wy * s;
    // small triangle cursor
    ctx.fillStyle = p.color || "#fff";
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + 10, sy + 4);
    ctx.lineTo(sx + 4, sy + 10);
    ctx.closePath();
    ctx.fill();
  }
}

// Find a box width where the text wraps into a roughly square block
// (height ≈ width). That's the point past which we stop growing the footprint.
function computeFullFitCap(prepared) {
  // Natural width = widest forced line. Start there and tighten toward square.
  const natural = measureNaturalWidth(prepared);
  // Try candidate widths and pick the one whose (lines × lineHeight) is closest to width.
  let best = { w: Math.max(60, natural), h: LINE_HEIGHT, score: Infinity };
  for (let w = 60; w <= Math.max(200, natural + 20); w += 10) {
    let lineCount = 0;
    walkLineRanges(prepared, w, () => lineCount++);
    const h = lineCount * LINE_HEIGHT;
    const score = Math.abs(w - h); // square = 0
    if (score < best.score) best = { w, h, score };
  }
  return best;
}

function clamp(v, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, v));
}

// ---- post-it helpers ----

// Deterministic pseudo-random in [0, 1) from any integer seed.
function postitNoise(seed) {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// Stable per-dot { angle, color }. Each dot keeps the same paper color and
// tilt across renders — driven entirely by its grid index.
function postitParams(idx) {
  const angle = (postitNoise(idx) - 0.5) * 2 * POSTIT_MAX_ROT;
  const colorIdx = Math.floor(postitNoise(idx + 9173) * POSTIT_COLORS.length);
  return { angle, color: POSTIT_COLORS[colorIdx] };
}

// Place N post-its on an integer grid: index 0 at the center (0, 0); each
// subsequent post-it is placed adjacent (up/down/left/right) to a randomly-
// picked already-placed one. Deterministic per dot. Grows outward from the
// center, no two cells ever collide.
function generatePostitPositions(dotIdx, N) {
  if (N === 0) return [];
  const positions = [{ col: 0, row: 0 }];
  const occupied = new Set(["0,0"]);
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];   // up, right, down, left
  for (let i = 1; i < N; i++) {
    let placed = false;
    for (let attempt = 0; attempt < 100 && !placed; attempt++) {
      const seed = dotIdx * 9173 + i * 137 + attempt * 31;
      const parent = positions[Math.floor(postitNoise(seed) * positions.length)];
      const [dx, dy] = dirs[Math.floor(postitNoise(seed + 1) * 4)];
      const newPos = { col: parent.col + dx, row: parent.row + dy };
      const key = `${newPos.col},${newPos.row}`;
      if (!occupied.has(key)) {
        positions.push(newPos);
        occupied.add(key);
        placed = true;
      }
    }
    if (!placed) {
      // Fallback: scan every existing cell for any empty neighbor (handles
      // pathological cases where random retries kept hitting occupied cells).
      outer: for (const p of positions) {
        for (const [dx, dy] of dirs) {
          const np = { col: p.col + dx, row: p.row + dy };
          const k = `${np.col},${np.row}`;
          if (!occupied.has(k)) {
            positions.push(np);
            occupied.add(k);
            break outer;
          }
        }
      }
    }
  }
  return positions;
}

// Pre-baked subtle paper-grain pattern. Built lazily once the canvas ctx is
// ready, then reused for every post-it backdrop via createPattern.
let paperPattern = null;
function ensurePaperPattern() {
  if (paperPattern) return;
  const tile = document.createElement("canvas");
  tile.width = tile.height = 80;
  const tx = tile.getContext("2d");
  const img = tx.createImageData(80, 80);
  for (let i = 0; i < img.data.length; i += 4) {
    // dark grit at low alpha, randomly placed
    img.data[i + 0] = 30;
    img.data[i + 1] = 25;
    img.data[i + 2] = 15;
    img.data[i + 3] = Math.max(0, (Math.random() - 0.6) * 60);
  }
  tx.putImageData(img, 0, 0);
  paperPattern = ctx.createPattern(tile, "repeat");
}

// ---- pin-head helpers ----

// Stable per-pin world-coordinate offset from a dot center. Pin 0 sits very
// near center; subsequent pins fan out at random angles + sqrt-scaled
// distances within PIN_CLUSTER_RADIUS_WORLD. Indexing means new pins land in
// new spots without reshuffling existing ones.
function pinOffsetWorld(dotIdx, pinIndex) {
  const seed = dotIdx * 9173 + pinIndex * 31;
  if (pinIndex === 0) {
    return [(postitNoise(seed)     - 0.5) * 0.6,
            (postitNoise(seed + 1) - 0.5) * 0.6];
  }
  const angle = postitNoise(seed) * Math.PI * 2;
  const distance = PIN_CLUSTER_RADIUS_WORLD * Math.sqrt(postitNoise(seed + 1));
  return [Math.cos(angle) * distance, Math.sin(angle) * distance];
}

// Stable color choice per pin from the palette.
function pinColor(dotIdx, pinIndex) {
  return PIN_PALETTE[Math.floor(
    postitNoise(dotIdx * 9173 + pinIndex * 17 + 991) * PIN_PALETTE.length)];
}

// Draws one 3D-shaded pin sphere at (sx, sy) with screen radius sr. Highlight
// is offset to the upper-left; the dark rim of the radial gradient does the
// edge work without needing a separate stroke or drop-shadow outline.
function drawPin(sx, sy, sr, color, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;

  const offset = sr * 0.36;
  const grad = ctx.createRadialGradient(
    sx - offset, sy - offset, 0,
    sx, sy, sr * 1.05,
  );
  grad.addColorStop(0.00, "rgba(255,255,255,0.95)");
  grad.addColorStop(0.22, color.light);
  grad.addColorStop(0.55, color.mid);
  grad.addColorStop(1.00, color.dark);

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(sx, sy, sr, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Draws the post-it rectangle (with shadow + paper texture) at the current
// transform's origin. Caller is responsible for translate/rotate/save/restore.
function drawPostitBackdrop(w, h, color, alpha) {
  ensurePaperPattern();
  const x = -w / 2, y = -h / 2;

  // Drop shadow on the paper rect itself.
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = "rgba(0,0,0,0.28)";
  ctx.shadowBlur = Math.max(6, w * 0.10);
  ctx.shadowOffsetX = w * 0.03;
  ctx.shadowOffsetY = w * 0.06;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  ctx.restore();

  // Paper grain on top (no shadow).
  if (paperPattern) {
    ctx.save();
    ctx.globalAlpha = alpha * 0.45;
    ctx.fillStyle = paperPattern;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
}

// ---- input ----
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
  },
  { passive: false }
);

function zoomAt(sx, sy, factor) {
  const newScale = Math.max(_zoomFloor, Math.min(MAX_SCALE, view.scale * factor));
  const actual = newScale / view.scale;
  view.tx = sx - (sx - view.tx) * actual;
  view.ty = sy - (sy - view.ty) * actual;
  view.scale = newScale;
  updateTier();
  render();
}

const pointers = new Map();
let pinchStartDist = 0;
let pinchStartScale = 1;
let pinchCenter = null;

// Track pointer-down origin so we can distinguish click (tap) from drag-pan.
const pointerDown = new Map(); // id -> { x0, y0, moved, dragCluster, dragInitialDx, dragInitialDy }

// Returns the cluster the screen point falls inside (active post-it bounds,
// accounting for tilt + drag offset), or null. Only when post-its are visible.
function _hitTestPostit(sx, sy) {
  const s = view.scale;
  if (s < POSTIT_FADE_START) return null;
  const _t = clamp((s - POSTIT_FADE_START) / (MAX_SCALE - POSTIT_FADE_START), 0, 1);
  const innerMax = LINE_HEIGHT + _t * (POSTIT_MAX_INNER - LINE_HEIGHT);
  const halfFull = (innerMax + POSTIT_PAD * 2) / 2;
  for (const cluster of clusters) {
    const story = cluster.stories[cluster.activeIdx] || cluster.stories[0];
    if (!story) continue;
    const cx = view.tx + (cluster.wx + (cluster.dx || 0)) * s;
    const cy = view.ty + (cluster.wy + (cluster.dy || 0)) * s;
    const seed = storySeed(story);
    const tilt = (seed - 0.5) * 2 * POSTIT_MAX_ROT;
    const dx = sx - cx, dy = sy - cy;
    const c = Math.cos(tilt), si = Math.sin(tilt);
    const lx = dx * c + dy * si;
    const ly = -dx * si + dy * c;
    if (lx >= -halfFull && lx <= halfFull && ly >= -halfFull && ly <= halfFull) {
      return cluster;
    }
  }
  return null;
}

// Returns the cluster whose arrow region the screen point falls in, or null.
// Doesn't fire the cycle action — just identifies. Used to prioritize arrow
// clicks over starting a drag.
function _arrowClusterAt(sx, sy) {
  const PAD = 4;
  for (const a of clusterArrowHits) {
    const dx = sx - a.cx;
    const dy = sy - a.cy;
    const c = Math.cos(a.tilt), si = Math.sin(a.tilt);
    const lx = dx * c + dy * si;
    const ly = -dx * si + dy * c;
    const b = a.aabb;
    if (lx >= b.x - PAD && lx <= b.x + b.w + PAD &&
        ly >= b.y - PAD && ly <= b.y + b.h + PAD) {
      return a.cluster;
    }
  }
  return null;
}

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const pd = { x0: e.clientX, y0: e.clientY, moved: false, dragCluster: null };
  pointerDown.set(e.pointerId, pd);

  // Single-pointer + post-it body (not arrow) → arm a potential drag. The
  // drag only activates if the user actually moves, so a tap still falls
  // through to the click handler (which can open the writer or cycle arrow).
  if (pointers.size === 1 && !_arrowClusterAt(e.clientX, e.clientY)) {
    const cluster = _hitTestPostit(e.clientX, e.clientY);
    if (cluster) {
      pd.dragCluster = cluster;
      pd.dragInitialDx = cluster.dx || 0;
      pd.dragInitialDy = cluster.dy || 0;
    }
  }

  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
    pinchStartScale = view.scale;
    pinchCenter = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    // Cancel any pending drag if user starts pinching.
    for (const p of pointerDown.values()) p.dragCluster = null;
  }
});

canvas.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  const curr = { x: e.clientX, y: e.clientY };
  pointers.set(e.pointerId, curr);
  const pd = pointerDown.get(e.pointerId);
  if (pd) {
    const dx = curr.x - pd.x0;
    const dy = curr.y - pd.y0;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) pd.moved = true;
  }
  if (pointers.size === 1) {
    if (pd && pd.dragCluster && pd.moved) {
      // Dragging a post-it: update its in-memory offset (lost on refresh).
      const ddx = curr.x - pd.x0;
      const ddy = curr.y - pd.y0;
      pd.dragCluster.dx = pd.dragInitialDx + ddx / view.scale;
      pd.dragCluster.dy = pd.dragInitialDy + ddy / view.scale;
      render();
      return;
    }
    view.tx += curr.x - prev.x;
    view.ty += curr.y - prev.y;
    render();
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const factor = (dist / pinchStartDist) * (pinchStartScale / view.scale);
    zoomAt(pinchCenter.x, pinchCenter.y, factor);
  }
});

function endPointer(e) {
  const pd = pointerDown.get(e.pointerId);
  pointers.delete(e.pointerId);
  pointerDown.delete(e.pointerId);
  if (pointers.size < 2) pinchCenter = null;
  // If a drag was active, suppress the click (so the writer doesn't pop).
  if (pd && pd.dragCluster && pd.moved) return;
  // Treat as a click if the pointer barely moved AND no pinch was active.
  if (pd && !pd.moved && pointers.size === 0) {
    handleCanvasClick(e.clientX, e.clientY);
  }
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("pointerleave", endPointer);

// ---- click to write ----
// Standard ray-casting point-in-polygon test on a single ring.
function _pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// True if the world-space point is inside any NYC borough polygon. Falls
// back to the grid cell check while borough data is still loading.
function isOnLand(wx, wy) {
  if (!mapLayers.boroughs.data) {
    const col = Math.floor(wx / BASE_CELL);
    const row = Math.floor(wy / BASE_CELL);
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return false;
    return NYC_GRID[row * COLS + col] === 1;
  }
  for (const f of mapLayers.boroughs.data) {
    if (wx < f.bbox[0] || wx > f.bbox[2] || wy < f.bbox[1] || wy > f.bbox[3]) continue;
    // Each f.world is an array of polygons; each polygon is [outer, ...holes].
    for (const poly of f.world) {
      if (!_pointInRing(wx, wy, poly[0])) continue;
      let inHole = false;
      for (let i = 1; i < poly.length; i++) {
        if (_pointInRing(wx, wy, poly[i])) { inHole = true; break; }
      }
      if (!inHole) return true;
    }
  }
  return false;
}

// Inline confirmation overlay (matches the writer's design).
const writerConfirm = document.getElementById("writer-confirm");
const writerConfirmYes = document.getElementById("writer-confirm-yes");
const writerConfirmNo = document.getElementById("writer-confirm-no");
let _confirmActive = false;

function askConfirmClose() {
  if (_confirmActive) return Promise.resolve(false);
  _confirmActive = true;
  writerConfirm.hidden = false;
  return new Promise((resolve) => {
    function cleanup() {
      _confirmActive = false;
      writerConfirm.hidden = true;
      writerConfirmYes.removeEventListener("click", onYes);
      writerConfirmNo.removeEventListener("click", onNo);
    }
    function onYes() { cleanup(); resolve(true); }
    function onNo()  { cleanup(); resolve(false); }
    writerConfirmYes.addEventListener("click", onYes);
    writerConfirmNo.addEventListener("click", onNo);
  });
}

async function handleCanvasClick(sx, sy) {
  // If the writer popup is open, an outside-click closes it. If the user
  // already typed/captured anything, confirm before discarding.
  if (!writerEl.hidden) {
    if (_confirmActive) return;  // confirm overlay already showing
    const hasContent =
      writerName.value.trim() || writerSpot.value.trim() ||
      writerStory.value.trim() || capturedPhoto;
    if (hasContent) {
      const ok = await askConfirmClose();
      if (!ok) return;
    }
    closeWriter(true);
    return;
  }
  // Arrow buttons on stacked post-its take priority.
  if (handleArrowClick(sx, sy)) return;
  // Click landed on a post-it → open the comments panel for it.
  const hitCluster = _hitTestPostit(sx, sy);
  if (hitCluster) {
    openComments(hitCluster, sx, sy);
    return;
  }
  // If the comments panel is open, an outside-click should ONLY close it.
  if (!commentsEl.hidden) {
    closeComments();
    return;
  }
  // Block clicks on the corkboard intro panel — fixed-position screen rect
  // at (CORK_SX, CORK_SY) with size (CORK_SW × CORK_SH); nothing to do
  // when the user taps it.
  if (sx >= CORK_SX && sx <= CORK_SX + CORK_SW &&
      sy >= CORK_SY && sy <= CORK_SY + CORK_SH) return;
  // Otherwise place a new pin at the exact click coords — only on land.
  const w = screenToWorld(sx, sy);
  if (!isOnLand(w.x, w.y)) return;
  openWriter(w.x, w.y, sx, sy);
}

const writerEl = document.getElementById("writer");
const writerLoc = document.getElementById("writer-loc");
const writerName = document.getElementById("writer-name");
const writerSpot = document.getElementById("writer-spot");
const writerStory = document.getElementById("writer-story");
const writerClose = document.getElementById("writer-close");
const writerSubmit = document.getElementById("writer-submit");

// ---- camera ----
const cameraPreview = document.getElementById("camera-preview");
const cameraSnap = document.getElementById("camera-snap");
const cameraThumb = document.getElementById("camera-thumb");
const btnCapture = document.getElementById("btn-capture");
const btnRetake = document.getElementById("btn-retake");
let cameraStream = null;
let capturedPhoto = null; // base64 string

async function startCamera() {
  capturedPhoto = null;
  cameraThumb.hidden = true;
  btnRetake.hidden = true;
  btnCapture.hidden = false;
  cameraPreview.hidden = false;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 256 }, height: { ideal: 256 } },
      audio: false,
    });
    cameraPreview.srcObject = cameraStream;
  } catch (err) {
    console.warn("camera not available:", err);
    cameraPreview.hidden = true;
    btnCapture.hidden = true;
  }
}

// ===========================================================================
// Background removal (MediaPipe Selfie Segmentation, lazy-loaded from CDN).
// First capture pays the ~3 MB SDK + model download; subsequent captures are
// instant (~30 ms). On any failure we fall back to the existing JPEG path.
// ===========================================================================
const SEGMENTER_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747";
let _segmenter = null;
let _segmenterLoad = null;

function _loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("script load failed: " + src));
    document.head.appendChild(s);
  });
}

async function ensureSegmenter() {
  if (_segmenter) return _segmenter;
  if (_segmenterLoad) return _segmenterLoad;
  _segmenterLoad = (async () => {
    try {
      if (typeof SelfieSegmentation === "undefined") {
        await _loadScript(`${SEGMENTER_BASE}/selfie_segmentation.js`);
      }
      const seg = new SelfieSegmentation({
        locateFile: (file) => `${SEGMENTER_BASE}/${file}`,
      });
      seg.setOptions({ modelSelection: 1 });
      await seg.initialize();
      _segmenter = seg;
      return seg;
    } catch (err) {
      console.warn("MediaPipe failed to load — falling back to JPEG:", err);
      return null;
    }
  })();
  return _segmenterLoad;
}

// MediaPipe holds a single onResults callback at a time, so all segmenter
// work is serialized through this promise chain to prevent capture and
// background reprocessing from trampling each other.
let _segChain = Promise.resolve();
function _runSeg(fn) {
  const next = _segChain.then(() => fn());
  _segChain = next.catch(() => {});  // never break the chain
  return next;
}

// Runs MediaPipe segmentation on a given source (video or image) and
// returns a 128×128 PNG dataURL with transparent background. Null on
// any failure.
async function _segmentToPng(source) {
  const seg = await ensureSegmenter();
  if (!seg) return null;
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      seg.onResults((r) => resolve(r));
      seg.send({ image: source }).catch(reject);
      setTimeout(() => reject(new Error("segmentation timeout")), 5000);
    });
  } catch (err) {
    console.warn("segmentation failed:", err);
    return null;
  }
  const W = 256;
  const work = document.createElement("canvas");
  work.width = work.height = W;
  const wctx = work.getContext("2d");
  wctx.drawImage(result.segmentationMask, 0, 0, W, W);
  wctx.globalCompositeOperation = "source-in";
  wctx.drawImage(result.image, 0, 0, W, W);
  const final = document.createElement("canvas");
  final.width = final.height = 128;
  const fctx = final.getContext("2d");
  fctx.imageSmoothingEnabled = true;
  fctx.imageSmoothingQuality = "high";
  fctx.drawImage(work, 0, 0, 128, 128);
  return final.toDataURL("image/png");
}

async function captureWithBackgroundRemoval() {
  // Pre-flip the camera frame so the saved photo matches the mirrored
  // preview (natural selfie orientation: your right hand on the right).
  const W = 256;
  const flipped = document.createElement("canvas");
  flipped.width = flipped.height = W;
  const fctx = flipped.getContext("2d");
  fctx.translate(W, 0);
  fctx.scale(-1, 1);
  fctx.drawImage(cameraPreview, 0, 0, W, W);
  return _runSeg(() => _segmentToPng(flipped));
}

// Background-reprocess pass: detects existing JPEG photos on stories,
// runs them through segmentation, swaps in the transparent PNG locally,
// and POSTs the result back to the server so the change is durable.
const _reprocessQueue = [];
let _reprocessRunning = false;

function queuePhotoReprocess(story) {
  if (!story.photo || !story.photo.startsWith("data:image/jpeg")) return;
  if (story._reprocessQueued) return;
  story._reprocessQueued = true;
  _reprocessQueue.push(story);
  if (!_reprocessRunning) drainReprocessQueue();
}

async function drainReprocessQueue() {
  _reprocessRunning = true;
  while (_reprocessQueue.length > 0) {
    const story = _reprocessQueue.shift();
    try { await reprocessOldPhoto(story); }
    catch (err) { console.warn("reprocess errored:", err); }
    await new Promise(r => setTimeout(r, 50));  // breathing room between
  }
  _reprocessRunning = false;
}

async function reprocessOldPhoto(story) {
  if (!story.photo || !story.photo.startsWith("data:image/jpeg")) return;
  // Load the source JPEG into an Image element first.
  const srcImg = new Image();
  await new Promise((resolve, reject) => {
    srcImg.onload = resolve;
    srcImg.onerror = reject;
    srcImg.src = story.photo;
  });
  const newDataURL = await _runSeg(() => _segmentToPng(srcImg));
  if (!newDataURL) return;
  // Swap into the story locally.
  story.photo = newDataURL;
  await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      story.photoImg = img;
      story.photoBounds = computePhotoRowBounds(img);
      resolve();
    };
    img.src = newDataURL;
  });
  render();
  // Persist to server (fire-and-forget — UI already updated).
  if (story._id) {
    fetch(`/story/${story._id}/photo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo: newDataURL }),
    }).catch(err => console.warn("server photo update failed:", err));
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
  cameraPreview.srcObject = null;
}

btnCapture.addEventListener("click", async () => {
  btnCapture.disabled = true;
  const orig = btnCapture.textContent;
  btnCapture.textContent = "removing bg…";

  // Try background-removal path first; fall back to plain JPEG capture.
  let dataURL = null;
  try { dataURL = await captureWithBackgroundRemoval(); }
  catch (err) { console.warn("bg removal threw:", err); }
  if (!dataURL) {
    const snapCtx = cameraSnap.getContext("2d");
    snapCtx.save();
    snapCtx.translate(80, 0);
    snapCtx.scale(-1, 1);
    snapCtx.drawImage(cameraPreview, 0, 0, 80, 80);
    snapCtx.restore();
    dataURL = cameraSnap.toDataURL("image/jpeg", 0.7);
  }

  capturedPhoto = dataURL;
  cameraThumb.src = capturedPhoto;
  cameraThumb.hidden = false;
  cameraPreview.hidden = true;
  btnCapture.hidden = true;
  btnRetake.hidden = false;
  stopCamera();

  btnCapture.disabled = false;
  btnCapture.textContent = orig;
});

btnRetake.addEventListener("click", () => {
  capturedPhoto = null;
  startCamera();
});

function openWriter(wx, wy, nearX, nearY) {
  authoringWx = wx;
  authoringWy = wy;
  writerLoc.textContent = `(${wx.toFixed(0)}, ${wy.toFixed(0)})`;
  writerEl.hidden = false;
  // First-pass placement near the click; clamped after layout below so the
  // panel + camera section can never push past the viewport edges.
  writerEl.style.left = (nearX + 16) + "px";
  writerEl.style.top  = (nearY + 16) + "px";
  requestAnimationFrame(() => {
    const margin = 12;
    const rect = writerEl.getBoundingClientRect();
    let x = nearX + 16, y = nearY + 16;
    if (x + rect.width  > window.innerWidth  - margin) x = window.innerWidth  - rect.width  - margin;
    if (y + rect.height > window.innerHeight - margin) y = window.innerHeight - rect.height - margin;
    if (x < margin) x = margin;
    if (y < margin) y = margin;
    writerEl.style.left = x + "px";
    writerEl.style.top  = y + "px";
  });
  writerName.focus();
  startCamera();
  broadcastDraft();
}

function closeWriter(cancel = true) {
  writerEl.hidden = true;
  if (writerConfirm) writerConfirm.hidden = true;
  _confirmActive = false;
  stopCamera();
  capturedPhoto = null;
  cameraThumb.hidden = true;
  if (authoringWx != null && cancel) {
    socket.emit("draft:cancel");
  }
  authoringWx = null;
  authoringWy = null;
  writerName.value = "";
  writerSpot.value = "";
  writerStory.value = "";
}

function broadcastDraft() {
  if (authoringWx == null) return;
  socket.emit("draft:update", {
    wx: authoringWx,
    wy: authoringWy,
    name: writerName.value,
    spot: writerSpot.value,
    story: writerStory.value,
  });
}

writerName.addEventListener("input", broadcastDraft);
writerSpot.addEventListener("input", broadcastDraft);
writerStory.addEventListener("input", broadcastDraft);
writerClose.addEventListener("click", () => closeWriter(true));

writerSubmit.addEventListener("click", async () => {
  if (authoringWx == null) return;
  const name = writerName.value.trim();
  const spot = writerSpot.value.trim();
  const story = writerStory.value.trim();
  if (!name || !spot || !story) {
    writerSubmit.textContent = "fill in all fields";
    setTimeout(() => (writerSubmit.textContent = "leave it here"), 1500);
    return;
  }
  const res = await fetch("/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wx: authoringWx,
      wy: authoringWy,
      name,
      spot,
      story,
      title: story.slice(0, 20),
      photo: capturedPhoto || null,
    }),
  });
  const data = await res.json();
  if (data.success) {
    socket.emit("draft:cancel");
    const postedWx = authoringWx;
    const postedWy = authoringWy;
    closeWriter(false);
    // Slam to MAX_SCALE so the new post-it is at full natural size — photo
    // visible, all text revealed. No page refresh; the next visitor sees a
    // real story zoomed in alongside the welcome panel.
    if (postedWx != null && postedWy != null) {
      view.scale = MAX_SCALE;
      view.tx = window.innerWidth  / 2 - postedWx * MAX_SCALE;
      view.ty = window.innerHeight / 2 - postedWy * MAX_SCALE;
      updateTier();
      render();
    }
  } else {
    // Show server's reason briefly (e.g., moderation flagged it).
    writerSubmit.textContent = data.message || "couldn't post";
    setTimeout(() => (writerSubmit.textContent = "leave it here"), 3000);
  }
});

// ---- comments ----
const commentsEl     = document.getElementById("comments");
const commentsSpot   = document.getElementById("comments-spot");
const commentsList   = document.getElementById("comments-list");
const commentsName   = document.getElementById("comments-name");
const commentsText   = document.getElementById("comments-text");
const commentsClose  = document.getElementById("comments-close");
const commentsSubmit = document.getElementById("comments-submit");
let _commentsStoryId = null;

function _renderComments(story) {
  commentsList.innerHTML = "";
  const list = (story && story.comments) || [];
  for (const c of list) {
    const item = document.createElement("div");
    item.className = "comment-item";
    const author = document.createElement("span");
    author.className = "comment-author";
    author.textContent = c.name;
    const txt = document.createElement("span");
    txt.className = "comment-text";
    txt.textContent = c.text;
    item.appendChild(author);
    item.appendChild(txt);
    commentsList.appendChild(item);
  }
}

// De-duped append so the optimistic local push and the socket broadcast
// don't both add the same comment.
function _addCommentDedup(story, comment) {
  if (!story.comments) story.comments = [];
  for (const c of story.comments) {
    if (c.timestamp === comment.timestamp && c.text === comment.text && c.name === comment.name) {
      return false;
    }
  }
  story.comments.push(comment);
  return true;
}

function openComments(cluster, nearX, nearY) {
  const story = cluster.stories[cluster.activeIdx] || cluster.stories[0];
  if (!story || !story._id) return;
  _commentsStoryId = story._id;
  commentsSpot.textContent = `[ ${(story.spot || "").slice(0, 30) || "—"} ]`;
  _renderComments(story);
  commentsEl.hidden = false;

  const cardR = cluster._boxRect;
  const PANEL_MIN_W = 220;
  const PANEL_MAX_W = 360;
  let panelW, x, y;
  if (cardR) {
    panelW = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, cardR.w));
    x = cardR.x;
    y = cardR.y + cardR.h;
  } else {
    panelW = PANEL_MIN_W;
    x = nearX + 16;
    y = nearY + 16;
  }
  commentsEl.style.width = panelW + "px";
  commentsEl.style.left  = x + "px";
  commentsEl.style.top   = y + "px";

  requestAnimationFrame(() => {
    const margin = 12;
    const rect = commentsEl.getBoundingClientRect();
    let nx = parseFloat(commentsEl.style.left);
    let ny = parseFloat(commentsEl.style.top);
    if (nx + rect.width  > window.innerWidth  - margin) nx = window.innerWidth  - rect.width  - margin;
    if (nx < margin) nx = margin;
    if (ny + rect.height > window.innerHeight - margin) {
      if (cardR) {
        const above = cardR.y - rect.height;
        ny = above >= margin ? above : window.innerHeight - rect.height - margin;
      } else {
        ny = window.innerHeight - rect.height - margin;
      }
    }
    if (ny < margin) ny = margin;
    commentsEl.style.left = nx + "px";
    commentsEl.style.top  = ny + "px";
    commentsName.focus();
  });
}

function closeComments() {
  commentsEl.hidden = true;
  _commentsStoryId = null;
  commentsName.value = "";
  commentsText.value = "";
}

// Track the open panel to its post-it on every render frame. Re-binds when
// a cluster is cycled (so the panel always shows the active story's
// comments). Closes the panel if the post-it is no longer rendered.
function syncCommentsPosition() {
  if (commentsEl.hidden || !_commentsStoryId) return;
  let cluster = null;
  for (const c of clusters) {
    if (c.stories.some(s => s._id === _commentsStoryId)) { cluster = c; break; }
  }
  if (!cluster || !cluster._boxRect) {
    closeComments();
    return;
  }
  const activeStory = cluster.stories[cluster.activeIdx] || cluster.stories[0];
  if (activeStory && activeStory._id && activeStory._id !== _commentsStoryId) {
    _commentsStoryId = activeStory._id;
    commentsSpot.textContent = `[ ${(activeStory.spot || "").slice(0, 30) || "—"} ]`;
    _renderComments(activeStory);
    commentsName.value = "";
    commentsText.value = "";
  }
  const cardR = cluster._boxRect;
  const PANEL_MIN_W = 220;
  const PANEL_MAX_W = 360;
  const margin = 12;
  const panelW = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, cardR.w));
  let x = cardR.x;
  let y = cardR.y + cardR.h;
  if (x + panelW > window.innerWidth - margin) x = window.innerWidth - panelW - margin;
  if (x < margin) x = margin;
  const panelH = commentsEl.getBoundingClientRect().height;
  if (y + panelH > window.innerHeight - margin) {
    const above = cardR.y - panelH;
    y = above >= margin ? above : window.innerHeight - panelH - margin;
  }
  if (y < margin) y = margin;
  commentsEl.style.width = panelW + "px";
  commentsEl.style.left  = x + "px";
  commentsEl.style.top   = y + "px";
}

commentsClose.addEventListener("click", closeComments);

commentsSubmit.addEventListener("click", async () => {
  if (!_commentsStoryId) return;
  const name = commentsName.value.trim();
  const text = commentsText.value.trim();
  if (!name || !text) {
    commentsSubmit.textContent = "fill in both";
    setTimeout(() => (commentsSubmit.textContent = "post"), 1500);
    return;
  }
  commentsSubmit.disabled = true;
  try {
    const res = await fetch(`/story/${_commentsStoryId}/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, text }),
    });
    const data = await res.json();
    if (data.success) {
      const story = storiesById.get(_commentsStoryId);
      if (story) {
        _addCommentDedup(story, data.comment);
        _renderComments(story);
      }
      commentsName.value = "";
      commentsText.value = "";
    } else {
      commentsSubmit.textContent = data.message || "couldn't post";
      setTimeout(() => (commentsSubmit.textContent = "post"), 2500);
    }
  } catch (err) {
    console.warn("comment post failed:", err);
  } finally {
    commentsSubmit.disabled = false;
  }
});

// ---- init ----
window.addEventListener("resize", resize);
resize();
fitToViewport();
render();
loadStories();
// Kick off background map layer loads in parallel.
for (const name of Object.keys(mapLayers)) loadMapLayer(name);

// ---- socket: story commits + cursor presence ----
socket.on("connect", () => console.log("socket connected:", socket.id));
socket.on("comment:add", ({ storyId, comment }) => {
  const story = storiesById.get(storyId);
  if (!story) return;
  const added = _addCommentDedup(story, comment);
  if (added && _commentsStoryId === storyId) _renderComments(story);
});
socket.on("story:commit", (s) => {
  ingestStory(s);
  render();
});

socket.on("cursors:init", ({ self, peers: initial, drafts: initialDrafts }) => {
  selfColor = self.color;
  for (const [id, c] of Object.entries(initial)) {
    if (c && c.wx !== undefined) peers.set(id, { ...c, targetX: c.wx, targetY: c.wy });
  }
  if (initialDrafts) {
    for (const [id, d] of Object.entries(initialDrafts)) liveDrafts.set(id, d);
  }
  render();
});
socket.on("draft:update", ({ id, draft }) => {
  liveDrafts.set(id, draft);
  render();
});
socket.on("draft:end", ({ id }) => {
  liveDrafts.delete(id);
  render();
});
socket.on("cursor:join", ({ id, color }) => {
  peers.set(id, { color });
});
socket.on("cursor:move", ({ id, wx, wy }) => {
  const p = peers.get(id) || {};
  p.targetX = wx;
  p.targetY = wy;
  if (p.wx === undefined) { p.wx = wx; p.wy = wy; }
  peers.set(id, p);
});
socket.on("cursor:leave", ({ id }) => {
  peers.delete(id);
});

// Local cursor tracking → throttled broadcast in world coords.
let lastCursorEmit = 0;
let lastCursorScreen = null;
function emitCursor(sx, sy) {
  lastCursorScreen = { x: sx, y: sy };
  const now = performance.now();
  if (now - lastCursorEmit < 100) return; // ~10fps
  lastCursorEmit = now;
  const w = screenToWorld(sx, sy);
  socket.emit("cursor:move", { wx: w.x, wy: w.y });
}

function screenToWorld(sx, sy) {
  return { x: (sx - view.tx) / view.scale, y: (sy - view.ty) / view.scale };
}

window.addEventListener("pointermove", (e) => emitCursor(e.clientX, e.clientY));

// Main animation loop: drives cursor interpolation + photo floating.
function tick() {
  let dirty = false;
  for (const p of peers.values()) {
    if (p.targetX === undefined) continue;
    if (p.wx === undefined) { p.wx = p.targetX; p.wy = p.targetY; continue; }
    const dx = p.targetX - p.wx;
    const dy = p.targetY - p.wy;
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
      p.wx += dx * 0.2;
      p.wy += dy * 0.2;
      dirty = true;
    }
  }
  // Continuous render when photos are floating or drafts are active.
  if (dirty || hasPhotos || liveDrafts.size > 0) render();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
