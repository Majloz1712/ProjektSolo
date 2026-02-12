# Architektura systemu

## 1. Zakres i odpowiedzialności

Projekt składa się z 4 głównych obszarów runtime:

1. **Serwer HTTP (Express)** – API, auth JWT, pliki statyczne panelu i endpointy pluginu.  
   Potwierdzenie: `skrypt/serwerStart.js` (montowanie routerów, static, nasłuch portu).
2. **Agent skanujący** – scheduler zadań, pobieranie stron, ekstrakcja, zapis snapshotów, odpalenie pipeline.  
   Potwierdzenie: `skrypt/agentSkanu.js` (`scheduleBatch`, `processTask`, `handleNewSnapshot`).
3. **Pipeline zmian (LLM/OCR/diff/judge)** – analiza snapshotów i decyzja o istotności zmiany.  
   Potwierdzenie: `skrypt/llm/pipelineZmian.js`, `skrypt/llm/analizaSnapshotu.js`, `skrypt/llm/ocenaZmianyLLM.js`.
4. **Worker powiadomień** – wysyłka e-mail dla rekordów `powiadomienia` o statusie `oczekuje`.  
   Potwierdzenie: `skrypt/workerPowiadomien.js`.

## 2. Entry points

- `npm run start` → `node skrypt/serwerStart.js`
- `npm run start:agent` → `node skrypt/agentSkanu.js`
- `npm run start:worker` → `node skrypt/workerPowiadomien.js`

Potwierdzenie: `package.json` (`scripts`).

## 3. Mapa modułów (repo walkthrough)

| Moduł | Główna odpowiedzialność | Kluczowe funkcje / punkty wejścia |
|---|---|---|
| `skrypt/serwerStart.js` | Bootstrap Express, podpięcie PG/Mongo, routery i static assets | `connectMongo()`, `app.use(...)`, `app.listen(...)` |
| `skrypt/routes/auth.js` | Rejestracja, logowanie, reset hasła | `POST /register`, `POST /login`, `POST /password-reset/*` |
| `skrypt/routes/monitory.js` | CRUD monitorów użytkownika | `GET/POST/PATCH/DELETE` na `/api/monitory` |
| `skrypt/routes/historia.js` | Lista/szczegóły historii skanów | endpointy `/api/historia/*` |
| `skrypt/routes/statystyki.js` | Dashboard i stopowanie aktywnych tasków | endpointy `/api/statystyki/*` |
| `skrypt/routes/pluginTasks.js` | Kolejka zadań pluginu + upload screenshotu | `GET /next`, `POST /:id/screenshot` |
| `skrypt/agentSkanu.js` | Harmonogram, pobieranie stron, fallback do pluginu, zapis snapshotów | `scheduleBatch()`, `loadPendingTasks()`, `processTask()` |
| `orchestrator/extractOrchestrator.js` + `extractors/*` | Ekstrakcja treści z HTML | `fetchAndExtract()` + ekstraktory warstwowe |
| `skrypt/llm/pipelineZmian.js` | Główny pipeline analizy zmian snapshotu | `handleNewSnapshot()` |
| `skrypt/llm/ocrSnapshotu.js` | OCR screenshotu i cache wyniku | `ensureSnapshotOcr()` |
| `skrypt/llm/chunksSnapshotu.js` | Segmentacja tekstu na chunki i cache | `ensureSnapshotChunks()`, `getSnapshotChunks()` |
| `skrypt/llm/analizaSnapshotu.js` | Budowa analizy snapshotu (summary/metrics/watch spec/chunks) | `ensureSnapshotAnalysis()` |
| `skrypt/llm/ocenaZmianyLLM.js` | Judge ważności zmiany + zapis wykrycia/powiadomienia | `evaluateChangeWithLLM()`, `saveDetectionAndNotification()` |
| `skrypt/workerPowiadomien.js` | Pobieranie oczekujących powiadomień i wysyłka SMTP | `processBatch()`, `sendNotificationEmail()` |
| `skrypt/plugin/*` | Rozszerzenie Chrome do screenshotów full-page | `background.js` polling `/api/plugin-tasks/next` |

## 4. Kluczowe przepływy

### 4.1 Skan monitora (agent)

1. Agent planuje i pobiera task (`zadania_skanu`: `oczekuje` → `w_trakcie`).
2. Agent ładuje monitor (`monitory`), skanuje URL (static/browser/fallback plugin).
3. Dla trybu lokalnego zapisuje snapshot do Mongo (`snapshots`).
4. Uruchamia `handleNewSnapshot()` pipeline.
5. Pipeline może zapisać `wykrycia` + `powiadomienia` (PG), a task kończy jako `ok` lub `blad`.

Potwierdzenie: `skrypt/agentSkanu.js` + `skrypt/llm/pipelineZmian.js`.

### 4.2 Przepływ plugin screenshot-only

1. Plugin odpytuje `GET /api/plugin-tasks/next`.
2. Plugin wykonuje full-page screenshot i wysyła `POST /api/plugin-tasks/:id/screenshot`.
3. Backend upsertuje screenshot do `snapshots` (Mongo), kończy `plugin_tasks` i `zadania_skanu`.
4. Backend odpala pipeline `handleNewSnapshot()`.

Potwierdzenie: `skrypt/plugin/background.js`, `skrypt/routes/pluginTasks.js`.

## 5. Wejścia/wyjścia etapów

- **Wejście monitoringu**: rekordy monitorów i zaplanowane taski z PG (`monitory`, `zadania_skanu`).
- **Wejście analizy**: snapshot z Mongo (`snapshots`), opcjonalnie screenshot `screenshot_b64`.
- **Wyjście analizy**: decyzja judge (`oceny_zmian` w Mongo) + `wykrycia` i `powiadomienia` w PG.
- **Wyjście worker’a**: zmiana statusu `powiadomienia` na `wyslane`.

## 6. Niepewne / do weryfikacji

- W starszych dokumentach występują endpointy pluginu `/:id/result` i `/:id/price`, ale obecny router `skrypt/routes/pluginTasks.js` implementuje tylko `GET /next` i `POST /:id/screenshot`.
- W kodzie agenta pojawia się `monitory.status='wymaga_interwencji'`; dokładny DDL kolumny `status` nie jest w repo (brak migracji SQL). Należy potwierdzić schema DB.
