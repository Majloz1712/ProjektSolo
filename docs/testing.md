# Testowanie

## 1. Zakres aktualnych testów automatycznych

Skrypt testowy z `package.json`:

```bash
npm test
```

W repo nie ma rozbudowanego katalogu testów integracyjnych/e2e; wartość komendy zależy od aktualnie dodanych testów Node (`node --test`).

## 2. Smoke test (manualny, zalecany)

### Krok 1: uruchom procesy
```bash
npm run start
npm run start:agent
npm run start:worker
```

### Krok 2: auth
1. Otwórz `http://localhost:3001/rejestracja.html`.
2. Załóż konto (`/auth/register`).
3. Zaloguj się (`/auth/login`).

Potwierdzenie w kodzie: `skrypt/app.js`, `skrypt/routes/auth.js`.

### Krok 3: monitor
1. Dodaj monitor przez UI (`/api/monitory`).
2. Poczekaj na cykl agenta (`scheduleBatch` + `loadPendingTasks`).

Potwierdzenie: `skrypt/routes/monitory.js`, `skrypt/agentSkanu.js`.

### Krok 4: pipeline
1. Zweryfikuj powstanie snapshotu w Mongo (`snapshots`).
2. Zweryfikuj logi `pipeline_start`/`pipeline_done`.
3. Dla istotnej zmiany sprawdź `wykrycia` i `powiadomienia`.

Potwierdzenie: `skrypt/llm/pipelineZmian.js`, `skrypt/llm/ocenaZmianyLLM.js`.

### Krok 5: plugin (jeśli tryb screenshot)
1. Upewnij się, że pojawia się `plugin_tasks` status `pending`.
2. Plugin powinien pobrać `GET /api/plugin-tasks/next` i wysłać screenshot `POST /:id/screenshot`.

Potwierdzenie: `skrypt/plugin/background.js`, `skrypt/routes/pluginTasks.js`.

## 3. Szybkie kontrole CLI (przykłady)

```bash
curl -i http://localhost:3001/
curl -i http://localhost:3001/api/plugin-tasks/next
curl -i -X POST http://localhost:3001/auth/login -H "Content-Type: application/json" -d '{"email":"x","password":"x"}'
```

## 4. Co warto dopisać jako testy automatyczne (TODO)

1. Testy jednostkowe normalizacji promptów i evidence (`analysisUtils.js`, `llmEvidence.js`).
2. Testy integracyjne routerów auth/monitory/plugin-tasks (supertest).
3. Smoke test pipeline na fixture snapshotów (bez realnego Ollama: stub).
4. Test kontraktów DB (SQL/migrations), bo obecnie schema jest pośrednio „zaszyta” w kodzie.
