# Dokumentacja techniczna: funkcje, API, komunikacja, architektura

## 1) Architektura systemu

Projekt jest podzielony na 4 główne warstwy:

1. **Frontend web (statyczne HTML + JS)**
   - `strona/*.html`, `strona/widoki/*.html`, `skrypt/app.js`
   - odpowiada za logowanie/rejestrację/reset hasła, panel i wywołania API.
2. **Backend HTTP (Express)**
   - `skrypt/serwerStart.js` + routery w `skrypt/routes/`
   - wystawia REST API, autoryzację JWT, obsługuje CRUD monitorów, historię, statystyki i integrację pluginu.
3. **Warstwa skanowania i ekstrakcji**
   - agent: `skrypt/agentSkanu.js`
   - ekstraktory: `extractors/*.js`
   - orkiestrator ekstrakcji: `orchestrator/extractOrchestrator.js`
4. **Warstwa analizy zmian (LLM/OCR/DIFF)**
   - pipeline i moduły `skrypt/llm/*.js`
   - porównuje snapshoty, ocenia istotność zmiany i zapisuje wynik + powiadomienia.

Bazy danych:
- **PostgreSQL**: użytkownicy, monitory, zadania, statusy, statystyki operacyjne.
- **MongoDB**: snapshoty, OCR, analiza LLM, chunking i dane pomocnicze pipeline.

---

## 2) Komunikacja między komponentami

### 2.1 Frontend ↔ Backend API
- Frontend nadpisuje globalny `fetch` i automatycznie dokleja `Authorization: Bearer <jwt>` dla endpointów poza `/auth/*`. Dzięki temu wszystkie wywołania panelu są domyślnie autoryzowane tokenem JWT.  
- Token jest zapisywany po logowaniu/rejestracji w `localStorage`.

### 2.2 Backend ↔ PostgreSQL
- Połączenie przez pool `pg`.
- Routery dostają `req.pg` (wstrzyknięcie middlewarem w `serwerStart.js`).
- PostgreSQL jest źródłem prawdy dla encji domenowych i statusów procesów.

### 2.3 Backend/Agent ↔ MongoDB
- Połączenie przez `MongoClient`.
- Mongo służy do przechowywania ciężkich dokumentów (snapshot HTML/tekst/screenshot, OCR, analizy, artefakty LLM).

### 2.4 Plugin przeglądarkowy ↔ Backend (`/api/plugin-tasks/*`)
- Plugin cyklicznie pobiera zadanie (`GET /api/plugin-tasks/next`).
- Następnie odsyła wynik: DOM/screenshot/cena (`POST /:id/result`, `/:id/screenshot`, `/:id/price`).
- Backend zapisuje snapshot do Mongo i uruchamia pipeline oceny zmiany.

### 2.5 Agent skanujący ↔ Orkiestrator ekstrakcji ↔ Pipeline LLM
- Agent pobiera zadania z PG, pobiera stronę (tryb `static` albo `screenshot/browser`), tworzy snapshot.
- Orkiestrator uruchamia extractory warstwowo i zwraca ustandaryzowany wynik ekstrakcji.
- Pipeline LLM/OCR porównuje z poprzednią migawką i zapisuje ocenę istotności + powiadomienia.

---

## 3) API HTTP (backend)

> Prefixy montowania routerów:
> - `/auth`
> - `/api/monitory`
> - `/api/historia`
> - `/api/statystyki`
> - `/api/plugin-tasks`

## 3.1 Auth (`/auth`)

### `POST /auth/register`
Rejestracja użytkownika.
- body: `fullname`, `email`, `password`, `password2`, `terms`
- walidacje: email, długość hasła, zgodność haseł, akceptacja regulaminu
- response: `{ ok, token, user }`

### `POST /auth/login`
Logowanie użytkownika.
- body: `email`, `password`
- response: `{ ok, token, user }`

