# Dot Your Story, Live — Project Workflow

## Context

Extending the existing asynchronous **Dot Your Story** (58×76 NYC dot grid, NeDB-backed Express app) into a real-time, zoomable, collaborative canvas for the Live Web final. The city is rendered as typography: every dot holds stories and drawings, and titles physically compete for space based on recency (within a dot) and density (between dots). **Pretext** (Cheng Lou's canvas text layout library) is the load-bearing dependency — without it, per-keystroke and per-zoom reflow across the whole map cannot hit smooth framerates on the DOM.

The project is both a technical push (canvas text layout, live sync, zoom interpolation) and a conceptual one (the map as a living typographic pressure system). It has a clear before/after arc against the existing portfolio piece.

---

## Scope Recap (already decided)

- **Geography:** NYC only, reuse the existing 58×76 binary grid
- **Input:** text + live drawing (small canvas in the zoomed-in popup)
- **Lifespan:** permanent archive, grows forever
- **Competition rule:** recency wins within a dot; density wins between dots
- **Zoom:** smooth continuous (Google Maps feel), interpolated between 3 precomputed layout levels
- **Starting point:** fresh project, port the 58×76 grid + NeDB schema over (canvas-first architecture, no DOM baggage)
- **Hosting:** Digital Ocean droplet (same pattern as prior Live Web projects)
- **Mobile:** in scope for v1 — pinch zoom + touch drawing
- **Drawings at zoom-out:** invisible; only appear inside the zoomed-in popup

---

## Step-by-Step Build Plan

### Step 1 — Scaffold fresh project, port data
- New repo, canvas-first architecture from day one
- Copy over the 58×76 binary grid array and the NeDB story schema from the existing project
- Basic Express + Socket.io server skeleton, single `<canvas>` client
- Render the NYC shape on canvas as a sanity check
- **Exit criterion:** fresh project renders the NYC dot grid on canvas, server running locally
- **Files:** `server.js`, `public/index.html`, `public/app.js`, `public/grid.js`, `data/stories.db`

### Step 2 — Add pan + zoom to the canvas (desktop + touch)
- Implement viewport transform (scale + translate)
- Desktop: mouse wheel zoom, click-drag pan
- Mobile: pinch zoom (two-finger), single-finger pan — handle pointer events unified
- Define 3 discrete zoom "tiers": city / borough / blocks
- **Exit criterion:** smooth pan/zoom on desktop and phone, tier changes logged

### Step 3 — Integrate Pretext for static text layout
- Add Pretext, use `prepareWithSegments` to measure every stored story once on load
- Cache layouts per zoom tier (city = titles only, borough = title + snippet, blocks = full story)
- Render text on canvas at current zoom, interpolate size/opacity between tiers
- **Exit criterion:** existing archive renders as typography at all zoom levels, no live layer yet
- **Risk checkpoint:** if Pretext integration is painful here, stop and reduce scope before proceeding

### Step 4 — Title competition logic
- Per visible region, run Pretext's `measureNaturalWidth` for every candidate title
- Within a dot: pick the newest story's title (recency wins)
- Between dots: allocate horizontal space proportional to story count (density wins); truncate titles that don't fit with ellipsis
- Recompute only the affected neighborhood when a new story is added
- **Exit criterion:** dense dots visibly crowd out sparse neighbors at zoom-out

### Step 5 — Add Socket.io, presence layer first
- Wire up Socket.io on Express server
- Broadcast cursor positions (throttle to 10fps, interpolate client-side)
- Render every connected viewer's cursor at the correct zoom scale
- **Exit criterion:** open two browser windows, see both cursors moving on each

### Step 6 — Live typing layer
- When a user opens a dot and types, stream keystrokes via socket
- On every client, re-run Pretext layout for that dot and repaint
- Add a pulse animation around the dot being written into (visible at all zoom levels)
- **Exit criterion:** typing in one window appears letter-by-letter in another

### Step 7 — Live drawing layer
- Small canvas inside the zoomed-in popup
- Stream stroke points (batched) over sockets
- Serialize final stroke list to NeDB with the story text on submit
- **Exit criterion:** drawing in one window inks in live on another

### Step 8 — Live reflow on commit
- When a story finalizes, broadcast the commit, every client invalidates the affected neighborhood's Pretext cache and repaints
- The whole neighborhood visibly reorganizes in the same instant for all viewers
- **Exit criterion:** a new story in a dense area visibly pushes neighbors around in real time

### Step 9 — Polish
- Tune pulse animations, zoom easing, monospace type consistency
- Mobile: pinch zoom, tap-to-open
- Performance test with 10+ windows open
- Seed with real stories from KANA / UXC / ITP friends before demo day

### Step 10 — Class demo
- Everyone opens the URL, the map comes alive with 15 people writing simultaneously
- Have a backup recording in case the live demo glitches

---

## Critical Files

- `public/app.js` — canvas renderer, viewport transform, Pretext layout cache, socket client
- `public/draw.js` — drawing canvas + stroke streaming
- `server.js` — Express + Socket.io + NeDB, broadcasts cursors/typing/strokes/commits
- `public/grid.js` — existing 58×76 binary array (reuse as-is)

## Reused Utilities
- Existing NeDB persistence layer (just extend the schema to include `drawing: strokeList[]`)
- Existing 58×76 binary grid data
- Pretext: `prepareWithSegments`, `walkLineRanges`, `measureNaturalWidth`

## Known Risks
- **Pretext is new** — Step 3 is the go/no-go checkpoint; if it blocks, fall back to simpler fixed-size canvas text
- **Socket flooding** — throttle cursors to 10fps, batch drawing strokes
- **Font parameter mismatch** — Pretext's font string must exactly match canvas `ctx.font`
- **Zoom perf** — precompute layouts at the 3 tiers, interpolate between them; don't recompute on every frame

## Verification
- Local: run server, open 3+ browser windows, confirm cursors/typing/drawing sync
- Staging: deploy to Digital Ocean (same pattern as previous class projects), test from mobile
- Demo: full class connects at once, watch the map reorganize live
