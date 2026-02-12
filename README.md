# ProjektSolo

System monitorowania zmian na stronach WWW: backend Express + panel web + agent skanujący + pipeline analizy zmian (LLM/OCR) + worker powiadomień e-mail.

## Dla kogo jest ten projekt

- Dla użytkowników, którzy chcą monitorować zmiany treści/cen na wskazanych URL.
- Dla autora projektu (inżynierka) jako system wieloprocesowy: API, agent, plugin Chrome, OCR/LLM.

> Źródła w kodzie: `skrypt/serwerStart.js`, `skrypt/agentSkanu.js`, `skrypt/workerPowiadomien.js`, `skrypt/routes/pluginTasks.js`, `skrypt/llm/pipelineZmian.js`.

---

## Szybki start

1. Instalacja zależności:
   ```bash
   npm install
   ```
2. Konfiguracja środowiska:
   ```bash
   cp .env.example .env
   ```
3. Uzupełnij minimalnie: PostgreSQL, MongoDB, JWT.
4. Uruchom procesy (w osobnych terminalach):
   ```bash
   npm run start
   npm run start:agent
   npm run start:worker
   ```

Backend domyślnie działa na `http://localhost:3001`.

---

## Wymagania

- Node.js 20+
- npm 10+
- PostgreSQL
- MongoDB
- (opcjonalnie) Ollama dla ścieżek LLM
- (opcjonalnie) SMTP dla resetu hasła i wysyłki powiadomień

Źródła: `package.json`, `.env.example`, `skrypt/routes/auth.js`, `skrypt/workerPowiadomien.js`.

---

## Instalacja i uruchomienie

### 1) API + frontend statyczny
```bash
npm run start
```
Entry point: `skrypt/serwerStart.js`.

### 2) Agent skanujący
```bash
npm run start:agent
```
Entry point: `skrypt/agentSkanu.js`.

### 3) Worker powiadomień
```bash
npm run start:worker
```
Entry point: `skrypt/workerPowiadomien.js`.

---

## Konfiguracja ENV (skrót)

Pełny zestaw i wartości przykładowe: `.env.example`.

- App/JWT: `PORT`, `APP_BASE_URL`, `JWT_SECRET`, `JWT_EXPIRES`
- PostgreSQL: `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`
- MongoDB: `MONGO_URI`, `MONGO_DB`
- SMTP: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE`
- Agent: `MAX_CONCURRENCY`, `AGENT_LOOP_MS`, `STATIC_TIMEOUT_MS`
- LLM/OCR (opcjonalnie): `OLLAMA_HOST`, `OLLAMA_TEXT_MODEL`, `LLM_MODEL`, `OCR_*`, `EVIDENCE_*`, `LLM_CHUNK_*`

Szczegółowe mapowanie „zmienna → gdzie używana”: `docs/configuration.md`.

---

## Typowe komendy

```bash
npm install
npm run start
npm run start:agent
npm run start:worker
npm test
```

---

## Struktura katalogów

- `skrypt/` – backend, agent, worker, JWT, routery API, pipeline LLM/OCR, plugin Chrome
- `orchestrator/` – orkiestrator ekstrakcji treści (`fetchAndExtract`)
- `extractors/` – warstwa ekstrakcji (JSON-LD, OG/meta, readability, text)
- `strona/` – statyczne widoki HTML
- `styl/` – CSS
- `utils/` – funkcje pomocnicze
- `docs/` – dokumentacja techniczna i diagramy

---

## Gdzie czytać dalej

- Architektura i mapa modułów: `docs/architecture.md`
- Model danych (PG + Mongo): `docs/data-model.md`
- Konfiguracja ENV: `docs/configuration.md`
- Troubleshooting: `docs/troubleshooting.md`
- Testowanie i smoke test: `docs/testing.md`
- Spis diagramów Mermaid: `docs/diagrams.md`

---

## Status/uwagi

- W repo istnieje plugin Chrome screenshot-only (`/api/plugin-tasks/next` + `/:id/screenshot`); endpointy `/:id/result` i `/:id/price` **nie występują w aktualnym kodzie** i wymagają weryfikacji, jeśli pojawiają się w starszych opisach.
