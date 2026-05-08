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

const FONT_FAMILY = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const FONT_SIZE = 10;
const LINE_HEIGHT = 12;
const FONT = `${FONT_SIZE}px ${FONT_FAMILY}`;

// Minimalist ASCII params. All story rendering happens in monospace text on a
// pure-white canvas: thin black outlines for the map, character markers for
// clusters, and box-drawn frames for stories. No colors, no textures, no
// shadows — everything is text or a single-pixel black line.
const INK = "#000";
const INK_MUTED = "rgba(0,0,0,0.55)";   // borough labels, HUD, drafts
const INK_FAINT = "rgba(0,0,0,0.30)";   // (still used as faint accent)
const MAP_GREY = "#c8c8c8";             // every line on the map
const PAPER = "#fff";

// Story box sizing. Cards pop in at BOX_FADE_START as a 1×1-cell stamp
// holding just the first letter of the name, then grow toward each story's
// per-content natural-max footprint at MAX_SCALE. Font size is fixed at every
// zoom — only the cell COUNT grows, so Pretext re-breaks the prepared text at
// each new width and more letters appear as the box widens.
const BOX_PAD = 4;
const BOX_FADE_START = 10;                      // cards appear only after ~10× zoom
const BOX_MIN_INNER_COLS = 1;                   // smallest body width when card first appears
const BOX_MIN_INNER_ROWS = 1;                   // smallest body height
const MARKER_BOX_OFFSET_X = 22;
const MARKER_BOX_OFFSET_Y = -22;
// Uniform photo dimensions (in cells) across every card. Cell aspect 1:2
// (cellW:cellH) → 10×5 cells = 60×60 px native = visually square.
const PHOTO_CELLS_W = 10;
const PHOTO_CELLS_H = 5;

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

// CJK / fullwidth / emoji detection. Chars in these ranges render at ~2x the
// basic monospace cell width, so we reserve 2 grid cells for them and paint
// the next cell as empty filler.
function isWideChar(ch) {
  if (!ch) return false;
  const cp = ch.codePointAt(0);
  if (cp >= 0x1F000) return true;     // emoji + supplementary plane symbols
  return (
    (cp >= 0x1100 && cp <= 0x115F) ||
    (cp >= 0x2E80 && cp <= 0x303E) ||
    (cp >= 0x3041 && cp <= 0x33FF) ||
    (cp >= 0x3400 && cp <= 0x4DBF) ||
    (cp >= 0x4E00 && cp <= 0x9FFF) ||
    (cp >= 0xA000 && cp <= 0xA4CF) ||
    (cp >= 0xAC00 && cp <= 0xD7A3) ||
    (cp >= 0xF900 && cp <= 0xFAFF) ||
    (cp >= 0xFE30 && cp <= 0xFE4F) ||
    (cp >= 0xFF00 && cp <= 0xFF60) ||
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||
    (cp >= 0x2600 && cp <= 0x27BF)
  );
}
function chCells(ch) { return isWideChar(ch) ? 2 : 1; }

// Grapheme split (so multi-codepoint emoji + Hangul stay atomic). Cached
// because Intl.Segmenter construction isn't free.
let _grapheme = null;
function graphemes(text) {
  if (!_grapheme) _grapheme = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const out = [];
  for (const seg of _grapheme.segment(text || "")) out.push(seg.segment);
  return out;
}

const view = { scale: 1, tx: 0, ty: 0 };
let currentTier = "CITY";

// Stories live as a flat array now — each story has its own (wx, wy) world
// coordinates from the click point that placed it. No cell clustering.
const stories = [];
const storiesById = new Map();

// Each click gets its own dot — we only "cluster" stories at the EXACT same
// world point (e.g. duplicate test data). Anything else stays a separate dot
// at its own location. Rebuilt whenever a new story arrives.
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

