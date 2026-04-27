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

const FONT_FAMILY = 'ui-monospace, "SF Mono", Menlo, monospace';
const FONT_SIZE = 10;
const LINE_HEIGHT = 12;
const FONT = `${FONT_SIZE}px ${FONT_FAMILY}`;

const view = { scale: 1, tx: 0, ty: 0 };
let currentTier = "CITY";

// dotIndex -> { stories: [...sorted newest first], preparedTitle, preparedStory }
const dotMap = new Map();

// Peer cursor state (populated via socket events; declared up here to avoid TDZ issues
// since render() is called during init before the socket section is reached).
const peers = new Map();
let selfColor = null;

// Active in-progress drafts by peer socket id: { dotIndex, name, spot, story, color }
const liveDrafts = new Map();
// Dot currently being authored by this client (or null when not writing).
let authoringDotIndex = null;

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

function fitToViewport() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const pad = 40;
  const s = Math.min((W - pad * 2) / GRID_W, (H - pad * 2) / GRID_H);
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
  let entry = dotMap.get(s.dotIndex);
  if (!entry) {
    entry = { stories: [] };
    dotMap.set(s.dotIndex, entry);
  }
  entry.stories.push(s);
  entry.stories.sort((a, b) => b.timestamp - a.timestamp); // recency wins
  const newest = entry.stories[0];
  const fullText = `${newest.name}\n${newest.story}`;
  entry.prepared = prepareWithSegments(fullText, FONT);
  entry.capW = null; // force recompute

  // Load photo as Image if present.
  if (newest.photo && !entry.photoImg) {
    const img = new Image();
    img.src = newest.photo;
    img.onload = () => { entry.photoImg = img; render(); };
  }

  // Initialize floating physics for the photo (world-space offsets from dot center).
  if (!entry.float) {
    entry.float = {
      ox: (Math.random() - 0.5) * BASE_CELL * 0.3,
      oy: (Math.random() - 0.5) * BASE_CELL * 0.3,
      vx: (Math.random() > 0.5 ? 1 : -1) * 0.6,
      vy: (Math.random() > 0.5 ? 1 : -1) * 0.6,
    };
  }
}

