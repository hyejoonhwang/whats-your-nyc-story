const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const NeDB = require("@seald-io/nedb");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));
app.use("/vendor/pretext", express.static("node_modules/@chenglou/pretext/dist"));
app.use(express.json({ limit: "2mb" }));

const stories = new NeDB({ filename: "data/stories.db", autoload: true });

// Seed a handful of demo stories on first boot so Step 3's text rendering has something to show.
(async () => {
  const count = await stories.countAsync({});
  if (count > 0) return;
  const COLS = 58, ROWS = 76;
  const demo = [
    { col: 26, row: 40, title: "first kiss", name: "M", spot: "East Village", story: "There was a small bar with red lights and everyone was singing along to a song I'd never heard before." },
    { col: 22, row: 48, title: "subway cry", name: "anon", spot: "Delancey", story: "I sat on the N platform and cried for an hour. Nobody noticed. A rat ate a whole pizza slice in front of me." },
    { col: 30, row: 30, title: "ferry home", name: "Sarah", spot: "Astoria", story: "The ferry from midtown to Astoria at sunset. Every time, my chest loosens a little." },
    { col: 24, row: 55, title: "처음 만난 곳", name: "지혜", spot: "K-town", story: "엄마랑 처음 뉴욕에서 만난 날. 우리 둘 다 길을 잃었는데 웃었다." },
    { col: 40, row: 20, title: "100° day", name: "J", spot: "Flushing", story: "August. The whole block smelled like hot asphalt and mango. I bought a popsicle and it melted in 30 seconds." },
    { col: 18, row: 62, title: "got fired", name: "anon", spot: "Soho", story: "I walked out of the office and stood in the middle of Broadway and felt nothing for a long time, then everything." },
    { col: 35, row: 45, title: "NYE", name: "Tomoko", spot: "Williamsburg Bridge", story: "We walked across the bridge at 11:58pm and made it halfway when the fireworks started." },
    { col: 45, row: 35, title: "dance", name: "L", spot: "Bushwick", story: "The warehouse was freezing until it wasn't and then everyone was sweating and smiling." },
    { col: 26, row: 40, title: "lost my dog", name: "R", spot: "Tompkins Sq", story: "He came back three hours later with someone's sandwich in his mouth." },
    { col: 15, row: 70, title: "home", name: "Min", spot: "Staten Island", story: "The ferry ride back felt longer at night but I liked it that way." },
  ];
  const now = Date.now();
  for (let i = 0; i < demo.length; i++) {
    const d = demo[i];
    const dotIndex = d.row * COLS + d.col;
    await stories.insertAsync({
      dotIndex,
      name: d.name,
      spot: d.spot,
      story: d.story,
      title: d.title,
      drawing: null,
      timestamp: now + i,
    });
  }
  console.log(`seeded ${demo.length} demo stories`);
})();

app.get("/stories", async (req, res) => {
  const all = await stories.findAsync({});
  res.json({ stories: all });
});

app.get("/stories/:dotIndex", async (req, res) => {
  const dotIndex = parseInt(req.params.dotIndex);
  const results = await stories.findAsync({ dotIndex });
  res.json({ stories: results });
});

app.post("/submit", async (req, res) => {
  const { dotIndex, name, spot, story, title, drawing, photo } = req.body;
  if (!name || !spot || !story) {
    return res.json({ success: false, message: "please fill in all fields" });
  }
  const doc = {
    dotIndex: parseInt(dotIndex),
    name,
    spot,
    story,
    title: title || story.slice(0, 20),
    drawing: drawing || null,
    photo: photo || null,
    timestamp: Date.now(),
  };
  const saved = await stories.insertAsync(doc);
  io.emit("story:commit", saved);
  res.json({ success: true, story: saved });
});

// Active cursors by socket id: { wx, wy, color, t }. World coords, so they land
// in the same place on every viewer regardless of that viewer's zoom/pan.
const cursors = new Map();

// Active in-progress drafts by socket id: { dotIndex, name, spot, story, color }
const drafts = new Map();

function pickColor(id) {
  // Deterministic hue per socket so the user sees a stable color for each peer.
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 70%, 65%)`;
}

io.on("connection", (socket) => {
  console.log("client connected:", socket.id);

  const color = pickColor(socket.id);

  // Send the new client the current set of peer cursors + active drafts.
  const peers = {};
  for (const [id, c] of cursors) peers[id] = c;
  const activeDrafts = {};
  for (const [id, d] of drafts) activeDrafts[id] = d;
  socket.emit("cursors:init", { self: { id: socket.id, color }, peers, drafts: activeDrafts });

  // Tell everyone else there's a new cursor (empty position until first move).
  socket.broadcast.emit("cursor:join", { id: socket.id, color });

  socket.on("cursor:move", ({ wx, wy }) => {
    const c = cursors.get(socket.id) || { color };
    c.wx = wx;
    c.wy = wy;
    c.t = Date.now();
    cursors.set(socket.id, c);
    socket.broadcast.emit("cursor:move", { id: socket.id, wx, wy });
  });

  socket.on("draft:update", (draft) => {
    // draft = { dotIndex, name, spot, story }
    const d = { ...draft, color };
    drafts.set(socket.id, d);
    socket.broadcast.emit("draft:update", { id: socket.id, draft: d });
  });

  socket.on("draft:cancel", () => {
    drafts.delete(socket.id);
    socket.broadcast.emit("draft:end", { id: socket.id });
  });

  socket.on("disconnect", () => {
    console.log("client disconnected:", socket.id);
    cursors.delete(socket.id);
    drafts.delete(socket.id);
    socket.broadcast.emit("cursor:leave", { id: socket.id });
    socket.broadcast.emit("draft:end", { id: socket.id });
  });
});

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`server running on http://localhost:${PORT}`);
});
