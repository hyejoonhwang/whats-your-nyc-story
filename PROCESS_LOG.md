# Process Log — Dot Your Story, Live

Running log of what's been done, decisions made, and where to pick up next. Read this first when resuming work.

---

## How to use this file

- **Each work session** → add a new dated entry at the bottom
- **At session end** → fill in "Next up" so resume is frictionless
- **Decisions & gotchas** → log them inline with the session so future-me knows *why*
- Steps refer to the build plan in `PLAN.md`

---

## Current status

- **Active step:** Step 6 complete ✅ — cursor presence + live typing both working
- **Next up:** Step 7 — live drawing layer (small canvas in popup, strokes stream to peers)
- **Deferred:** Step 4 (title competition) — not needed with current bounded-box design
- **Blockers:** none

## How to run

```
cd /Users/summer/Desktop/apps/dotyourstory-live
npm install          # first time only
node server.js       # then open http://localhost:5001
```

---

## Session log

### 2026-04-16 — Steps 5+6 complete
- Step 5: cursor presence — server tracks cursors per socket, broadcasts at 10fps, clients interpolate positions at 60fps. Each user gets a deterministic hue color. Cursors render as small triangles in world coords (stable across zoom/pan)
- Step 6: live typing — click any land dot → writer overlay form (name, spot, story). On `input`, emit `draft:update` via socket. Peers see in-progress text render inside the dot's footprint with a pulsing ring. On submit: POST `/submit`, server inserts to NeDB + broadcasts `story:commit`, all clients ingest and re-render. Draft clears on submit or close
- Fixed TDZ bug: `peers` and `liveDrafts` declarations moved above first `render()` call
- Added click-vs-drag detection: track pointer-down origin, only fire `handleCanvasClick` if pointer moved <5px
- **Next up:** Step 7 — live drawing layer

---

### 2026-04-15 — Step 3 complete
- Installed `@chenglou/pretext` (v0.0.5, 0 deps, pure ES modules)
- Server: mounts `/vendor/pretext/*` pointing at `node_modules/@chenglou/pretext/dist/`. Seeds 10 demo stories (NYC locations + English/Korean mix) on empty DB
- Client: converted `app.js` to ES module; imports `prepareWithSegments`, `walkLineRanges`, `measureNaturalWidth`, `materializeLineRange`
- Each dot with a story is replaced by a **bounded text box** centered on the dot location. Text starts with writer name, then story. Box grows with zoom but caps at a roughly-square shape once full text fits (`computeFullFitCap`) — so text never stretches into a single flat line
- Font constant at 10px monospace for readability at any zoom; boxes show as much text as fits (`maxLines = floor(boxH / LINE_HEIGHT)`)
- **Decision:** skipping Step 4 (title competition between dots) — the bounded-box approach naturally allocates space per dot; competition logic was for a different rendering scheme
- **User feedback incorporated:** stories must fill 2D area around dot (not trail horizontally), bounded in both width and height, show name first, stop growing once full text fits
- **Next up:** Step 5 — add Socket.io cursor presence, see other users moving live

---

### 2026-04-15 — Step 2 complete
- Added viewport transform: `view = { scale, tx, ty }` in world units (grid = 58×76 cells × 12px = 696×912 world pixels)
- 3 zoom tiers defined: CITY (<2x), BOROUGH (2–5x), BLOCKS (≥5x). HUD shows current tier + scale in bottom-left
- Desktop: mouse wheel zooms at cursor, click-drag pans
- Mobile: Pointer Events API handles single-finger pan and two-finger pinch-zoom (anchored at pinch center)
- Culling: only draws dots in the visible world rect (prep for scaling up text work in Step 3)
- `fitToViewport()` centers the NYC grid on load
- **Decision:** used Pointer Events (unified API) instead of separate mouse/touch handlers — cleaner and handles trackpad pinch on Mac for free
- **Decision:** tier thresholds are preliminary; will likely tune in Step 3 once text is on screen and we can see when titles should fade in
- **Next up:** Step 3 — add Pretext, render stored stories as text inside dot footprints at each tier

---

### 2026-04-15 — Step 1 complete
- Scaffolded fresh project at `/Users/summer/Desktop/apps/dotyourstory-live/`
- Source project: `/Users/summer/Desktop/apps/DynamicWebDev/project-final/` (ported grid data + NeDB schema)
- Created: `package.json`, `server.js`, `public/{index.html,app.js,grid.js,style.css}`
- Deps: express 5, socket.io 4, @seald-io/nedb
- Server: Express 5 + Socket.io + NeDB on port 5001; GET `/stories`, GET `/stories/:dotIndex`, POST `/submit`
- Client: full-viewport canvas, auto-resizes with DPR support, renders NYC grid centered + padded
- Smoke tested: server boots, `/` returns 200, `/stories` returns `{stories: []}`
- **Decision:** kept NeDB schema identical to v1 (dotIndex, name, spot, story, timestamp) + added `title` and `drawing` fields for future steps
- **Decision:** using Express 5 async/await (`findAsync`, `insertAsync`) instead of callback style — cleaner for the socket broadcast logic later
- **Next up:** Step 2 — pan/zoom with 3 zoom tiers, mobile pinch support

---

### 2026-04-15 — Kickoff
- Ideated final project concept in a prior Claude conversation (see PLAN.md Context)
- Confirmed scope decisions:
  - Fresh project (not a fork of existing Dot Your Story)
  - Hosting: Digital Ocean droplet
  - Mobile in scope for v1 (pinch zoom + touch drawing)
  - Drawings invisible at zoom-out, only visible inside zoomed-in popup
  - Competition rule: recency wins within a dot, density wins between dots
- Created project folder at `/Users/summer/Desktop/apps/dotyourstory-live/`
- Wrote PLAN.md and PROCESS_LOG.md
- **Next up:** Step 1 — scaffold Express + Socket.io server, pull existing 58×76 grid data, render NYC shape on canvas as sanity check

---

## Open questions to resolve later

- Where is the existing Dot Your Story repo located? (need to pull grid data + NeDB schema)
- Digital Ocean droplet: reuse existing one or spin up new?
- Domain/subdomain for the live version?

---

## Decisions made

| Date | Decision | Reason |
|------|----------|--------|
| 2026-04-15 | Fresh project, not a fork | Canvas-first architecture without DOM baggage from original |
| 2026-04-15 | Keep NeDB (not Postgres) | Sufficient for class scope; migration is post-class work |
| 2026-04-15 | Mobile in v1 | KANA/ITP demo audience will open on phones |
| 2026-04-15 | Drawings hidden at zoom-out | Keeps typographic read clean; reduces render cost |