// ---- render ----
function render() {
  const W = window.innerWidth;
  const H = window.innerHeight;

  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, W, H);

  const s = view.scale;

  const worldMinX = -view.tx / s;
  const worldMinY = -view.ty / s;
  const worldMaxX = worldMinX + W / s;
  const worldMaxY = worldMinY + H / s;
  const colMin = Math.max(0, Math.floor(worldMinX / BASE_CELL) - 1);
  const colMax = Math.min(COLS, Math.ceil(worldMaxX / BASE_CELL) + 1);
  const rowMin = Math.max(0, Math.floor(worldMinY / BASE_CELL) - 1);
  const rowMax = Math.min(ROWS, Math.ceil(worldMaxY / BASE_CELL) + 1);

  // Dots (constant screen size). Hide dots that have a story — text takes their place.
  const dotR = 3;
  ctx.fillStyle = "rgba(232,232,232,0.85)";
  for (let row = rowMin; row < rowMax; row++) {
    for (let col = colMin; col < colMax; col++) {
      const idx = row * COLS + col;
      if (NYC_GRID[idx] !== 1) continue;
      if (dotMap.has(idx)) continue; // story replaces the dot
      const wx = col * BASE_CELL + BASE_CELL / 2;
      const wy = row * BASE_CELL + BASE_CELL / 2;
      ctx.beginPath();
      ctx.arc(view.tx + wx * s, view.ty + wy * s, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Render stories wrapped inside each dot's footprint at every zoom level.
  renderStories(colMin, colMax, rowMin, rowMax);

  renderDrafts();
  renderPeerCursors();

  // HUD.
  ctx.fillStyle = "#666";
  ctx.font = `11px ${FONT_FAMILY}`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillText(`${currentTier}  ·  ${s.toFixed(2)}x  ·  ${dotMap.size} dots`, 12, H - 14);
}

// Photo thumbnail size (screen px).
const PHOTO_SIZE = 70;

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

function renderStories(colMin, colMax, rowMin, rowMax) {
  const s = view.scale;
  const cellScreen = BASE_CELL * s;

  ctx.font = FONT;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(232,232,232,0.95)";

  // Text footprint grows with zoom, capped at the square-fit size.
  const rawBox = cellScreen * 1.8;
  const dotArea = cellScreen;
  hasPhotos = false;

  for (let row = rowMin; row < rowMax; row++) {
    for (let col = colMin; col < colMax; col++) {
      const idx = row * COLS + col;
      if (NYC_GRID[idx] !== 1) continue;
      const entry = dotMap.get(idx);
      if (!entry) continue;

      if (!entry.capW) {
        const cap = computeFullFitCap(entry.prepared);
        entry.capW = cap.w;
        entry.capH = cap.h;
      }

      const boxW = Math.min(Math.max(rawBox, 30), entry.capW);
      const boxH = Math.min(Math.max(rawBox, LINE_HEIGHT), entry.capH);

      const wx = col * BASE_CELL + BASE_CELL / 2;
      const wy = row * BASE_CELL + BASE_CELL / 2;
      const cx = view.tx + wx * s;
      const cy = view.ty + wy * s;

      // Determine if there's room for the floating photo.
      // Photo appears when dot area (screen) exceeds the text cap + photo size.
      const showPhoto = entry.photoImg && dotArea > entry.capH;
      if (showPhoto) hasPhotos = true;

      let photoScreenX = 0, photoScreenY = 0;
      if (showPhoto) {
        // Update floating physics and draw the photo.
        const f = entry.float;
        const boundsHalfW = BASE_CELL * 0.75;
        const boundsHalfH = BASE_CELL * 0.75;
        f.ox += f.vx * 0.1;
        f.oy += f.vy * 0.1;
        if (f.ox < -boundsHalfW || f.ox > boundsHalfW) { f.vx *= -1; f.ox = clamp(f.ox, -boundsHalfW, boundsHalfW); }
        if (f.oy < -boundsHalfH || f.oy > boundsHalfH) { f.vy *= -1; f.oy = clamp(f.oy, -boundsHalfH, boundsHalfH); }

        photoScreenX = cx + f.ox * s - PHOTO_SIZE / 2;
        photoScreenY = cy + f.oy * s - PHOTO_SIZE / 2;

        ctx.drawImage(entry.photoImg, photoScreenX, photoScreenY, PHOTO_SIZE, PHOTO_SIZE);
      }

      // Lay out text, reflowing around the photo if it's visible.
      const maxLines = Math.max(1, Math.floor(boxH / LINE_HEIGHT));
      const lines = [];
      walkLineRanges(entry.prepared, boxW, (line) => {
        if (lines.length < maxLines) lines.push(materializeLineRange(entry.prepared, line));
      });

      const blockH = lines.length * LINE_HEIGHT;
      const textBlockLeft = cx - boxW / 2;
      let y = cy - blockH / 2;

      ctx.fillStyle = "rgba(232,232,232,0.95)";
      ctx.font = FONT;
      ctx.textBaseline = "top";
      ctx.textAlign = "left";

      for (const line of lines) {
        const overlapsPhoto = showPhoto &&
          y + LINE_HEIGHT > photoScreenY && y < photoScreenY + PHOTO_SIZE;

        let lx = textBlockLeft;
        if (overlapsPhoto) {
          const pLeft = photoScreenX - 2;
          const pRight = photoScreenX + PHOTO_SIZE + 2;
          // Two available regions: left of photo, right of photo.
          // Fill left region first, then continue in right region.
          let inRightRegion = false;
          for (const ch of line.text) {
            const cw = getCharWidth(ch);
            if (!inRightRegion && lx + cw > pLeft) {
              // Hit the photo — jump to right region.
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
    }
  }
}

// Draws any in-progress drafts from peers as "live text" inside their target dots,
// with a pulsing ring to show someone is writing right there.
function renderDrafts() {
  const s = view.scale;
  const cellScreen = BASE_CELL * s;
  const now = performance.now();
  const pulse = 0.5 + 0.5 * Math.sin(now / 400);

  for (const [id, d] of liveDrafts) {
    if (d.dotIndex == null) continue;
    const col = d.dotIndex % COLS;
    const row = Math.floor(d.dotIndex / COLS);
    const wx = col * BASE_CELL + BASE_CELL / 2;
    const wy = row * BASE_CELL + BASE_CELL / 2;
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

    // Draft text (name + story so far). Only if there's content.
    const text = `${d.name || ""}${d.story ? "\n" + d.story : ""}`.trim();
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
  const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * factor));
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
const pointerDown = new Map(); // id -> { x0, y0, moved }

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pointerDown.set(e.pointerId, { x0: e.clientX, y0: e.clientY, moved: false });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
    pinchStartScale = view.scale;
    pinchCenter = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
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
  // Treat as a click if the pointer barely moved AND no pinch was active.
  if (pd && !pd.moved && pointers.size === 0) {
    handleCanvasClick(e.clientX, e.clientY);
  }
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("pointerleave", endPointer);

// ---- click to write ----
function handleCanvasClick(sx, sy) {
  // Find nearest land dot to the click.
  const w = screenToWorld(sx, sy);
  const col = Math.round((w.x - BASE_CELL / 2) / BASE_CELL);
  const row = Math.round((w.y - BASE_CELL / 2) / BASE_CELL);
  if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return;
  const idx = row * COLS + col;
  if (NYC_GRID[idx] !== 1) return;
  openWriter(idx, sx, sy);
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
      video: { facingMode: "user", width: 160, height: 160 },
      audio: false,
    });
    cameraPreview.srcObject = cameraStream;
  } catch (err) {
    console.warn("camera not available:", err);
    cameraPreview.hidden = true;
    btnCapture.hidden = true;
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
  cameraPreview.srcObject = null;
}

btnCapture.addEventListener("click", () => {
  const snapCtx = cameraSnap.getContext("2d");
  snapCtx.drawImage(cameraPreview, 0, 0, 80, 80);
  capturedPhoto = cameraSnap.toDataURL("image/jpeg", 0.7);
  cameraThumb.src = capturedPhoto;
  cameraThumb.hidden = false;
  cameraPreview.hidden = true;
  btnCapture.hidden = true;
  btnRetake.hidden = false;
  stopCamera();
});

btnRetake.addEventListener("click", () => {
  capturedPhoto = null;
  startCamera();
});

function openWriter(dotIndex, nearX, nearY) {
  authoringDotIndex = dotIndex;
  writerLoc.textContent = `dot #${dotIndex}`;
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
  stopCamera();
  capturedPhoto = null;
  cameraThumb.hidden = true;
  if (authoringDotIndex != null && cancel) {
    socket.emit("draft:cancel");
  }
  authoringDotIndex = null;
  writerName.value = "";
  writerSpot.value = "";
  writerStory.value = "";
}

function broadcastDraft() {
  if (authoringDotIndex == null) return;
  socket.emit("draft:update", {
    dotIndex: authoringDotIndex,
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
  if (authoringDotIndex == null) return;
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
      dotIndex: authoringDotIndex,
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
  }
});

// ---- init ----
window.addEventListener("resize", resize);
resize();
fitToViewport();
render();
loadStories();

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