// Default zoom on load — chosen so streets just start to appear and there's
// enough detail to feel oriented without cards yet (cards pop in at s=10).
// _zoomFloor is the fit-to-grid scale so the user can still zoom out to the
// full-NYC overview from here.
const DEFAULT_ZOOM = 4.5;

function fitToViewport() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const pad = 40;
  const fit = Math.min((W - pad * 2) / GRID_W, (H - pad * 2) / GRID_H);
  _zoomFloor = fit;
  view.scale = DEFAULT_ZOOM;
  // Open with Manhattan parked in the upper-right area of the screen so the
  // intro panel in the upper-left has clear room and Brooklyn/Queens flow
  // downward into view. (Centering the whole world grid puts the geometric
  // middle near central Brooklyn — too far south for a "welcome" composition.)
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

// Lazily prepare a story's Pretext layout, photo, and float physics.
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
      story.photoBounds = computePhotoRowBounds(img);
      story._boxCells = null;  // photo joined → re-pick size to make room
      render();
      // If this is an unprocessed JPEG from before bg-removal existed,
      // run it through the segmenter in the background and persist.
      queuePhotoReprocess(story);
    };
  }

  // Drift physics for the photo inside the box (screen-px offsets relative
  // to the box's interior center). Same gentle wander the post-its had.
  if (!story.float) {
    story.float = {
      ox: (Math.random() - 0.5) * 8,
      oy: (Math.random() - 0.5) * 8,
      vx: (Math.random() > 0.5 ? 1 : -1) * 0.4,
      vy: (Math.random() > 0.5 ? 1 : -1) * 0.4,
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
  nta:          { url: "/data/nyc-neighborhoods.geojson", threshold: 0,    data: null },
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

  // Pure white paper. Borough perimeters are intentionally NOT drawn — only
  // the inner layers (NTAs, parks, streets) appear, so neighborhoods read as
  // free-floating geometry without a heavy boundary box around each borough.
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);

  const vb = [-view.tx / s, -view.ty / s, (W - view.tx) / s, (H - view.ty) / s];

  // Parks — outlined in light grey.
  if (mapLayers.parks.data && s > mapLayers.parks.threshold) {
    ctx.save();
    ctx.strokeStyle = MAP_GREY;
    ctx.lineWidth = 0.5;
    for (const f of mapLayers.parks.data) {
      if (!bboxIntersectsView(f.bbox, vb)) continue;
      tracePolygonFeature(f);
      ctx.stroke();
    }
    ctx.restore();
  }

  // NTA boundaries — light grey, thin dashed.
  if (mapLayers.nta.data && s > mapLayers.nta.threshold) {
    ctx.save();
    ctx.strokeStyle = MAP_GREY;
    ctx.lineWidth = 0.4;
    ctx.setLineDash([2, 3]);
    for (const f of mapLayers.nta.data) {
      if (!bboxIntersectsView(f.bbox, vb)) continue;
      tracePolygonFeature(f);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Major streets — light grey, slightly heavier weight to read above NTAs.
  if (mapLayers.streetsMajor.data && s > mapLayers.streetsMajor.threshold) {
    ctx.save();
    ctx.strokeStyle = MAP_GREY;
    ctx.lineWidth = 0.7;
    ctx.lineCap = "round";
    for (const f of mapLayers.streetsMajor.data) {
      if (!bboxIntersectsView(f.bbox, vb)) continue;
      traceLineFeature(f);
      ctx.stroke();
    }
    ctx.restore();
  }

  // All streets — light grey, thinnest weight.
  if (mapLayers.streetsAll.data && s > mapLayers.streetsAll.threshold) {
    ctx.save();
    ctx.strokeStyle = MAP_GREY;
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

// ---- render ----
// (Intro panel is now a DOM <aside> overlay — see #intro in index.html.
// That way clicks on it don't fall through to the map, and we get
// proper responsive collapse for free via CSS.)
function render() {
  const W = window.innerWidth;
  const H = window.innerHeight;

  renderMapBackground();

  const s = view.scale;

  renderStories();
  renderDrafts();
  renderPeerCursors();

  // HUD — minimalist black on white.
  ctx.fillStyle = INK_MUTED;
  ctx.font = `11px ${FONT_FAMILY}`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillText(`${currentTier}  ·  ${s.toFixed(2)}x  ·  ${stories.length} stories`, 12, H - 14);

  // If a comments panel is open, keep it glued to its story card as the
  // user pans / zooms. Defined further below; safe-guard with typeof in
  // case render() fires before the comments setup ran.
  if (typeof syncCommentsPosition === "function") syncCommentsPosition();
}

// ============================================================================
// Photo thumbnail — transparent PNG (background already removed by MediaPipe)
// rendered as a real raster image inside the box, with float physics for the
// gentle drift you see on each story. Per-row alpha bounds let body text
// reflow around the silhouette so the text follows the figure's contour.
// ============================================================================
const PHOTO_SAMPLE = 96;             // resolution we sample alpha bounds at
const PHOTO_ALPHA_THRESHOLD = 30;    // 0–255 alpha cutoff for "figure" pixels

// Per-row left/right opaque pixel bounds in PHOTO_SAMPLE-local coords.
// Computed once when the photo loads; reused across every render frame
// regardless of how the photo's drawn-size changes with zoom.
function computePhotoRowBounds(img) {
  const c = document.createElement("canvas");
  c.width = c.height = PHOTO_SAMPLE;
  const cx = c.getContext("2d");
  cx.drawImage(img, 0, 0, PHOTO_SAMPLE, PHOTO_SAMPLE);
  const data = cx.getImageData(0, 0, PHOTO_SAMPLE, PHOTO_SAMPLE).data;
  const out = new Array(PHOTO_SAMPLE);
  for (let y = 0; y < PHOTO_SAMPLE; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < PHOTO_SAMPLE; x++) {
      if (data[(y * PHOTO_SAMPLE + x) * 4 + 3] > PHOTO_ALPHA_THRESHOLD) {
        if (l === -1) l = x;
        r = x;
      }
    }
    out[y] = l === -1 ? null : { leftX: l, rightX: r };
  }
  return out;
}

// Returns the screen-x bounds of opaque pixels across the rows that overlap a
// given screen y-range, or null if the y-range misses the figure entirely.
function getPhotoOccupiedRange(bounds, photoLeft, photoTop, photoSize, lineY, lineH) {
  const scale = PHOTO_SAMPLE / photoSize;
  const yStart = Math.max(0, Math.floor((lineY - photoTop) * scale));
  const yEnd = Math.min(PHOTO_SAMPLE, Math.ceil((lineY + lineH - photoTop) * scale));
  if (yEnd <= yStart) return null;
  let lSample = Infinity, rSample = -Infinity;
  for (let y = yStart; y < yEnd; y++) {
    const b = bounds[y];
    if (!b) continue;
    if (b.leftX < lSample) lSample = b.leftX;
    if (b.rightX > rSample) rSample = b.rightX;
  }
  if (lSample === Infinity) return null;
  const inv = photoSize / PHOTO_SAMPLE;
  return { pLeft: photoLeft + lSample * inv, pRight: photoLeft + rSample * inv };
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

// Place a single character into the grid at (r, c), reserving 2 cells for
// CJK/fullwidth glyphs (the second cell becomes "" so row.join doesn't
// double-count its width). Returns the number of cells consumed.
function placeChar(grid, r, c, ch) {
  if (isWideChar(ch)) {
    grid[r][c] = ch;
    if (c + 1 < grid[r].length) grid[r][c + 1] = "";
    return 2;
  }
  grid[r][c] = ch;
  return 1;
}

// Pick the natural-max cell footprint for a story — sized to fit *exactly*
// the text it contains plus the photo, with a small slack for whitespace.
// innerCols is bucketed by text length so long stories don't grow absurdly
// tall; bodyRows is the exact count needed to hold the content (no empty
// rows at the bottom). Cached per story.
function computeBoxSize(story) {
  if (story._boxCells) return story._boxCells;

  const headerName = (story.name || "").trim();
  const headerSpot = (story.spot || "").trim();
  const bodyChars  = graphemes((story.story || "").trim());

  let bodyW = 0;
  for (const g of bodyChars) bodyW += chCells(g);

  let headerW = 1;
  for (const g of graphemes(headerName)) headerW += chCells(g);
  if (headerSpot) {
    headerW += 3;
    for (const g of graphemes(headerSpot)) headerW += chCells(g);
  }

  const hasPhoto  = !!story.photoImg;
  const photoArea = hasPhoto ? PHOTO_CELLS_W * PHOTO_CELLS_H : 0;
  const slack     = Math.ceil(bodyW * 0.10) + 4;
  const need      = bodyW + slack + photoArea;

  // Pick a target body width by text length so long stories get wider cards
  // (and stay roughly readable) while short ones stay tight.
  let innerCols;
  if      (bodyW < 30)  innerCols = 12;
  else if (bodyW < 80)  innerCols = 16;
  else if (bodyW < 160) innerCols = 20;
  else                  innerCols = 24;

  // Always at least wide enough to hold the header without truncation.
  if (headerW + 2 > innerCols) innerCols = headerW + 2;
  // Always wide enough to hold the (uniform) photo with breathing room.
  if (hasPhoto && innerCols < PHOTO_CELLS_W + 4) innerCols = PHOTO_CELLS_W + 4;
  // Even-snap so the right border lands cleanly.
  if (innerCols % 2 === 1) innerCols += 1;
  innerCols = Math.min(innerCols, 60);

  // Body rows = exactly enough to hold the text + photo. Past this point any
  // additional rows would just be empty.
  let bodyRows = Math.ceil(need / innerCols);
  if (hasPhoto && bodyRows < PHOTO_CELLS_H + 1) bodyRows = PHOTO_CELLS_H + 1;
  bodyRows = Math.max(1, bodyRows);

  // header (1) + rule (1) + body
  const innerRows = 2 + bodyRows;

  story._boxCells = { innerCols, innerRows };
  return story._boxCells;
}

// Build a 2-D char grid for one story's box. Content reveals progressively
// with size: tiny boxes show only the name; once there's room, the spot
// joins it in the header; large enough boxes also gain a rule + body with
// the story flowing letter-by-letter around the photo silhouette.
function buildStoryGrid(story, cluster, innerCols, innerRows, portraitOcc, cellW) {
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

  // Header — always render the name; add "/ spot" only when it fits in full.
  const nameG = graphemes((story.name || "").trim());
  const spotG = graphemes((story.spot || "").trim());
  function widthOf(arr) { let w = 0; for (const g of arr) w += chCells(g); return w; }
  function placeRow(r, startCol, gArr, maxCols) {
    let c = startCol;
    for (const g of gArr) {
      const w = chCells(g);
      if (c + w - 1 > startCol + maxCols - 1) break;
      placeChar(grid, r, c, g);
      c += w;
    }
    return c - startCol;
  }
  // " name" — leading space for breathing room when there's room.
  const leadPad = innerCols >= 4 ? 1 : 0;
  const headerCols = innerCols - leadPad;
  let headerCells = [];
  const fullSep = " / ";
  const fullW = widthOf(nameG) + (spotG.length ? widthOf(graphemes(fullSep)) + widthOf(spotG) : 0);
  if (spotG.length && fullW <= headerCols) {
    headerCells = [...nameG, ...graphemes(fullSep), ...spotG];
  } else {
    headerCells = nameG;
  }
  placeRow(1, 1 + leadPad, headerCells, headerCols);

  // Decide whether to render a body — needs at least header + rule + 1 row + bottom.
  let bodyTopR = -1;
  let bodyHeight = 0;
  if (boxRows >= 5) {
    grid[2][0] = "├";
    grid[2][boxCols - 1] = "┤";
    for (let c = 1; c < boxCols - 1; c++) grid[2][c] = "─";
    bodyTopR = 3;
    bodyHeight = (boxRows - 2) - bodyTopR + 1;
  }

  // Body — Pretext drives the line breaks. We feed walkLineRanges the
  // CURRENT inner-width (in screen px) so as the box widens with zoom,
  // Pretext re-walks the prepared text and longer / different lines emerge.
  // Each materialized line is then rendered char-by-char into cells, with a
  // jump past the photo silhouette for rows that overlap it.
  if (bodyHeight > 0 && story.prepared) {
    const innerWidthPx = innerCols * cellW;
    const lines = [];
    walkLineRanges(story.prepared, innerWidthPx, (lineRange) => {
      if (lines.length < bodyHeight) {
        lines.push(materializeLineRange(story.prepared, lineRange));
      }
    });

    for (let br = 0; br < lines.length; br++) {
      const occ = portraitOcc ? portraitOcc[br] : null;
      const lineGraphemes = graphemes(lines[br].text);
      let col = 0;
      let inRight = false;
      let firstChar = true;
      for (const g of lineGraphemes) {
        // Drop leading whitespace at the start of a wrapped line so text
        // doesn't begin with a stranded space.
        if (firstChar && /^\s+$/.test(g)) continue;
        firstChar = false;
        const w = chCells(g);
        // If this char would land on the photo, jump past it once.
        if (occ && !inRight && col + w - 1 >= occ.colStart) {
          col = occ.colEnd + 1;
          inRight = true;
        }
        if (col + w - 1 > innerCols - 1) break;
        if (!/^\s+$/.test(g)) placeChar(grid, bodyTopR + br, 1 + col, g);
        col += w;
      }
    }
  }

  // Embed [ n/N → ] into the bottom border, right-aligned.
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

  return { grid, arrowSpan, bodyTopR, bodyHeight };
}

function renderStories() {
  const s = view.scale;
  hasPhotos = false;
  clusterArrowHits.length = 0;
  // Clear last-frame box rects; only clusters whose card actually renders
  // this frame will have one set below. Used by syncCommentsPosition().
  for (const c of clusters) c._boxRect = null;

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
    ctx.fillStyle = INK;
    ctx.fillText(markerCh, mx, my);
    ctx.restore();

    if (!boxVisible) continue;

    const story = cluster.stories[cluster.activeIdx] || cluster.stories[0];
    if (!story) continue;
    ensureStoryPrepared(story);
    hasPhotos = true;

    // CURRENT cell-grid dimensions: lerp from a 1×1 stamp at BOX_FADE_START
    // to each story's per-content NATURAL max at MAX_SCALE. The font stays
    // at FONT_SIZE (10px) at every zoom — only the cell COUNT grows, so
    // Pretext re-breaks the prepared text at each new width and additional
    // letters surface as the box widens.
    const natural = computeBoxSize(story);
    const _t = clamp((s - BOX_FADE_START) / (MAX_SCALE - BOX_FADE_START), 0, 1);
    let innerCols = Math.round(BOX_MIN_INNER_COLS + _t * (natural.innerCols - BOX_MIN_INNER_COLS));
    let innerRows = Math.round(BOX_MIN_INNER_ROWS + _t * (natural.innerRows - BOX_MIN_INNER_ROWS));
    // Snap to even ONLY when there's room for a real card. Below that we let
    // the tiny stamp (innerCols=1) pass through so it shows just one letter.
    if (innerCols >= 4 && innerCols % 2 === 1) innerCols += 1;
    innerCols = Math.max(1, Math.min(innerCols, natural.innerCols));
    innerRows = Math.max(1, Math.min(innerRows, natural.innerRows));

    const boxCols = innerCols + 2;
    const boxRows = innerRows + 2;
    const boxW = boxCols * cellW;
    const boxH = boxRows * cellH;

    // Box top-left (screen px). Marker offset + drag offset.
    const dragSx = (cluster.dx || 0) * s;
    const dragSy = (cluster.dy || 0) * s;
    const boxLeft = mx + MARKER_BOX_OFFSET_X + dragSx;
    const boxTop  = my + MARKER_BOX_OFFSET_Y + dragSy - boxH;

    // Header rows (header + rule) only when there's room for a body too.
    const hasBody    = innerRows >= 3;
    const headerRows = hasBody ? 2 : 0;
    const bodyTopY   = (1 + headerRows) * cellH;
    const bodyBotY   = (boxRows - 1) * cellH;
    const innerLeftX = cellW;
    const innerW     = innerCols * cellW;
    const innerBodyH = bodyBotY - bodyTopY;

    // Photo: uniform 10×5 cells. Only renders once the card has the room.
    let photoOcc = null;
    let photoLeft = 0, photoTop = 0;
    const photoSize = PHOTO_CELLS_W * cellW;        // === PHOTO_CELLS_H * cellH
    const havePhoto = !!story.photoImg
                      && innerCols >= PHOTO_CELLS_W + 4
                      && (innerRows - headerRows) >= PHOTO_CELLS_H + 1;
    if (havePhoto) {
      const f = story.float;
      const maxOx = (innerW - photoSize) / 2 - 4;
      const maxOy = (innerBodyH - photoSize) / 2 - 4;
      if (maxOx > 0 && maxOy > 0) {
        f.ox += f.vx; f.oy += f.vy;
        if (f.ox < -maxOx || f.ox > maxOx) { f.vx *= -1; f.ox = clamp(f.ox, -maxOx, maxOx); }
        if (f.oy < -maxOy || f.oy > maxOy) { f.vy *= -1; f.oy = clamp(f.oy, -maxOy, maxOy); }
      } else {
        f.ox = 0; f.oy = 0;
      }
      photoLeft = boxLeft + innerLeftX + innerW / 2 + f.ox - photoSize / 2;
      photoTop  = boxTop  + bodyTopY  + innerBodyH / 2 + f.oy - photoSize / 2;

      if (story.photoBounds) {
        photoOcc = new Array(innerRows).fill(null);
        for (let br = headerRows; br < innerRows; br++) {
          const rowY = boxTop + bodyTopY + (br - headerRows) * cellH;
          const r = getPhotoOccupiedRange(
            story.photoBounds, photoLeft, photoTop, photoSize, rowY, cellH);
          if (!r) continue;
          const colStart = Math.max(0, Math.floor((r.pLeft  - boxLeft - innerLeftX) / cellW));
          const colEnd   = Math.min(innerCols - 1, Math.ceil((r.pRight - boxLeft - innerLeftX) / cellW) - 1);
          if (colEnd >= colStart) {
            photoOcc[br - headerRows] = { colStart, colEnd };
          }
        }
      }
    }

    const { grid, arrowSpan } = buildStoryGrid(
      story, cluster, innerCols, innerRows, photoOcc, cellW);

    // White knock-out so map lines underneath don't bleed through.
    ctx.fillStyle = PAPER;
    ctx.fillRect(boxLeft - 1, boxTop - 1, boxW + 2, boxH + 2);

    // Leader line from marker to nearest box edge.
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

    // Render the grid PER CELL at native (1:1) px — font stays at FONT_SIZE
    // regardless of zoom. CJK glyphs reserve 2 cells via chCells/placeChar.
    ctx.save();
    ctx.font = FONT;
    ctx.fillStyle = INK;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    for (let r = 0; r < boxRows; r++) {
      const yy = boxTop + r * cellH;
      for (let c = 0; c < boxCols; c++) {
        const ch = grid[r][c];
        if (!ch || ch === " ") continue;
        ctx.fillText(ch, boxLeft + c * cellW, yy);
      }
    }
    ctx.restore();

    // Photo on top, clipped to the body region so drift never escapes.
    if (havePhoto) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(boxLeft + innerLeftX, boxTop + bodyTopY, innerW, innerBodyH);
      ctx.clip();
      ctx.drawImage(story.photoImg, photoLeft, photoTop, photoSize, photoSize);
      ctx.restore();
    }

    cluster._boxRect = { x: boxLeft, y: boxTop, w: boxW, h: boxH };

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
  // Click landed on a story card → open the comments panel for it.
  const hitCluster = _hitTestPostit(sx, sy);
  if (hitCluster) {
    openComments(hitCluster, sx, sy);
    return;
  }
  // If the comments panel is open, an outside-click should ONLY close it —
  // not also place a new pin.
  if (!commentsEl.hidden) {
    closeComments();
    return;
  }
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
    const text = document.createElement("span");
    text.className = "comment-text";
    text.textContent = c.text;
    item.appendChild(author);
    item.appendChild(text);
    commentsList.appendChild(item);
  }
}

// Append a comment to story.comments only if it isn't already there.
// Server's HTTP response and the socket broadcast carry the SAME comment
// object (same timestamp + text), so whichever path arrives second is a
// no-op. Returns true if appended.
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

  // Anchor the panel flush against the card's bottom-left corner so it
  // reads as an extension of the card rather than a separate popup.
  // Panel width matches the card when wide enough; otherwise expands to a
  // usable minimum.
  const cardR = cluster._boxRect;
  const PANEL_MIN_W = 220;
  const PANEL_MAX_W = 360;
  let panelW;
  let x, y;
  if (cardR) {
    panelW = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, cardR.w));
    x = cardR.x;
    y = cardR.y + cardR.h;       // touching the bottom edge
  } else {
    panelW = PANEL_MIN_W;
    x = nearX + 16;
    y = nearY + 16;
  }
  commentsEl.style.width = panelW + "px";
  commentsEl.style.left = x + "px";
  commentsEl.style.top  = y + "px";

  requestAnimationFrame(() => {
    const margin = 12;
    const rect = commentsEl.getBoundingClientRect();
    let nx = parseFloat(commentsEl.style.left);
    let ny = parseFloat(commentsEl.style.top);
    // Horizontal clamp — keep the left edge aligned with the card when we can.
    if (nx + rect.width > window.innerWidth - margin) {
      nx = window.innerWidth - rect.width - margin;
    }
    if (nx < margin) nx = margin;
    // Vertical: if there's no room below the card, flip above it instead.
    if (ny + rect.height > window.innerHeight - margin) {
      if (cardR) {
        ny = cardR.y - rect.height;
        if (ny < margin) ny = window.innerHeight - rect.height - margin;
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

// Re-position the open comments panel under its story card every render
// frame so the panel tracks the card as the user pans / zooms / drags.
// Also re-binds to the cluster's currently-active story when the user
// cycles via [ n/N → ] — so the panel always shows the comments for the
// card that's actually visible, never the previously-active sibling.
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
  // If the user cycled to a different story in this cluster, rebind the
  // panel: switch the spot header, swap the comment list, clear the
  // half-typed form so a stray post doesn't land on the wrong story.
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
  // If the panel doesn't fit below the card, flip above; if it doesn't
  // fit above either, anchor to the bottom of the viewport.
  const panelH = commentsEl.getBoundingClientRect().height;
  if (y + panelH > window.innerHeight - margin) {
    const above = cardR.y - panelH;
    y = above >= margin ? above : window.innerHeight - panelH - margin;
  }
  if (y < margin) y = margin;
  commentsEl.style.width = panelW + "px";
  commentsEl.style.left = x + "px";
  commentsEl.style.top  = y + "px";
}

commentsClose.addEventListener("click", closeComments);

commentsSubmit.addEventListener("click", async () => {
  if (!_commentsStoryId) return;
  const name = commentsName.value.trim();
  const text = commentsText.value.trim();
  if (!name || !text) {
    commentsSubmit.textContent = "fill in both";
    setTimeout(() => (commentsSubmit.textContent = "[ post ]"), 1500);
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
      // Optimistic local append (de-duped against the socket broadcast that
      // will arrive shortly).
      const story = storiesById.get(_commentsStoryId);
      if (story) {
        _addCommentDedup(story, data.comment);
        _renderComments(story);
      }
      commentsName.value = "";
      commentsText.value = "";
    } else {
      commentsSubmit.textContent = data.message || "couldn't post";
      setTimeout(() => (commentsSubmit.textContent = "[ post ]"), 2500);
    }
  } catch (err) {
    console.warn("comment post failed:", err);
  } finally {
    commentsSubmit.disabled = false;
  }
});

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
      story._boxCells = null;
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
  // First-pass placement near the click; clamped after layout below.
  writerEl.style.left = (nearX + 16) + "px";
  writerEl.style.top  = (nearY + 16) + "px";
  // Re-measure on next frame so the real laid-out height (camera section,
  // confirm overlay, etc.) is known, then clamp inside the viewport. The
  // CSS max-height + overflow-y:auto guarantees the panel can never be
  // taller than the viewport, so the submit button is always reachable.
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
    // Capture the just-posted coords before closeWriter() nulls them out.
    const postedWx = authoringWx;
    const postedWy = authoringWy;
    closeWriter(false);
    // Slam to MAX_SCALE so the just-posted card is at its full natural
    // size — photo visible, all text revealed. We DON'T refresh; leaving
    // the map zoomed in on a real story is more inviting for the next
    // person walking up than a blank welcome view.
    if (postedWx != null && postedWy != null) {
      view.scale = MAX_SCALE;
      view.tx = window.innerWidth  / 2 - postedWx * MAX_SCALE;
      view.ty = window.innerHeight / 2 - postedWy * MAX_SCALE;
      updateTier();
      render();
    }
    // Re-open the intro panel so the welcome resurfaces alongside the
    // zoomed-in card — the next visitor sees both at once.
    const introEl = document.getElementById("intro");
    if (introEl) {
      introEl.classList.add("open");
      introEl.classList.remove("closed");
    }
  } else {
    // Show server's reason briefly (e.g., moderation flagged it).
    writerSubmit.textContent = data.message || "couldn't post";
    setTimeout(() => (writerSubmit.textContent = "[ leave it here ]"), 3000);
  }
});

// ---- intro panel ----
// DOM-based panel; CSS handles desktop / mobile-modal layouts. Always starts
// expanded on every page load — first-time visitors and returning ones see
// the welcome at the top of every session. The toggle still works within a
// session so users can collapse it once they're done reading.
(() => {
  const introEl = document.getElementById("intro");
  const introOk = document.getElementById("intro-ok");
  const introClose = document.getElementById("intro-close");
  const introHandle = document.getElementById("intro-handle");
  if (!introEl) return;

  introEl.classList.add("open");
  introEl.classList.remove("closed");

  function open() {
    introEl.classList.add("open");
    introEl.classList.remove("closed");
  }
  function close() {
    introEl.classList.remove("open");
    introEl.classList.add("closed");
  }
  introOk.addEventListener("click", close);
  introClose.addEventListener("click", close);
  introHandle.addEventListener("click", open);
})();

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
socket.on("comment:add", ({ storyId, comment }) => {
  const story = storiesById.get(storyId);
  if (!story) return;
  const added = _addCommentDedup(story, comment);
  if (added && _commentsStoryId === storyId) _renderComments(story);
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
