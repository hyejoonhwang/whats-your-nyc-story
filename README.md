# What's Your NYC Story?

A real-time, zoomable, collaborative pinboard of New York City made of stories.

🌐 **Live at [whatsyournycstory.live](https://whatsyournycstory.live)**

NYC is rendered as a vintage paper map. When you click a spot that holds your story, a sticky-note popup appears — write your name, the place, what happened, and snap a quick selfie. Submit it and your post-it gets pinned to the map at the exact spot you clicked. Anyone visiting the site sees it live: cursors drift across the map in real time, others' typing pulses on their dots as they write, and new pins drop onto the map the moment they're posted.

Zoom out and the city is dotted with **3D ball-head pins** — one per story, color-coded, clustered around their spots. Zoom in and the pins fade into **paper post-its** with the actual stories typed on them, each pinned with its own ball-head, slightly tilted, casting drop shadows on the cream paper underneath. Click through stacked post-its with a small `1/n →` indicator. Drag any post-it freely (it snaps back to its real location on refresh).

## Built on Pretext

The text layout inside every post-it uses Cheng Lou's [`@chenglou/pretext`](https://github.com/chenglou/pretext) — a canvas text layout library that makes per-zoom reflow fast enough that the post-its can keep growing as you zoom in, with the text rewrapping smoothly to fit each new size. Pretext is also what powers the live-drafting layer: as a peer types into their post-it, every other viewer sees the text being laid out letter-by-letter on the canvas in real time.

## Features

### Map
- **Vintage paper background** rendered from real NYC borough boundaries (NYC OpenData / ArcGIS), with a letterbox projection that preserves NYC's true aspect ratio
- **Five progressive map layers** that fade in as you zoom: borough fills → neighborhood (NTA) outlines → parks → major streets → all 47k built streets
- **Paper grain texture** + edge vignette for the printed-on-paper feel
- **Italic Georgia serif borough labels** that scale with zoom

### Stories
- **Pin at exact world coords** — click anywhere on land to drop a pin precisely where your story happened (no grid snapping)
- **3D-shaded ball-head pins** at zoom-out via canvas radial gradients (highlight upper-left, dark rim lower-right)
- **Tilted paper post-its** at zoom-in — each with its own seeded color, tilt, drop shadow, paper grain, top pin
- **Stacked clusters** with arrow nav (`1/n →`) when multiple stories are posted at the same spot
- **Draggable** in the current session — refresh and they snap back to their canonical positions
- **Photo + text reflow around the actual figure silhouette**, not its bounding box

### Camera & photos
- **Mirrored selfie preview** for natural orientation
- **Background removal via [MediaPipe Selfie Segmentation](https://google.github.io/mediapipe/solutions/selfie_segmentation.html)** — captured photos have their backgrounds made transparent automatically, so just the person ends up on the post-it
- **Old JPEG photos auto-reprocess** in the background and are saved back to the server as transparent PNGs
- **Per-row alpha-channel sampling** drives the text reflow, so the story text actually wraps around the curve of the figure's outline

### Multi-user
- **Live cursors** — every connected viewer sees every other viewer's mouse position drifting across the map (throttled to 10fps, interpolated client-side)
- **Live drafting** — as a peer types in their writer popup, every other viewer sees a pulsing ring at the click location and the text appearing letter-by-letter on the page
- **Story commits** broadcast over Socket.io — newly submitted stories appear instantly on every connected client

### Safety
- **Gemini moderation** on every submission — local hard-block list catches obvious profanity / slurs / prompt injection instantly, then [Gemini 2.5 Flash](https://deepmind.google/technologies/gemini/) reviews the rest with a nonce-delimited prompt that's resistant to injection attacks
- **Land-only placement** — clicks in water (rivers, harbor, NJ side) are silently rejected via point-in-polygon against the borough geometry
- **Inline confirmation modal** if you click outside the writer with unsaved content

### Intro panel
A **fixed corkboard** in the upper-left of the viewport with three pinned papers: project title, a personal note about why the project exists, and a 4-step how-to.

## Stack

- **Node.js + Express 5** server
- **Socket.io** for real-time presence, typing, and story commits
- **NeDB** for persistent story + photo storage
- **[@chenglou/pretext](https://github.com/chenglou/pretext)** for canvas text layout
- **[MediaPipe Selfie Segmentation](https://google.github.io/mediapipe/solutions/selfie_segmentation.html)** (lazy-loaded from CDN) for background removal
- **[Gemini 2.5 Flash](https://deepmind.google/technologies/gemini/)** for content moderation
- **NYC OpenData / ArcGIS** GeoJSON for boroughs, neighborhoods, parks, streets
- **dotenv** for API key management
- **Vanilla JS** on the client — no framework

## Getting Started

```bash
git clone https://github.com/hyejoonhwang/whats-your-nyc-story.git
cd whats-your-nyc-story
npm install
npm start
```

Then open http://localhost:5001 in two browser windows to see live sync working.

For dev with auto-reload:

```bash
npm run dev
```

### Optional: enable Gemini moderation

Create a `.env` file in the project root:

```
GEMINI_API_KEY=your_gemini_api_key_here
```

Without the key, moderation falls back to the hard-block regex list only (still functional, just less nuanced). Get a key from [Google AI Studio](https://aistudio.google.com/).

## Project Structure

```
server.js                       Express + Socket.io + NeDB + Gemini moderation
public/
  index.html                    Single-page canvas client
  app.js                        Renderer, viewport transform, pin/post-it logic, socket client
  grid.js                       58×76 binary NYC land/water grid (generated from boroughs)
  style.css                     Writer popup styling
  map-styles.html               Standalone vintage-map demo (zoomable, with progressive layers)
  sandbox.html                  Blob-interaction sandbox (early design exploration)
  data/                         GeoJSON layers (boroughs, neighborhoods, parks, streets)
data/stories.db                 NeDB persistent store (gitignored)
.github/workflows/deploy.yml    Auto-deploy to Digital Ocean droplet on push to main
```

## Deployment

Live at https://whatsyournycstory.live, hosted on a small Digital Ocean droplet alongside other ITP class projects.

Push to `main` triggers a GitHub Actions workflow that SSHes into the droplet, runs `git pull && npm install && pm2 restart`. End-to-end deploy takes ~30 seconds. SSL via Let's Encrypt with auto-renewal.

See [BLOG.md](./BLOG.md) for the full process writeup.

## Roadmap

See [PLAN.md](./PLAN.md) for the original build plan and [PROCESS_LOG.md](./PROCESS_LOG.md) for ongoing notes.

## Contributing

Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License

[MIT](./LICENSE) — same as Pretext, the upstream project this is built on.

## Credits

- **[Pretext](https://github.com/chenglou/pretext)** by Cheng Lou — the canvas text layout engine that makes the typography on every post-it possible.
- **[MediaPipe Selfie Segmentation](https://google.github.io/mediapipe/solutions/selfie_segmentation.html)** by Google — the open-source ML model that removes photo backgrounds in-browser.
- **[NYC OpenData](https://opendata.cityofnewyork.us/)** — borough, neighborhood, park, and street GeoJSON.
- Original *Dot Your Story* project by Summer Hwang (the asynchronous predecessor this evolved from).
- Built for ITP Live Web (Spring 2026), and as the open-source class project at NYU ITP.
