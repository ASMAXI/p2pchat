import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const outDir = path.resolve("public/sfx");
await mkdir(outDir, { recursive: true });

async function freesoundPreview(soundId) {
  const page = await fetch(`https://freesound.org/people/x/sounds/${soundId}/`, {
    headers: { "User-Agent": "Mozilla/5.0 DriftSfxBot/1.0" },
    redirect: "follow",
  });
  // Direct preview CDN pattern discovery via search page is flaky; use sounds API-less scrape:
  const html = await (
    await fetch(`https://freesound.org/search/?q=${soundId}`, {
      headers: { "User-Agent": "Mozilla/5.0 DriftSfxBot/1.0" },
    })
  ).text();
  const re = new RegExp(`https://cdn\\.freesound\\.org/previews/\\d+/${soundId}_[0-9]+-hq\\.mp3`, "g");
  const hit = html.match(re)?.[0];
  if (hit) return hit;
  // Try known page URL patterns via google-less: fetch people pages from known IDs below
  return null;
}

async function resolveFreesound(soundId, peopleHint) {
  const urls = [
    peopleHint ? `https://freesound.org/people/${peopleHint}/sounds/${soundId}/` : null,
    `https://freesound.org/s/${soundId}/`,
  ].filter(Boolean);
  for (const u of urls) {
    try {
      const res = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 DriftSfxBot/1.0" }, redirect: "follow" });
      if (!res.ok) continue;
      const html = await res.text();
      const hq = html.match(new RegExp(`https://cdn\\.freesound\\.org/previews/\\d+/${soundId}_\\d+-hq\\.mp3`));
      if (hq) return hq[0];
      const lq = html.match(new RegExp(`https://cdn\\.freesound\\.org/previews/\\d+/${soundId}_\\d+-lq\\.mp3`));
      if (lq) return lq[0];
    } catch {
      // continue
    }
  }
  return null;
}

function mixkit(id) {
  return `https://assets.mixkit.co/active_storage/sfx/${id}/${id}-preview.mp3`;
}

/** Prefer CC0 Freesound; Mixkit License as fallback. */
const SOURCES = [
  { id: "fart", freesound: [445998, "Breviceps"], mixkit: 3050, credit: "Freesound Breviceps 445998 (CC0)" },
  { id: "cry", freesound: [213148, "thefsoundman"], mixkit: 2265, credit: "baby/cry sample" },
  { id: "quack", freesound: [532287, "Sess8it"], mixkit: 1014, credit: "Freesound Sess8it 532287 (CC0)" },
  { id: "trombone", freesound: [362205, "TaranP"], mixkit: 472, credit: "Freesound TaranP 362205 (CC0)" },
  { id: "boom", freesound: [411088, "InspectorJ"], mixkit: 1143, credit: "explosion/impact" },
  { id: "gachi", freesound: [316590, "Timbre"], mixkit: 343, credit: "cartoon moan/grunt parody" },
  { id: "airhorn", freesound: [528807, "pfranzen"], mixkit: 715, credit: "Freesound pfranzen 528807 (CC0)" },
  { id: "laugh", freesound: [327734, "chripei"], mixkit: 424, credit: "laughter" },
  { id: "crickets", freesound: [69439, "guitarguy1985"], mixkit: 17, credit: "Freesound guitarguy1985 69439 (CC0)" },
  { id: "bruh", freesound: [242503, "JoeDregan"], mixkit: 2876, credit: "bass drop / bruh" },
];

const credits = [];

for (const item of SOURCES) {
  let url = null;
  let credit = item.credit;
  if (item.freesound) {
    url = await resolveFreesound(item.freesound[0], item.freesound[1]);
  }
  if (!url && item.mixkit) {
    url = mixkit(item.mixkit);
    credit = `Mixkit #${item.mixkit} (Mixkit License)`;
  }
  if (!url) {
    console.error("NO URL", item.id);
    continue;
  }
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 DriftSfxBot/1.0" } });
  if (!res.ok) {
    console.error("DOWNLOAD FAIL", item.id, url, res.status);
    // last resort mixkit
    if (item.mixkit) {
      const fallback = mixkit(item.mixkit);
      const r2 = await fetch(fallback);
      if (r2.ok) {
        const buf = Buffer.from(await r2.arrayBuffer());
        await writeFile(path.join(outDir, `${item.id}.mp3`), buf);
        credits.push(`${item.id}.mp3 — Mixkit #${item.mixkit} (Mixkit License)`);
        console.log("OK mixkit fallback", item.id, buf.length);
        continue;
      }
    }
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 800) {
    console.error("TOO SMALL", item.id, buf.length);
    continue;
  }
  await writeFile(path.join(outDir, `${item.id}.mp3`), buf);
  credits.push(`${item.id}.mp3 — ${credit} — ${url}`);
  console.log("OK", item.id, buf.length, url);
}

await writeFile(path.join(outDir, "CREDITS.txt"), credits.join("\n") + "\n");
console.log("\nWrote", credits.length, "files + CREDITS.txt");
