// skrypt/pipelineZmian.js
import { mongoClient } from '../polaczenieMDB.js';
import { ObjectId } from 'mongodb';
import { ensureSnapshotAnalysis } from './analizaSnapshotu.js';
import {
  getPreviousSnapshot,
  computeMachineDiff,
  getSnapshotAnalysis,
} from './diffEngine.js';
import {
  evaluateChangeWithLLM,
  saveDetectionAndNotification,
} from './ocenaZmianyLLM.js';

const db = mongoClient.db('inzynierka');
const snapshotsCol = db.collection('snapshots');

export async function handleNewSnapshot(snapshotRef, options = {}) {
  const { forceAnalysis = false } = options;

  let snapshot;

  // 1) jeśli ktoś podał cały obiekt snapshota
  if (snapshotRef && typeof snapshotRef === 'object' && snapshotRef._id) {
    snapshot = snapshotRef;
  } else {
    // 2) jeśli ktoś podał tylko _id (string albo ObjectId)
    const id =
      typeof snapshotRef === 'string'
        ? new ObjectId(snapshotRef)
        : snapshotRef;

    snapshot = await snapshotsCol.findOne({ _id: id });
  }

  if (!snapshot) {
    console.warn('handleNewSnapshot: snapshot nie znaleziony:', snapshotRef);
    return;
  }

  const snapshotIdStr = snapshot._id.toString();
  console.log(
    '[pipeline] handleNewSnapshot start',
    snapshotIdStr,
    'forceAnalysis=',
    forceAnalysis,
  );

  // 1) analiza pojedynczego snapshotu (TU idzie do LLM #1)
  const newAnalysis = await ensureSnapshotAnalysis(snapshot, {
    force: forceAnalysis,
  });

  // 2) poprzedni snapshot tego monitora
  const prevSnapshot = await getPreviousSnapshot(snapshot);

  // 3) diff maszynowy (w tym plugin_prices)
  const diff = await computeMachineDiff(prevSnapshot, snapshot);

  if (!diff.hasAnyChange) {
    console.log('[pipeline] Brak zmian – kończę na warstwie 2.');
    return;
  }

  // 4) poprzednia analiza LLM (jeśli była)
  const prevAnalysis = prevSnapshot
    ? await getSnapshotAnalysis(prevSnapshot._id)
    : null;

  // 5) LLM ocenia ważność zmiany (TU idzie do LLM #2)
const llmDecision = await evaluateChangeWithLLM({
  monitorId: snapshot.monitor_id,
  zadanieId: snapshot.zadanie_id,   // <<< DODAJ TO
  url: snapshot.url,
  prevAnalysis,
  newAnalysis,
  diff,
});


  if (llmDecision.important === true) {
    await saveDetectionAndNotification({
      monitorId: snapshot.monitor_id,
      zadanieId: snapshot.zadanie_id,        // <<< ewentualnie również tu
      snapshotMongoId: snapshot._id,
      diff,
      llmDecision,
    });
    console.log(
      '[pipeline] Zmiana uznana za istotną – zapisano detection/notification',
    );
  } else {
    console.log(
      '[pipeline] LLM uznał zmianę za nieistotną – bez powiadomienia.',
    );
  }
}
