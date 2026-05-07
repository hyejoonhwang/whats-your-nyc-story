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
const MAX_SCALE = 20;

const FONT_FAMILY = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const FONT_SIZE = 10;
const LINE_HEIGHT = 12;
const FONT = `${FONT_SIZE}px ${FONT_FAMILY}`;

// Minimalist ASCII params. All story rendering happens in monospace text on a
// pure-white canvas: thin black outlines for the map, character markers for
// clusters, and box-drawn frames for stories. No colors, no textures, no
// shadows — everything is text or a single-pixel black line.
const INK = "#000";
const INK_MUTED = "rgba(0,0,0,0.55)";
const INK_FAINT = "rgba(0,0,0,0.30)";
const PAPER = "#fff";

// Story box (ASCII frame) sizing in screen px. Kept on a multiple of LINE_HEIGHT
// so the box, body text, and ASCII portrait all share the same character grid.
const BOX_PAD = 4;                              // outer breathing room around the frame
const BOX_MAX_INNER = 200;                      // max inner width in screen px (used to be 120 for paper post-its)
const BOX_FADE_START = 1.5;                     // box pops in at this scale
const MARKER_BOX_OFFSET_X = 36;                 // default screen-px offset of box from marker (upper-right)
const MARKER_BOX_OFFSET_Y = -36;

// Cluster marker characters — driven by cluster.stories.length.
// Stay visible at every zoom level; the leader line anchors to them.
function markerCharForCount(n) {
  if (n >= 10) return "■";
  if (n >= 5)  return "*";
  if (n >= 3)  return "+";
  if (n >= 2)  return ":";
  return "·";
}
const MARKER_FONT_BASE = 11;                    // base monospace size in px at scale 1
const MARKER_FONT_MIN  = 10;
const MARKER_FONT_MAX  = 22;

// ASCII portrait ramp: dark pixels → dense chars (rightmost), light → sparse.
// Leading space is intentional — fully transparent / very-bright cells render
// as whitespace so body text can flow into them.
const ASCII_RAMP = " .:-=+*#%@";
const ASCII_ALPHA_THRESH = 28;                  // 0–255 alpha cutoff
// Portrait cell — slightly wider than glyph cell so chars don't crash into
// each other. We tune this against the measured cellW on first render.

const view = { scale: 1, tx: 0, ty: 0 };
let currentTier = "CITY";

// Stories live as a flat array now — each story has its own (wx, wy) world
// coordinates from the click point that placed it. No cell clustering.
const stories = [];
const storiesById = new Map();

// Stories that land within STACK_THRESHOLD world units of each other are
// grouped into a "cluster" — only one post-it is visible at a time per
// cluster, with an arrow at the bottom-right to cycle through the rest
// (newest → older). Rebuilt whenever a new story arrives.
const STACK_THRESHOLD = 10;
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
// loads zoomed-in instead of fitting the whole grid. _zoomFloor is set to
// the same value so the user can't zoom out below this default.
const DEFAULT_ZOOM = 1.23;

function fitToViewport() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const pad = 40;
  const fit = Math.min((W - pad * 2) / GRID_W, (H - pad * 2) / GRID_H);
  const s = fit * DEFAULT_ZOOM;
  _zoomFloor = s;
  view.scale = s;
  view.tx = (W - GRID_W * s) / 2;
  view.ty = (H - GRID_H * s) / 2;
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

// Lazily prepare a story's Pretext layout + load its photo. The minimalist
// renderer doesn't use Pretext line walking on the cell grid (monospace makes
// it trivial), but we still build a prepared form for the live-draft preview.
function ensureStoryPrepared(story) {
  if (story.prepared) return;
  const fullText = [story.name, story.spot, story.story]
    .filter((p) => p && String(p).trim())
    .join(" / ");
  story.prepared = prepareWithSegments(fullText, FONT);

  if (story.photo && !story.photoImg) {
    const img = new Image();
    img.src = story.photo;
    img.onload = () => {
      story.photoImg = img;
      story._asciiCache = null;  // recomputed lazily at render time
      render();
      // If this is an unprocessed JPEG from before bg-removal existed,
      // run it through the segmenter in the background and persist.
      queuePhotoReprocess(story);
    };
  }
}

