# Architektura i przepływy aplikacji

Dokument opisuje, jak poszczególne komponenty repozytorium współpracują ze sobą: od pobrania strony i wyciągnięcia treści, przez API i plugin, aż po pipeline LLM i wysyłkę powiadomień.

## 1. Ekstrakcja treści
- **Orkiestracja**: [`orchestrator/extractOrchestrator.js`](../orchestrator/extractOrchestrator.js) pobiera stronę metodą `fetch` (z nagłówkami desktop Chrome) i w razie potrzeby przełącza się na render Puppeteera. Wykrywa blokady (statusy 401/403/429/503, słowa kluczowe CAPTCHA/Cloudflare) i w takim przypadku zwraca wynik z flagami `blocked/human_review` oraz zapisuje screenshot.
- **Warstwy ekstrakcji**: kod z [`extractors/`](../extractors/) implementuje priorytetową listę ekstraktorów:
  - `jsonldExtractor` – analizuje skrypty `application/ld+json` i preferuje typy Product/Article.
  - `metaOgExtractor` – korzysta z OpenGraph/Twitter Card i klasycznych metadanych.
  - `readabilityExtractor` – wybiera najbogatszy kontener treści (`article/main`) i zwraca tekst + heurystyczną cenę.
  - `visibleTextExtractor` – zbiera widoczny tekst drzewem `TreeWalker`, obcina artefakty JS i próbuje wyciągnąć cenę z ciągów tekstu.
- **Fallback**: jeżeli najlepszy ekstraktor ma `confidence < 0.5`, orkiestrator wybiera kolejne warstwy; gdy wszystkie zawiodą, tworzy wynik minimalny (tytuł/opis/meta + pierwsze paragrafy).

## 2. Backend HTTP (Express)
- **Start**: [`skrypt/serwerStart.js`](../skrypt/serwerStart.js) konfiguruje Express, wstrzykuje połączenia Postgres (`req.pg`) i Mongo (`req.mongo`), serwuje statyczne pliki z `strona/`, `styl/`, `skrypt/` i nasłuchuje na porcie 3001.
- **Autoryzacja**: [`skrypt/routes/auth.js`](../skrypt/routes/auth.js) realizuje `/auth/register` oraz `/auth/login`. Dane użytkowników są walidowane, hasła hashowane w `bcrypt`, a odpowiedź zwraca JWT z funkcji [`skrypt/jwt.js`](../skrypt/jwt.js).
- **Sondy (monitory)**: [`skrypt/routes/monitory.js`](../skrypt/routes/monitory.js) zabezpieczone middlewarem `verifyJwt`. Umożliwia listowanie z paginacją/filtrami, tworzenie (`POST /api/monitory`), togglowanie statusu (`PATCH /api/monitory/:id`) i usuwanie (`DELETE /api/monitory/:id`). Dane trafiają do tabeli `monitory` w Postgresie.
- **Zadania pluginu**: [`skrypt/routes/pluginTasks.js`](../skrypt/routes/pluginTasks.js) obsługuje kolejkę zadań dla pluginu (tabela `plugin_tasks` w Postgresie). Endpointy:
  - `GET /api/plugin-tasks/next` – pobiera najstarsze `pending` zadanie, ustawia je na `in_progress`.
  - `POST /api/plugin-tasks/:id/result` – zapisuje wynik DOM/screenshot w Mongo (`snapshots`), opcjonalnie przepuszcza HTML przez ekstraktory i uruchamia pipeline LLM.
  - `POST /api/plugin-tasks/:id/price` – aktualizuje istniejący snapshot o `plugin_prices` i ponownie odpala pipeline LLM.

## 3. Plugin przeglądarkowy
- Manifest MV3 i service worker znajdują się w [`skrypt/plugin/`](../skrypt/plugin/). Plugin cyklicznie pyta backend (`/api/plugin-tasks/next`), otwiera stronę w nowym oknie i próbuje najpierw wysłać DOM (`html` + `innerText`). Jeśli DOM jest pusty, wykonuje screenshot i publikuje go do `/result`.
- W trybie `price_only` (pole `mode` zadania) worker wyciąga listę ciągów z cenami z DOM i wysyła do `/price` wraz z `monitor_id` i `zadanie_id`.
- Komunikacja z backendem używa tokenu w nagłówku `Authorization` (`AUTH_TOKEN` w konfiguracji pluginu) i bazowego adresu API (`BACKEND_BASE_URL`).

