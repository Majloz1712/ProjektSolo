// tools/exportScreenshots.js
// Użycie:
//   node tools/exportScreenshots.js --snapshot-id 694bd86d389ee8a475dfb67e --out exports --format jpg
//   node tools/exportScreenshots.js --last 5 --out exports --format png
//
// ENV:
//   MONGO_URL=mongodb://127.0.0.1:27017
//   MONGO_DB=inzynierka

import fs from "node:fs";
import path from "node:path";
import { MongoClient, ObjectId } from "mongodb";

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

function stripPrefix(b64) {
  if (!b64 || typeof b64 !== "string") return null;
  return b64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
}

function detectExtFromBase64(b64) {
  // bardzo proste heurystyki po nagłówku base64
  // PNG zaczyna się od iVBORw0...
  // JPG zaczyna się od /9j/
  if (!b64) return null;
  if (b64.startsWith("iVBOR")) return "png";
  if (b64.startsWith("/9j/")) return "jpg";
  return null;
}

async function main() {
  const mongoUrl = process.env.MONGO_URL || "mongodb://127.0.0.1:27017";
  const dbName = process.env.MONGO_DB || "inzynierka";

  const outDir = arg("--out") || "exports";
  const format = (arg("--format") || "jpg").toLowerCase(); // "jpg" lub "png"

  const snapshotId = arg("--snapshot-id");
  const lastN = arg("--last") ? Number(arg("--last")) : null;

  if (!snapshotId && !lastN) {
    console.log("Podaj --snapshot-id <id> albo --last <N>");
    process.exit(1);
  }
  if (!["jpg", "jpeg", "png"].includes(format)) {
    console.log("Format tylko: jpg/jpeg/png");
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });

  const client = new MongoClient(mongoUrl);
  await client.connect();
  const db = client.db(dbName);

  const snapshotsCol = db.collection("snapshots");

  let docs = [];
  if (snapshotId) {
    docs = await snapshotsCol
      .find({ _id: new ObjectId(snapshotId) })
      .limit(1)
      .toArray();
  } else {
    docs = await snapshotsCol
      .find({})
      .sort({ createdAt: -1, _id: -1 })
      .limit(Math.max(1, lastN))
      .toArray();
  }

  if (!docs.length) {
    console.log("Nie znaleziono snapshotów.");
    await client.close();
    return;
  }

  for (const s of docs) {
    const id = String(s._id);
    const url = s.url || "";
    const monitorId = s.monitor_id || "";
    const b64raw = s.screenshot_b64 || null;

    if (!b64raw) {
      console.log(`[skip] ${id} brak screenshot_b64`);
      continue;
    }

    const b64 = stripPrefix(b64raw);
    if (!b64) {
      console.log(`[skip] ${id} screenshot_b64 pusty`);
      continue;
    }

    const buf = Buffer.from(b64, "base64");

    // jeśli w base64 jest PNG/JPG a user chce inny format, to bez konwersji nie zmienimy.
    // (tu robimy "zapis surowy". Jeśli chcesz KONWERSJĘ, dopiszę wariant z sharp.)
    const extGuess = detectExtFromBase64(b64) || "bin";
    const ext = format === "jpeg" ? "jpg" : format;

    const safeMonitor = String(monitorId).slice(0, 12);
    const file = path.join(outDir, `snapshot_${id}_${safeMonitor}.${ext}`);

    fs.writeFileSync(file, buf);
    console.log(`[ok] zapisano: ${file} (guess:${extGuess}) url=${url}`);
  }

  await client.close();
}

main().catch((e) => {
  console.error("Błąd:", e);
  process.exit(1);
});
