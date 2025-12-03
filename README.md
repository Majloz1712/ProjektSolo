# ProjektSolo

Monorepo łączące backend monitoringu stron (Express + PostgreSQL + MongoDB), warstwę ekstrakcji treści (Puppeteer + JSDOM), plugin przeglądarkowy do screenshotów/DOM oraz prosty panel webowy do logowania i zarządzania sondami. Repozytorium zawiera również pipeline LLM do oceny zmian i worker wysyłający powiadomienia e-mail.

## Spis treści
- [Struktura katalogów](#struktura-katalogów)
- [Szybki start](#szybki-start)
- [Najważniejsze komponenty](#najważniejsze-komponenty)
- [Dokumentacja architektury](#dokumentacja-architektury)

## Struktura katalogów
- `extractors/` – warstwa ekstrakcji HTML/DOM (JSON-LD, OpenGraph, Readability, heurystyka tekstu) i opis pipeline'u.
- `orchestrator/` – koordynator pobierania stron (fetch/Puppeteer), wykrywania blokad i wyboru najlepszego ekstraktora.
- `utils/` – funkcje pomocnicze (normalizacja cen/tekstów, retry z backoffem).
- `skrypt/` – backend Express (route'y auth/monitory/plugin-tasks), połączenia z Postgres/Mongo, worker powiadomień, pipeline LLM oraz pliki frontendu JS.
- `strona/` i `styl/` – statyczny panel logowania/rejestracji/resetu hasła + style.
- `scripts/` – skrypty developerskie (np. szybki test ekstraktorów).

## Szybki start
1. **Wymagania**: Node 20+, działające instancje PostgreSQL i MongoDB, opcjonalnie Ollama dla modeli tekstowych/wizualnych.
2. **Zmienne środowiskowe**: przygotuj `.env` w katalogu `skrypt/` z parametrami baz (`PG*`, `MONGO_*`), `JWT_SECRET`, ewentualnie SMTP (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`) i Ollama (`OLLAMA_HOST`, `OLLAMA_TEXT_MODEL`).
3. **Instalacja zależności**:
   ```bash
   npm install
   ```
4. **Uruchom backend** (Express + statyczny frontend):
   ```bash
   node skrypt/serwerStart.js
   ```
   Serwer nasłuchuje na `http://localhost:3001`, wystawia API pod `/auth`, `/api/monitory`, `/api/plugin-tasks` i serwuje panel HTML.
5. **Worker powiadomień e-mail** (opcjonalnie):
   ```bash
   node skrypt/workerPowiadomien.js
   ```
6. **Test ekstraktorów** (pobiera przykładowe URL-e – wymaga dostępu do internetu):
   ```bash
   npm test
   ```

## Najważniejsze komponenty
- **Ekstrakcja treści**: `orchestrator/extractOrchestrator.js` pobiera stronę (fetch + opcjonalny render Puppeteer), wykrywa blokady (CAPTCHA/403/429), wybiera najlepszy ekstraktor z `extractors/` i zapewnia fallback. Wynik zawiera tytuł/opis/tekst, cenę, obrazy i typ treści.
- **Backend API**: `skrypt/serwerStart.js` montuje route'y autoryzacji (`/auth/register`, `/auth/login`), zarządzania sondami (`/api/monitory`) oraz kolejki zadań pluginu (`/api/plugin-tasks`). Dane użytkowników i sond trzymane są w Postgresie; snapshoty i analizy w MongoDB.
- **Plugin przeglądarkowy**: `skrypt/plugin/` (manifest MV3 + service worker) pobiera zadania z backendu, otwiera stronę, zrzuca DOM/screenshot lub listę cen i odsyła wynik do API.
- **Pipeline LLM**: `skrypt/llm/` tworzy analizy snapshotów, porównuje je z poprzednimi (`diffEngine.js`), ocenia istotność zmiany (`ocenaZmianyLLM.js`) i zapisuje wykrycia/powiadomienia w Postgresie.
- **Powiadomienia**: `skrypt/workerPowiadomien.js` wysyła e-maile dla oczekujących powiadomień korzystając z SMTP.
- **Frontend panelu**: statyczne widoki w `strona/` używają `skrypt/app.js` do logowania/rejestracji, przechowywania JWT w `localStorage` i ochrony stron przed wejściem bez tokenu.

## Dokumentacja architektury
Szczegółowy opis przepływów (ekstraktory, API, plugin, pipeline LLM, powiadomienia) znajduje się w [`docs/architecture.md`](docs/architecture.md).