// ============================================================================
// Map background — outline-only, B&W. Borough perimeters, NTAs, parks, and
// streets are all drawn as black strokes on a white background. Lat/lon
// points project onto the same world grid the markers/boxes use, so map and
// stories share the same pan/zoom transform.
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

  // Pure white paper.
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);

  const vb = [-view.tx / s, -view.ty / s, (W - view.tx) / s, (H - view.ty) / s];

  // Borough outlines — bold black perimeter, no fills.
  if (mapLayers.boroughs.data) {
    ctx.save();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.1;
    ctx.lineJoin = "round";
    for (const f of mapLayers.boroughs.data) {
      if (!bboxIntersectsView(f.bbox, vb)) continue;
      tracePolygonFeature(f);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Parks — outlined only (no fill).
  if (mapLayers.parks.data && s > mapLayers.parks.threshold) {
    ctx.save();
    ctx.strokeStyle = INK_FAINT;
    ctx.lineWidth = 0.5;
    for (const f of mapLayers.parks.data) {
      if (!bboxIntersectsView(f.bbox, vb)) continue;
      tracePolygonFeature(f);
      ctx.stroke();
    }
    ctx.restore();
  }

  // NTA boundaries — thin dashed black.
  if (mapLayers.nta.data && s > mapLayers.nta.threshold) {
    ctx.save();
    ctx.strokeStyle = INK_FAINT;
    ctx.lineWidth = 0.4;
    ctx.setLineDash([2, 3]);
    for (const f of mapLayers.nta.data) {
      if (!bboxIntersectsView(f.bbox, vb)) continue;
      tracePolygonFeature(f);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Major streets — thin black.
  if (mapLayers.streetsMajor.data && s > mapLayers.streetsMajor.threshold) {
    ctx.save();
    ctx.strokeStyle = INK_MUTED;
    ctx.lineWidth = 0.7;
    ctx.lineCap = "round";
    for (const f of mapLayers.streetsMajor.data) {
      if (!bboxIntersectsView(f.bbox, vb)) continue;
      traceLineFeature(f);
      ctx.stroke();
    }
    ctx.restore();
  }

  // All streets — even thinner, more transparent.
  if (mapLayers.streetsAll.data && s > mapLayers.streetsAll.threshold) {
    ctx.save();
    ctx.strokeStyle = INK_FAINT;
    ctx.lineWidth = 0.4;
    ctx.lineCap = "round";
    for (const f of mapLayers.streetsAll.data) {
      if (!bboxIntersectsView(f.bbox, vb)) continue;
      traceLineFeature(f);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Borough labels — monospace caps, no serif.
  ctx.save();
  ctx.fillStyle = INK_MUTED;
  const labelSize = Math.max(11, Math.min(18, 11 * s));
  ctx.font = `${labelSize}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const [name, lp] of Object.entries(BOROUGH_LABEL_POINTS)) {
    const [wx, wy] = lonLatToWorld(lp);
    const sx = view.tx + wx * s;
    const sy = view.ty + wy * s;
    if (sx < -100 || sx > W + 100 || sy < -50 || sy > H + 50) continue;
    // Letter-spaced for typographic emphasis.
    const txt = name.toUpperCase().split("").join(" ");
    ctx.fillText(txt, sx, sy);
  }
  ctx.restore();
}

// ============================================================================
// ASCII intro panel — fixed in screen space, upper-left of the viewport.
// Pure box-drawn frame with three sections: title / personal note / how-to.
// Drawn cell-by-cell at INTRO_LH line height in monospace.
// ============================================================================
const INTRO_X = 24;
const INTRO_Y = 24;
const INTRO_FONT_SIZE = 11;
const INTRO_LH = 14;
const INTRO_COLS = 30;       // total width in chars (incl. side borders)

function repeat(ch, n) { return n > 0 ? new Array(n + 1).join(ch) : ""; }

// Pads to width and inserts inside a row: "│ text          │"
function introRow(text) {
  const inner = INTRO_COLS - 2;
  const t = (text || "").slice(0, inner);
  return "│" + t + repeat(" ", inner - t.length) + "│";
}

// Section separator: ├──────────────┤
function introRule() {
  return "├" + repeat("─", INTRO_COLS - 2) + "┤";
}

function buildIntroLines() {
  const lines = [];
  // Top frame
  lines.push("┌" + repeat("─", INTRO_COLS - 2) + "┐");
  // Title block — letter-spaced caps centered.
  const title = "WHAT'S YOUR NYC STORY";
  const padL = Math.floor((INTRO_COLS - 2 - title.length) / 2);
  lines.push(introRow(repeat(" ", padL) + title));
  lines.push(introRule());

  // Personal note section
  lines.push(introRow(""));
  lines.push(introRow(" everyone has their"));
  lines.push(introRow(" own version of nyc —"));
  lines.push(introRow(" on every corner,"));
  lines.push(introRow(" in every building."));
  lines.push(introRow(""));
  lines.push(introRow(" we live in the same"));
  lines.push(introRow(" city, but is it"));
  lines.push(introRow(" really the same?"));
  lines.push(introRow(""));
  lines.push(introRow(" i'd love to know"));
  lines.push(introRow(" what nyc means to"));
  lines.push(introRow(" you, and what"));
  lines.push(introRow(" stories you hold."));
  lines.push(introRow(""));
  lines.push(introRule());

  // How-to section
  lines.push(introRow(""));
  lines.push(introRow(" HOW TO LEAVE A STORY"));
  lines.push(introRow(""));
  lines.push(introRow(" 1. zoom in and click"));
  lines.push(introRow("    where your story"));
  lines.push(introRow("    lives."));
  lines.push(introRow(""));
  lines.push(introRow(" 2. write your name,"));
  lines.push(introRow("    the place, and"));
  lines.push(introRow("    what happened."));
  lines.push(introRow(""));
  lines.push(introRow(" 3. take a selfie."));
  lines.push(introRow(""));
  lines.push(introRow(" 4. hit"));
  lines.push(introRow("    [ leave it here ]"));
  lines.push(introRow(""));
  // Bottom frame
  lines.push("└" + repeat("─", INTRO_COLS - 2) + "┘");
  return lines;
}

const _INTRO_LINES = buildIntroLines();

function renderIntroPanel() {
  ctx.save();
  ctx.font = `${INTRO_FONT_SIZE}px ${FONT_FAMILY}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  // Knock out a white background so map outlines underneath don't bleed
  // through the panel — keeps the ASCII art crisp.
  const cw = ctx.measureText("M").width;
  const panelW = INTRO_COLS * cw + 4;
  const panelH = _INTRO_LINES.length * INTRO_LH + 4;
  ctx.fillStyle = PAPER;
  ctx.fillRect(INTRO_X - 2, INTRO_Y - 2, panelW, panelH);

  ctx.fillStyle = INK;
  let y = INTRO_Y;
  for (const line of _INTRO_LINES) {
    ctx.fillText(line, INTRO_X, y);
    y += INTRO_LH;
  }
  ctx.restore();
}

// ---- render ----
function render() {
  const W = window.innerWidth;
  const H = window.innerHeight;

  renderMapBackground();

  const s = view.scale;

  renderStories();
  renderDrafts();
  renderPeerCursors();

  // ASCII intro panel — last so it overlays everything except HUD.
  renderIntroPanel();

  // HUD — minimalist black on white.
  ctx.fillStyle = INK_MUTED;
  ctx.font = `11px ${FONT_FAMILY}`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillText(`${currentTier}  ·  ${s.toFixed(2)}x  ·  ${stories.length} stories`, 12, H - 14);
}

// ============================================================================
// ASCII portrait — convert a transparent PNG into a char grid that renders as
// part of the story's text body. Per-row column bounds let body text reflow
// around the silhouette so everything stays as text.
// ============================================================================

// Sample the source image at (charsW × charsH), then for each cell pick a char
// from ASCII_RAMP based on darkness; transparent cells become spaces. Returns
// { grid: char[][], rowBounds: ({left,right}|null)[] }. Cached on the story
// object so we only recompute when the cell dimensions change (i.e. on zoom).
function getOrComputeAsciiPortrait(story, charsW, charsH) {
  if (!story.photoImg) return null;
  const cache = story._asciiCache;
  if (cache && cache.charsW === charsW && cache.charsH === charsH) return cache;

  const c = document.createElement("canvas");
  c.width = charsW; c.height = charsH;
  const cx = c.getContext("2d");
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = "high";
  cx.drawImage(story.photoImg, 0, 0, charsW, charsH);
  const data = cx.getImageData(0, 0, charsW, charsH).data;

  const grid = new Array(charsH);
  const rowBounds = new Array(charsH);
  for (let y = 0; y < charsH; y++) {
    const row = new Array(charsW);
    let l = -1, r = -1;
    for (let x = 0; x < charsW; x++) {
      const i = (y * charsW + x) * 4;
      const a = data[i + 3];
      if (a < ASCII_ALPHA_THRESH) {
        row[x] = " ";
      } else {
        const r0 = data[i], g0 = data[i + 1], b0 = data[i + 2];
        // 0..1 luminance, perceptual weighting.
        const lum = (0.299 * r0 + 0.587 * g0 + 0.114 * b0) / 255;
        // Brighter pixel → lighter char. We map [0..1] luminance to a ramp
        // index in [1 .. RAMP.length-1] (skip pure space; opaque means present).
        const idx = Math.max(1, Math.floor((1 - lum) * (ASCII_RAMP.length - 1)));
        row[x] = ASCII_RAMP[idx];
        if (l === -1) l = x;
        r = x;
      }
    }
    grid[y] = row;
    rowBounds[y] = l === -1 ? null : { left: l, right: r };
  }

  story._asciiCache = { charsW, charsH, grid, rowBounds };
  return story._asciiCache;
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

// Build a 2-D char grid for one story's box. Frame, header, rule, ASCII
// portrait, and word-wrapped body all live on the same monospace cell grid.
function buildStoryGrid(story, cluster, innerCols, innerRows) {
  const boxCols = innerCols + 2;
  const boxRows = innerRows + 2;
  const grid = new Array(boxRows);
  for (let r = 0; r < boxRows; r++) grid[r] = new Array(boxCols).fill(" ");

  // Frame
  grid[0][0] = "┌";
  grid[0][boxCols - 1] = "┐";
  grid[boxRows - 1][0] = "└";
  grid[boxRows - 1][boxCols - 1] = "┘";
  for (let c = 1; c < boxCols - 1; c++) {
    grid[0][c] = "─";
    grid[boxRows - 1][c] = "─";
  }
  for (let r = 1; r < boxRows - 1; r++) {
    grid[r][0] = "│";
    grid[r][boxCols - 1] = "│";
  }

  // Header row + rule (only if box is tall enough to bother).
  let bodyTopR = 1;
  let bodyBotR = boxRows - 2;
  if (boxRows >= 5) {
    const headParts = [];
    if (story.name) headParts.push(story.name);
    if (story.spot) headParts.push(story.spot);
    let headerText = " " + headParts.join(" / ");
    if (headerText.length > innerCols) headerText = headerText.slice(0, innerCols - 1) + "…";
    for (let i = 0; i < headerText.length && i < innerCols; i++) {
      grid[1][1 + i] = headerText[i];
    }
    grid[2][0] = "├";
    grid[2][boxCols - 1] = "┤";
    for (let c = 1; c < boxCols - 1; c++) grid[2][c] = "─";
    bodyTopR = 3;
  }

  const bodyHeight = bodyBotR - bodyTopR + 1;

  // Place ASCII portrait in body region, centered. pRows is roughly half of
  // pCols because monospace cells are about twice as tall as they are wide,
  // so a 12×6 char grid renders as a ~square portrait on screen.
  let portraitOcc = null;
  if (story.photoImg && bodyHeight >= 4 && innerCols >= 12) {
    const pCols = clamp(Math.floor(innerCols * 0.55), 6, 30);
    const pRows = clamp(Math.round(pCols * 0.5), 3, bodyHeight - 1);
    const portrait = getOrComputeAsciiPortrait(story, pCols, pRows);
    if (portrait) {
      const pColStart = Math.floor((innerCols - pCols) / 2);
      const pRowStart = Math.floor((bodyHeight - pRows) / 2);
      portraitOcc = new Array(bodyHeight).fill(null);
      for (let pr = 0; pr < pRows; pr++) {
        const rowChars = portrait.grid[pr];
        for (let pc = 0; pc < pCols; pc++) {
          const ch = rowChars[pc];
          if (ch !== " ") {
            grid[bodyTopR + pRowStart + pr][1 + pColStart + pc] = ch;
          }
        }
        const b = portrait.rowBounds[pr];
        if (b) {
          portraitOcc[pRowStart + pr] = {
            colStart: pColStart + b.left,
            colEnd:   pColStart + b.right,
          };
        }
      }
    }
  }

  // Reflow body text around the portrait silhouette: greedy word-fit into the
  // remaining cells of each body row. With monospace, char count = pixel width,
  // so this stays straightforward; Pretext's prepared form would buy us nothing
  // extra on a cell grid.
  const bodyText = (story.story || "").trim();
  if (bodyText) {
    const words = bodyText.split(/\s+/);
    let wi = 0;
    let charInWord = 0;
    for (let br = 0; br < bodyHeight && wi < words.length; br++) {
      const occ = portraitOcc ? portraitOcc[br] : null;
      // Compute available col ranges (in 0..innerCols-1).
      const ranges = [];
      if (!occ) {
        ranges.push({ a: 0, b: innerCols - 1 });
      } else {
        if (occ.colStart > 0)            ranges.push({ a: 0,             b: occ.colStart - 2 });
        if (occ.colEnd < innerCols - 1)  ranges.push({ a: occ.colEnd + 2, b: innerCols - 1 });
      }
      for (const range of ranges) {
        if (range.b < range.a) continue;
        let col = range.a;
        const colEnd = range.b;
        while (col <= colEnd && wi < words.length) {
          const word = words[wi];
          const remaining = word.slice(charInWord);
          const avail = colEnd - col + 1;
          if (charInWord === 0 && remaining.length > avail) {
            // Would wrap — but if the word exceeds even the full innerCols
            // width, hard-break into chunks; otherwise let it land on the
            // next row.
            if (remaining.length > innerCols) {
              for (let k = 0; k < avail; k++) grid[bodyTopR + br][1 + col + k] = remaining[k];
              charInWord += avail;
              col = colEnd + 1;
            } else {
              break;
            }
          } else {
            const toPlace = Math.min(remaining.length, avail);
            for (let k = 0; k < toPlace; k++) grid[bodyTopR + br][1 + col + k] = remaining[k];
            col += toPlace;
            if (toPlace === remaining.length) {
              wi += 1;
              charInWord = 0;
              if (col <= colEnd && wi < words.length) col += 1; // word separator
            } else {
              charInWord += toPlace;
            }
          }
        }
      }
    }
  }

  // Embed [ n/N → ] into the bottom border, right-aligned. Returns the
  // (col, length) used so the caller can register a hit-test region.
  let arrowSpan = null;
  if (cluster.stories.length > 1) {
    const label = `[ ${cluster.activeIdx + 1}/${cluster.stories.length} → ]`;
    const need = label.length;
    if (need + 4 <= boxCols) {
      const startCol = boxCols - 1 - need - 1;
      for (let i = 0; i < need; i++) grid[boxRows - 1][startCol + i] = label[i];
      arrowSpan = { col: startCol, len: need };
    }
  }

  return { grid, arrowSpan };
}

function renderStories() {
  const s = view.scale;
  hasPhotos = false;
  clusterArrowHits.length = 0;

  ctx.font = FONT;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  const cellW = ctx.measureText("M").width;
  const cellH = LINE_HEIGHT;

  const W = window.innerWidth, H = window.innerHeight;
  const vbMinX = -view.tx / s - 60;
  const vbMaxX = (W - view.tx) / s + 60;
  const vbMinY = -view.ty / s - 60;
  const vbMaxY = (H - view.ty) / s + 60;

  const boxVisible = s >= BOX_FADE_START;

  // Inner width grows linearly with zoom from a small minimum to BOX_MAX_INNER.
  // Cap to a multiple of cellW so the frame aligns cleanly with the char grid.
  const _t = clamp((s - BOX_FADE_START) / (MAX_SCALE - BOX_FADE_START), 0, 1);
  const innerMaxPx = Math.max(cellW * 14, cellW * 14 + _t * (BOX_MAX_INNER - cellW * 14));

  // Marker font size ramps gently with zoom — bigger glyphs are easier to see
  // on dense maps but shouldn't overpower the box at high zoom.
  const markerSize = clamp(MARKER_FONT_BASE * Math.sqrt(s), MARKER_FONT_MIN, MARKER_FONT_MAX);

  for (let ci = 0; ci < clusters.length; ci++) {
    const cluster = clusters[ci];
    if (cluster.wx < vbMinX || cluster.wx > vbMaxX) continue;
    if (cluster.wy < vbMinY || cluster.wy > vbMaxY) continue;

    // Marker at cluster anchor (always rendered, every zoom level).
    const mx = view.tx + cluster.wx * s;
    const my = view.ty + cluster.wy * s;
    const markerCh = markerCharForCount(cluster.stories.length);

    ctx.save();
    ctx.font = `${markerSize}px ${FONT_FAMILY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // Knock out a little white halo so the marker stays legible over street
    // hatching at full zoom.
    ctx.fillStyle = PAPER;
    const halo = markerSize * 0.45;
    ctx.fillRect(mx - halo, my - halo, halo * 2, halo * 2);
    ctx.fillStyle = INK;
    ctx.fillText(markerCh, mx, my);
    ctx.restore();

    if (!boxVisible) continue;

    const story = cluster.stories[cluster.activeIdx] || cluster.stories[0];
    if (!story) continue;
    ensureStoryPrepared(story);
    hasPhotos = true; // keep the render loop spinning while boxes are visible

    // Box dimensions in cells. Cells are taller than wide on most monospace
    // fonts (cellW≈6, cellH=12), so innerRows is set so the box renders as a
    // visually square rectangle on screen instead of a tall column.
    const innerCols = Math.max(14, Math.floor(innerMaxPx / cellW));
    const innerRows = Math.max(8, Math.round(innerCols * cellW / cellH));
    const boxCols = innerCols + 2;
    const boxRows = innerRows + 2;
    const boxW = boxCols * cellW;
    const boxH = boxRows * cellH;

    // Box screen-space top-left: marker + screen offset + drag offset (world × s).
    const dragSx = (cluster.dx || 0) * s;
    const dragSy = (cluster.dy || 0) * s;
    let boxLeft = mx + MARKER_BOX_OFFSET_X + dragSx;
    let boxTop  = my + MARKER_BOX_OFFSET_Y + dragSy - boxH;
    // (offset puts the bottom-left corner near marker; subtract boxH so the
    //  whole box sits up-and-right of the marker.)

    // Build content
    const { grid, arrowSpan } = buildStoryGrid(story, cluster, innerCols, innerRows);

    // White background knock-out for crisp ASCII over the map.
    ctx.fillStyle = PAPER;
    ctx.fillRect(boxLeft - 1, boxTop - 1, boxW + 2, boxH + 2);

    // Leader line from marker to nearest point on the box AABB.
    const lx = clamp(mx, boxLeft, boxLeft + boxW);
    const ly = clamp(my, boxTop, boxTop + boxH);
    ctx.save();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.lineTo(lx, ly);
    ctx.stroke();
    ctx.restore();

    // Render the grid row-by-row.
    ctx.save();
    ctx.font = FONT;
    ctx.fillStyle = INK;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    let yy = boxTop;
    for (const row of grid) {
      ctx.fillText(row.join(""), boxLeft, yy);
      yy += cellH;
    }
    ctx.restore();

    // Hit-test rect for the box (drag/drag-detect uses this).
    cluster._boxRect = { x: boxLeft, y: boxTop, w: boxW, h: boxH };

    // Arrow click zone: the [n/N →] span on the bottom border.
    if (arrowSpan) {
      clusterArrowHits.push({
        cluster,
        aabb: {
          x: boxLeft + arrowSpan.col * cellW,
          y: boxTop + (boxRows - 1) * cellH,
          w: arrowSpan.len * cellW,
          h: cellH,
        },
      });
    }
  }
}

// True if a screen click hit any arrow region (the [ n/N → ] embedded in a
// bottom border). Cycles activeIdx and re-renders if so.
function handleArrowClick(sx, sy) {
  const PAD = 4;
  for (const a of clusterArrowHits) {
    const b = a.aabb;
    if (sx >= b.x - PAD && sx <= b.x + b.w + PAD &&
        sy >= b.y - PAD && sy <= b.y + b.h + PAD) {
      a.cluster.activeIdx = (a.cluster.activeIdx + 1) % a.cluster.stories.length;
      render();
      return true;
    }
  }
  return false;
}

// Draws any in-progress drafts from peers as live monospace text near their
// target spot, with a pulsing ring as a writing-now indicator.
function renderDrafts() {
  const s = view.scale;
  const cellScreen = BASE_CELL * s;
  const now = performance.now();
  const pulse = 0.5 + 0.5 * Math.sin(now / 400);

  for (const [id, d] of liveDrafts) {
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

    // Pulse ring (black, alpha modulates).
    const ringR = 8 + pulse * 6;
    ctx.save();
    ctx.strokeStyle = INK;
    ctx.globalAlpha = 0.25 + 0.5 * pulse;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

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
    ctx.fillStyle = INK_MUTED;
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
  ctx.save();
  ctx.fillStyle = INK;
  ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  for (const p of peers.values()) {
    if (p.wx === undefined) continue;
    const sx = view.tx + p.wx * s;
    const sy = view.ty + p.wy * s;
    // ASCII arrow cursor — tiny "▶" style using a + glyph.
    ctx.fillText("+", sx - 3, sy - 6);
  }
  ctx.restore();
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

// Returns the cluster whose box (last-rendered AABB in screen space) contains
// (sx, sy), or null. Boxes are axis-aligned now — no rotation math required.
function _hitTestPostit(sx, sy) {
  if (view.scale < BOX_FADE_START) return null;
  for (const cluster of clusters) {
    const r = cluster._boxRect;
    if (!r) continue;
    if (sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) return cluster;
  }
  return null;
}

// True if the screen point is inside any cluster's arrow region. Used to
// route a tap to the cycler before treating it as drag-arming.
function _arrowClusterAt(sx, sy) {
  const PAD = 4;
  for (const a of clusterArrowHits) {
    const b = a.aabb;
    if (sx >= b.x - PAD && sx <= b.x + b.w + PAD &&
        sy >= b.y - PAD && sy <= b.y + b.h + PAD) {
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
      story._asciiCache = null;
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
  // Position near the click, kept on screen.
  const rect = writerEl.getBoundingClientRect();
  const w = rect.width || 260;
  const h = rect.height || 220;
  const x = Math.min(window.innerWidth - w - 12, Math.max(12, nearX + 16));
  const y = Math.min(window.innerHeight - h - 12, Math.max(12, nearY + 16));
  writerEl.style.left = x + "px";
  writerEl.style.top = y + "px";
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
    setTimeout(() => (writerSubmit.textContent = "[ leave it here ]"), 1500);
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
    closeWriter(false);
  } else {
    // Show server's reason briefly (e.g., moderation flagged it).
    writerSubmit.textContent = data.message || "couldn't post";
    setTimeout(() => (writerSubmit.textContent = "[ leave it here ]"), 3000);
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
