# What's Your NYC Stories?

A real-time, zoomable, collaborative canvas of New York City made of stories.

NYC is rendered as a 58×76 dot grid. Every dot can hold stories and drawings written by anyone. As more stories pile into a dot, its title competes for space against its neighbors — recency wins inside a dot, density wins between dots — so the map literally rearranges itself as a typographic pressure system as people write into it.

This is the live, multi-user successor to my asynchronous *Dot Your Story* project, built for NYU ITP's Live Web final and submitted as the open-source class project.

## Built on top of [Pretext](https://github.com/chenglou/pretext)

The load-bearing dependency is [`@chenglou/pretext`](https://github.com/chenglou/pretext), a canvas text layout library by Cheng Lou. Pretext is what makes per-keystroke and per-zoom reflow across the entire map fast enough to feel alive — laying out hundreds of titles on `<canvas>` at 60fps, instead of fighting the DOM.

This project is an open-source extension of that ecosystem: a real-world stress test of Pretext driving a typographic map that hundreds of people can reshape at once.

## Features

- 58×76 NYC dot grid rendered on a single `<canvas>`
- Smooth pan + continuous zoom (desktop wheel + mouse drag, mobile pinch + touch)
- Three precomputed zoom tiers (city / borough / blocks) with interpolated transitions
- Pretext-driven title competition: dense neighborhoods crowd out sparse ones in real time
- Live cursors, live typing, live drawing — broadcast over Socket.io
- Permanent archive: every story stays forever, the city grows over time

## Stack

- Node.js + Express 5
- Socket.io for real-time presence, typing, and stroke streaming
- NeDB for persistent story + drawing storage
- `@chenglou/pretext` for canvas text layout
- Vanilla JS on the client — no framework

## Getting Started

```bash
git clone https://github.com/hyejoonhwang/whats-your-nyc-stories.git
cd whats-your-nyc-stories
npm install
npm start
```

Then open http://localhost:5001 in two or more browser windows to see live sync working.

For development with auto-reload:

```bash
npm run dev
```

## Project Structure

```
server.js          Express + Socket.io + NeDB server
public/
  index.html       Single-page canvas client
  app.js           Canvas renderer, viewport transform, Pretext layout cache, socket client
  grid.js          The 58×76 binary NYC grid
  style.css        Minimal styles
data/stories.db    NeDB persistent store
```

## Roadmap

See [PLAN.md](./PLAN.md) for the full step-by-step build plan and [PROCESS_LOG.md](./PROCESS_LOG.md) for ongoing notes.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License

[MIT](./LICENSE) — same as Pretext, the upstream project this is built on.

## Credits

- [Pretext](https://github.com/chenglou/pretext) by Cheng Lou — the canvas text layout engine that makes all of this possible.
- Original *Dot Your Story* project by Summer Hwang.
- Built for ITP Live Web (Spring 2026), and as the open-source class project at NYU ITP.