### `POST /auth/password-reset/request`
Start resetu hasła.
- body: `email`
- behavior: zawsze 200 przy poprawnym formacie (anty-enumeracja kont)
- wysyła mail przez SMTP z linkiem resetu

### `POST /auth/password-reset/confirm`
Finalizacja resetu hasła.
- body: `token`, `password`, `password2`
- behavior: waliduje token i aktualizuje hash hasła

## 3.2 Monitory (`/api/monitory`, JWT required)

### `GET /api/monitory`
Lista monitorów użytkownika (paginacja + filtry).
- query: `q`, `status`, `page`, `limit`
- response: `{ items, total, page, pageSize }`

### `GET /api/monitory/:id`
Szczegóły pojedynczego monitora.

### `POST /api/monitory`
Tworzenie monitora.
- body: `name`, `url`, `interval_seconds`, `prompt`, `tryb_skanu | scan_mode | type`
- `tryb_skanu`: `static | screenshot` (fallback `html -> static`)

### `PATCH /api/monitory/:id`
Dwa tryby:
1. `toggle=true` → aktywuj/wstrzymaj monitor,
2. pełna edycja: `name`, `url`, `interval_seconds`, `prompt`, `tryb_skanu`.

### `DELETE /api/monitory/:id`
Usuwanie monitora użytkownika.

## 3.3 Historia (`/api/historia`, JWT required)

### `GET /api/historia`
Lista historycznych wykonań z filtrowaniem/paginacją.

### `GET /api/historia/:id`
Meta pojedynczego wykonania.

### `GET /api/historia/:id/details`
Szczegóły wykonania.

### `GET /api/historia/:id/download`
Eksport danych wykonania do pobrania.

### `GET /api/historia/:id/migawka`
Treść snapshotu.

### `GET /api/historia/:id/analiza`
Analiza LLM/OCR dla snapshotu.

### `GET /api/historia/:id/log`
Log zadania.

## 3.4 Statystyki (`/api/statystyki`, JWT required)

### `GET /api/statystyki/`
Dashboard statystyk + aktywne taski skanowania/pluginu.

### `POST /api/statystyki/zadania/:id/stop`
Zatrzymanie pojedynczego zadania skanu.

### `POST /api/statystyki/zadania/stop-all`
Zatrzymanie wszystkich zadań skanu użytkownika.

### `POST /api/statystyki/plugin-tasks/:id/stop`
Zatrzymanie pojedynczego plugin taska.

### `POST /api/statystyki/plugin-tasks/stop-all`
Zatrzymanie wszystkich plugin tasków użytkownika.

## 3.5 Plugin tasks (`/api/plugin-tasks`)

### `GET /api/plugin-tasks/next`
Pobiera i atomowo „claimuje” najstarsze zadanie `pending`.
- response 204 gdy brak zadań.

### `POST /api/plugin-tasks/:id/result`
Wynik ogólny pluginu: DOM + opcjonalnie screenshot.
- body: `monitor_id`, `zadanie_id?`, `url?`, `html?`, `text?`, `screenshot_b64?`
- zapisuje/upsertuje snapshot i uruchamia pipeline.

### `POST /api/plugin-tasks/:id/price`
Wynik ceny z pluginu.
- body: `monitor_id`, `zadanie_id?`, `url?`, `price?`, `price_text?`, `currency?`
- zapisuje informacje do snapshotu + kończy task.

### `POST /api/plugin-tasks/:id/screenshot`
Wynik screenshot-only.
- body: `monitor_id`, `zadanie_id?`, `url?`, `screenshot_b64`
- ma mechanizm „lazy skip” przy identycznym SHA1 screenshotu.

---

## 4) Moduły i funkcje (mapa kodu)

