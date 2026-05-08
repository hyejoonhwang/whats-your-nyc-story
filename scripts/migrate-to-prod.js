// One-shot migration: copy three legit local stories (cathy, tunapee, Ivan)
// up to the production server via the public /submit endpoint, then
// re-attach Ivan's lone comment via /story/:id/comment.
//
// Usage:
//   node scripts/migrate-to-prod.js https://whatsyournycstory.live
//   PROD_URL=https://whatsyournycstory.live node scripts/migrate-to-prod.js
//
// Notes:
//   - Each /submit goes through Gemini moderation on the prod side, which
//     adds ~3–5 s per call. The script runs serially (no parallelism) so
//     you get a clear log line for each story.
//   - The original timestamps are NOT preserved — prod's /submit stamps
//     `timestamp: Date.now()` server-side. These three will appear at the
//     "top" of the chronology. Fine for the show, doesn't affect rendering.
//   - The original `_id` is also not preserved; prod generates a new one.
//     The script reads the new _id back from the /submit response so it
//     can re-attach the matching comment.

const NeDB = require("@seald-io/nedb");

const PROD_URL =
  process.argv[2] ||
  process.env.PROD_URL ||
  "https://whatsyournycstory.live";

const PICKS = [
  { name: "cathy",            spot: "370 baby" },
  { name: "tunapee is here!", spot: "ceren's house" },
  { name: "Ivan",             spot: "ITP floor before breakdown" },
];

function matches(story, pick) {
  return story.name === pick.name && story.spot === pick.spot;
}

async function postStory(story) {
  const body = {
    wx: story.wx,
    wy: story.wy,
    name: story.name,
    spot: story.spot,
    story: story.story,
    title: story.title || (story.story || "").slice(0, 20),
    photo: story.photo || null,
  };
  const res = await fetch(`${PROD_URL}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function postComment(storyId, comment) {
  const res = await fetch(`${PROD_URL}/story/${storyId}/comment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: comment.name, text: comment.text }),
  });
  return res.json();
}

(async () => {
  console.log(`→ migrating to ${PROD_URL}\n`);

  const db = new NeDB({ filename: "data/stories.db", autoload: true });
  const all = await db.findAsync({});

  const picked = [];
  for (const pick of PICKS) {
    const found = all.find((s) => matches(s, pick));
    if (!found) {
      console.warn(`  ⚠ not found locally: ${pick.name} / ${pick.spot} — skipping`);
      continue;
    }
    picked.push(found);
  }

  if (!picked.length) {
    console.error("nothing to migrate");
    process.exit(1);
  }

  let okCount = 0, failCount = 0;

  for (const story of picked) {
    const photoTag = story.photo ? "📷" : "  ";
    const commentCount = (story.comments || []).length;
    process.stdout.write(`${photoTag}  ${story.name} / ${story.spot}  →  `);

    let resp;
    try {
      resp = await postStory(story);
    } catch (err) {
      console.log(`network error: ${err.message}`);
      failCount++;
      continue;
    }

    if (!resp.success) {
      console.log(`REJECTED: ${resp.message || "(no message)"}`);
      failCount++;
      continue;
    }

    const newId = resp.story?._id || resp._id;
    console.log(`OK  (new _id: ${newId})`);
    okCount++;

    // Re-attach comments under the new _id.
    if (commentCount > 0) {
      for (const c of story.comments) {
        process.stdout.write(`     ↳ comment from ${c.name}: `);
        try {
          const cr = await postComment(newId, c);
          console.log(cr.success ? "OK" : `REJECTED: ${cr.message}`);
        } catch (err) {
          console.log(`network error: ${err.message}`);
        }
      }
    }
  }

  console.log(`\ndone — ${okCount} migrated, ${failCount} failed`);
  process.exit(0);
})().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
