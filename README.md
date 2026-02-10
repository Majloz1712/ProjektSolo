# ProjektSolo

Projekt do monitorowania zmian na stronach WWW: backend Express + PostgreSQL/MongoDB, agent skanujący (Puppeteer), plugin przeglądarkowy oraz pipeline analizy zmian (LLM).

## Wymagania

- Node.js 20+
- npm 10+
- PostgreSQL
- MongoDB
- (opcjonalnie) Ollama dla warstwy LLM

## Instalacja

```bash
npm install
```

## Konfiguracja środowiska

Projekt korzysta ze zmiennych środowiskowych w katalogu `skrypt/`.

```bash
cp skrypt/.env.example skrypt/.env
```

Najważniejsze zmienne:

- `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`
- `MONGO_URI` (oraz opcjonalnie `MONGO_URL`), `MONGO_DB`
- `JWT_SECRET`, `JWT_EXPIRES`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- `OLLAMA_HOST`, `OLLAMA_TEXT_MODEL`

## Uruchomienie

### Backend + frontend statyczny

```bash
node skrypt/serwerStart.js
```

### Worker powiadomień

```bash
node skrypt/workerPowiadomien.js
```

### Testy

```bash
npm test
```

## Struktura katalogów (skrót)

- `skrypt/` – backend Express, routy API, agent skanujący, pipeline LLM, worker SMTP.
- `strona/` – statyczne widoki HTML panelu.
- `extractors/` + `orchestrator/` – ekstrakcja treści i orkiestracja dla snapshotów/HTML.
- `src/` + `dist/` – moduł semantic chunkingu i CLI.
- `test/` – testy jednostkowe Node test runner.
- `docs/` – dokumentacja architektury i referencja plików.

## Uwagi

- `dist/` zawiera aktualne artefakty JS dla modułu chunkingu.
- Przed oddaniem projektu warto uruchomić `npm test` oraz smoke test serwera (`node skrypt/serwerStart.js`).