## 4.1 Backend core (`skrypt/`)
- `serwerStart.js` – bootstrap serwera, middleware, montowanie routerów i static assets.
- `polaczeniePG.js` – inicjalizacja `Pool` PostgreSQL.
- `polaczenieMDB.js` – inicjalizacja `MongoClient`, `connectMongo()`, `getDb()`.
- `jwt.js` – `signJwt(payload, opts)` + middleware `verifyJwt`.
- `loggerZadan.js` – `createTaskLogger` dla per-zadanie logów.
- `workerPowiadomien.js` – worker mailowy (pobiera zaległe powiadomienia i wysyła SMTP).
- `agentSkanu.js` – główna orkiestracja skanowania, scheduling i zapis snapshotów.

## 4.2 Ekstrakcja treści
- `orchestrator/extractOrchestrator.js` – funkcja główna `fetchAndExtract()`.
- `extractors/jsonldExtractor.js` – warstwa danych strukturalnych JSON-LD.
- `extractors/metaOgExtractor.js` – metadane OG/meta.
- `extractors/readabilityExtractor.js` – ekstrakcja głównego bloku treści.
- `extractors/visibleTextExtractor.js` – zbieranie widocznego tekstu z DOM.
- `extractors/domStructuredText.js` – konwersja DOM do stabilnego tekstu strukturalnego.
- `extractors/priceUtils.js` – heurystyki ceny.

## 4.3 Pipeline zmian (LLM/OCR)
- `pipelineZmian.js` – wejście pipeline: `handleNewSnapshot()`.
- `diffEngine.js` – diff snapshotów (tekst, ceny, dane ustrukturyzowane).
- `analizaSnapshotu.js` – budowa/utrzymanie analizy snapshotu.
- `ocenaZmianyLLM.js` – ocena ważności zmiany i zapis wykryć.
- `llmChunker.js`, `chunksSnapshotu.js` – chunking treści i template chunków.
- `llmEvidence.js` – selekcja dowodów (evidence) dla decyzji.
- `ocrSnapshotu.js`, `paddleOcr.js`, `paddle_ocr.py` – OCR obrazu.
- `ollamaClient.js`, `semaforOllama.js` – komunikacja z Ollama + limitowanie równoległości.

## 4.4 Funkcje – pełny inwentarz
Pełna lista funkcji (exportowanych i lokalnych) znajduje się w:
- `docs/FUNCTION_INVENTORY.md`

---

## 5) Przepływy end-to-end

## 5.1 Rejestracja i logowanie
1. Front wysyła `POST /auth/register` lub `POST /auth/login`.
2. Backend waliduje dane i zwraca JWT.
3. Front zapisuje JWT w `localStorage`.
4. Kolejne requesty idą z `Authorization: Bearer ...` automatycznie.

## 5.2 Cykl monitoringu (agent)
1. Agent pobiera monitor/task z PG.
2. Agent wykonuje scan (`static` albo `screenshot`).
3. Snapshot zapisuje do Mongo.
4. Uruchamiany jest `handleNewSnapshot()`.
5. Pipeline porównuje z poprzednim stanem i zapisuje wynik oceny.
6. W razie istotnej zmiany tworzone są rekordy do powiadomień.

## 5.3 Cykl monitoringu (plugin)
1. Plugin odpytuje `GET /api/plugin-tasks/next`.
2. Otwiera stronę i zbiera DOM/screenshot/cenę.
3. Odsyła wynik przez endpointy `/:id/result|price|screenshot`.
4. Backend aktualizuje snapshot + statusy tasków i uruchamia pipeline.

---

## 6) Konfiguracja środowiska (istotne grupy)

- **JWT / App**: `PORT`, `APP_BASE_URL`, `JWT_SECRET`, `JWT_EXPIRES`
- **PostgreSQL**: `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`
- **MongoDB**: `MONGO_URI`, `MONGO_DB`
- **SMTP**: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE`
- **Agent**: m.in. `MAX_CONCURRENCY`, `AGENT_LOOP_MS`, `STATIC_TIMEOUT_MS`
- **LLM/Ollama/OCR**: `OLLAMA_HOST`, `LLM_MODEL`, `OLLAMA_TEXT_MODEL`, `OCR_*`, `EVIDENCE_*`, `LLM_CHUNK_*`

