// skrypt/llm/diffEngine.js
import { mongoClient } from '../polaczenieMDB.js';

const db = mongoClient.db(process.env.MONGO_DB || 'inzynierka');
const snapshotsCol = db.collection('snapshots');
const analizyCol = db.collection('analizy');

// Znajdź poprzedni snapshot tego samego monitora (starszy po ts)
export async function getPreviousSnapshot(currentSnapshot) {
  if (!currentSnapshot) return null;

  const query = {
    monitor_id: currentSnapshot.monitor_id,
    ts: { $lt: currentSnapshot.ts },
  };

  const prev = await snapshotsCol
    .find(query)
    .sort({ ts: -1 })
    .limit(1)
    .next();

  return prev || null;
}

// Bardzo prosty score różnicy tekstu (0 = identyczny, 1 = zupełnie inny)
function simpleTextDiffScore(a, b) {
  if (!a && !b) return 0;
  if (!a || !b) return 1;
  if (a === b) return 0;

  const aWords = new Set(a.split(/\s+/).filter(Boolean));
  const bWords = new Set(b.split(/\s+/).filter(Boolean));

  if (aWords.size === 0 && bWords.size === 0) return 0;

  let intersection = 0;
  for (const w of aWords) {
    if (bWords.has(w)) intersection += 1;
  }

  const union = new Set([...aWords, ...bWords]).size;
  if (union === 0) return 0;

  // im większa różnica, tym bliżej 1
  return 1 - intersection / union;
}

export async function computeMachineDiff(prevSnapshot, newSnapshot) {
  if (!prevSnapshot) {
    return {
      hasAnyChange: false,
      hasSignificantMachineChange: false,
      reasons: ['brak poprzedniego snapshotu'],
      metrics: {},
      prevSnapshotId: null,
      newSnapshotId: newSnapshot?._id ?? null,
    };
  }

  const prev = prevSnapshot.extracted_v2 || {};
  const now = newSnapshot.extracted_v2 || {};

  const reasons = [];
  const metrics = {};

  // 0) Zmiana cen z pluginu (plugin_prices na snapshotach)
  const prevPluginPrices = Array.isArray(prevSnapshot.plugin_prices)
    ? prevSnapshot.plugin_prices
    : [];
  const nowPluginPrices = Array.isArray(newSnapshot.plugin_prices)
    ? newSnapshot.plugin_prices
    : [];

  if (JSON.stringify(prevPluginPrices) !== JSON.stringify(nowPluginPrices)) {
    metrics.pluginPricesChanged = true;
    reasons.push('zmiana cen z pluginu');
  } else {
    metrics.pluginPricesChanged = false;
  }

  // 1) Zmiana ceny z extractora
  if (prev.price && now.price) {
    const oldVal = prev.price.value;
    const newVal = now.price.value;

    if (typeof oldVal === 'number' && typeof newVal === 'number') {
      const absChange = newVal - oldVal;
      const relChange = oldVal !== 0 ? absChange / oldVal : null;

      metrics.price = { oldVal, newVal, absChange, relChange };

      if (absChange !== 0) {
        reasons.push(
          `zmiana ceny z ${oldVal} na ${newVal} (Δ=${absChange}, rel=${relChange})`,
        );
      }
    }
  }

  // 2) Zmiana tytułu
  if (prev.title !== now.title) {
    metrics.titleChanged = true;
    reasons.push('zmiana tytułu strony');
  } else {
    metrics.titleChanged = false;
  }

  // 3) Zmiana opisu
  if (prev.description !== now.description) {
    metrics.descriptionChanged = true;
    reasons.push('zmiana opisu strony');
  } else {
    metrics.descriptionChanged = false;
  }

  // 4) Zmiana tekstu (score)
  const prevText = prev.text || '';
  const nowText = now.text || '';
  const textDiffScore = simpleTextDiffScore(prevText, nowText);
  metrics.textDiffScore = textDiffScore;

  if (textDiffScore > 0.05) {
    reasons.push(`zmiana treści strony (score ~${textDiffScore.toFixed(3)})`);
  }

  // 5) Liczba obrazków
  const prevImages = (prev.images || []).length;
  const nowImages = (now.images || []).length;
  metrics.imagesCount = { prev: prevImages, now: nowImages };

  if (prevImages !== nowImages) {
    reasons.push('zmieniła się liczba obrazów / ofert');
  }

  const hasAnyChange = reasons.length > 0;

  // Heurystyka „czy to istotne” bez LLM:
  let hasSignificantMachineChange = false;

  // istotna zmiana ceny z extractora
  if (metrics.price && metrics.price.relChange != null) {
    if (Math.abs(metrics.price.relChange) >= 0.05) {
      hasSignificantMachineChange = true;
    }
  }

  // istotna zmiana treści
  if (textDiffScore > 0.15) {
    hasSignificantMachineChange = true;
  }

  // istotna zmiana cen z pluginu
  if (metrics.pluginPricesChanged) {
    hasSignificantMachineChange = true;
  }

  return {
    hasAnyChange,
    hasSignificantMachineChange,
    reasons,
    metrics,
    prevSnapshotId: prevSnapshot._id,
    newSnapshotId: newSnapshot._id,
  };
}

export async function getSnapshotAnalysis(snapshotId) {
  return analizyCol.findOne({
    snapshot_id: snapshotId,
    type: 'snapshot',
  });
}