## 4. Pipeline LLM i analiza zmian
- **Analiza pojedynczego snapshota**: [`skrypt/llm/analizaSnapshotu.js`](../skrypt/llm/analizaSnapshotu.js) buduje prompt z tytułu/opisu/tekstu strony i opcjonalnych cen (z extractora lub pluginu). Wysyła go do Ollamy (`generateTextWithOllama`), parsuje zwrócony JSON i zapisuje dokument typu `snapshot` w kolekcji `analizy` (Mongo).
- **Różnice maszynowe**: [`skrypt/llm/diffEngine.js`](../skrypt/llm/diffEngine.js) porównuje nowy snapshot z poprzednim tego samego monitora. Sprawdza zmiany ceny, tytułu, opisu, długości tekstu, liczby obrazów oraz `plugin_prices`, generując flagi `hasAnyChange` i `hasSignificantMachineChange`.
- **Evidence dla LLM-judge**: [`skrypt/llm/llmEvidence.js`](../skrypt/llm/llmEvidence.js) wybiera krótkie, dosłowne cytaty z chunków `[Pxxx]` zgodne z promptem użytkownika. Dla promptów typu „nowy artykuł/wpis/pozycja” priorytetem są linie list (bullet/numery), wpisy z datą/czasem względnym oraz nagłówki sekcji (np. „Najnowsze”, „Polska”); wybierane jest 3–8 cytatów z 1–2 chunków o najwyższym zagęszczeniu takich linii. Zwraca `evidence_v1.items` oraz `chunk_relevance` bez zależności od `focus chunks`.
- **Ocena zmiany**: [`skrypt/llm/ocenaZmianyLLM.js`](../skrypt/llm/ocenaZmianyLLM.js) otrzymuje diff + analizy snapshotów i prosi LLM o decyzję, czy zmiana jest istotna. Ma twardą regułę: `diff.metrics.pluginPricesChanged === true` zawsze oznacza zmianę istotną (`price_change`). Wynik zapisuje do kolekcji `oceny_zmian` (Mongo) i wywołuje zapis do Postgresa.
- **Zapisy w Postgresie**: funkcja `saveDetectionAndNotification` dodaje wpis do tabeli `wykrycia` (z pewnością, kategorią, odniesieniem do `snapshot_mongo_id`) oraz powiązane powiadomienie w tabeli `powiadomienia` dla użytkownika/monitora.
- **Wejście do pipeline'u**: [`skrypt/llm/pipelineZmian.js`](../skrypt/llm/pipelineZmian.js) spina elementy: dla każdego nowego snapshota (z `/plugin-tasks/.../result` lub `/price`) uruchamia `ensureSnapshotAnalysis`, `computeMachineDiff`, a następnie `evaluateChangeWithLLM`. Wymusza istotność, jeśli zmieniły się ceny z pluginu, i zapisuje wykrycie/powiadomienie.

## 5. Przechowywanie danych
- **PostgreSQL**: użytkownicy (`uzytkownicy`), monitory (`monitory`), zadania pluginu (`plugin_tasks`), wykrycia (`wykrycia`) i powiadomienia (`powiadomienia`). Middleware w `serwerStart.js` dodaje `req.pg` w route'ach.
- **MongoDB**: kolekcje `snapshots`, `analizy` i `oceny_zmian` przechowują treść stron, wyniki LLM i oceny zmian. Dostęp przez `req.mongo` lub bezpośrednio z modułów LLM.

## 6. Powiadomienia
- Worker [`skrypt/workerPowiadomien.js`](../skrypt/workerPowiadomien.js) cyklicznie pobiera `powiadomienia` o statusie `oczekuje`, wysyła e-maile przez `nodemailer` i oznacza rekord jako `wyslane`. Konfiguracja SMTP pochodzi z `.env`.

## 7. Frontend panelu
- Statyczne widoki (`strona/*.html`) korzystają ze wspólnego skryptu [`skrypt/app.js`](../skrypt/app.js):
  - nadpisuje `window.fetch`, aby automatycznie doklejać JWT do nagłówka `Authorization` (poza `/auth/*`), oraz wylogowuje użytkownika przy błędzie 401.
  - inicjalizuje formularze logowania/rejestracji/resetu, waliduje dane i zapisuje JWT/pełne imię e-mail w `localStorage`.
  - chroni strony inne niż publiczne (`logowanie.html`, `rejestracja.html`, `resetHasla.html`) przed dostępem bez tokenu.

## 8. Wymagane zmienne środowiskowe
Umieść je w `skrypt/.env` (szablon znajdziesz w `skrypt/.env.example`):
- `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` – dostęp do Postgresa.
- `MONGO_URI`, `MONGO_DB` – dostęp do MongoDB.
- `JWT_SECRET`, opcjonalnie `JWT_EXPIRES` – podpis JWT.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` – wysyłka e-mail (worker powiadomień).
- `OLLAMA_HOST`, `OLLAMA_TEXT_MODEL` – endpoint/model dla zapytań LLM (analiza/ocena zmian).

## 9. Przydatne komendy
- `node skrypt/serwerStart.js` – uruchamia API + frontend.
- `node skrypt/workerPowiadomien.js` – uruchamia worker SMTP.
- `npm test` – wykonuje `scripts/testExtractors.js` na przykładowych stronach (wymaga internetu).
