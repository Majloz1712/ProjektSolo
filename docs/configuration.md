# Konfiguracja

## 1. Plik ENV

Punkt startowy: `.env.example`.

- Serwer: `PORT`, `APP_BASE_URL`, `JWT_SECRET`, `JWT_EXPIRES`
- PostgreSQL: `PGUSER`, `PGPASSWORD`, `PGHOST`, `PGDATABASE`, `PGPORT`
- MongoDB: `MONGO_URI`, `MONGO_DB`
- SMTP: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE`
- Agent: `MAX_CONCURRENCY`, `AGENT_LOOP_MS`, `STATIC_TIMEOUT_MS`
- LLM: `OLLAMA_HOST`, `OLLAMA_TEXT_MODEL`, `LLM_MODEL`

## 2. Mapa „zmienna → gdzie używana”

| Zmienna | Domyślna (kod/.env.example) | Gdzie używana |
|---|---|---|
| `PORT` | `.env.example=3001`; serwer ma stałe `const PORT = 3001` | `skrypt/serwerStart.js` (aktualnie ignoruje `process.env.PORT`) |
| `APP_BASE_URL` | `http://localhost:3001` | `skrypt/routes/auth.js` (budowa URL resetu hasła) |
| `JWT_SECRET` | brak sensownej domyślnej (`change-me...`) | `skrypt/jwt.js`, `skrypt/serwerStart.js` (log check) |
| `JWT_EXPIRES` | `1h` | `skrypt/jwt.js` |
| `PGHOST`,`PGPORT`,`PGUSER`,`PGPASSWORD`,`PGDATABASE` | wg `.env.example` | `skrypt/polaczeniePG.js` |
| `MONGO_URI`,`MONGO_DB` | `mongodb://127.0.0.1:27017`, `inzynierka` | `skrypt/polaczenieMDB.js`, `skrypt/routes/pluginTasks.js`, `skrypt/llm/*` |
| `SMTP_*` | wg `.env.example` | `skrypt/workerPowiadomien.js`, `skrypt/routes/auth.js` |
| `POWIADOMIENIA_INTERVAL_MS` | `30000` | `skrypt/workerPowiadomien.js` |
| `MAX_CONCURRENCY` | fallback w kodzie agenta | `skrypt/agentSkanu.js` |
| `AGENT_LOOP_MS` | fallback w kodzie agenta | `skrypt/agentSkanu.js` |
| `STATIC_TIMEOUT_MS` | fallback w kodzie agenta | `skrypt/agentSkanu.js` |
| `OLLAMA_HOST`,`LLM_MODEL`,`OLLAMA_TEXT_MODEL` | `.env.example` | `skrypt/llm/ollamaClient.js`, `skrypt/llm/analizaSnapshotu.js`, `skrypt/llm/ocenaZmianyLLM.js` |
| `OCR_PADDLE_TIMEOUT_MS`, `OCR_*` | fallbacki w kodzie | `skrypt/llm/ocrSnapshotu.js`, `skrypt/llm/paddleOcr.js` |
| `EVIDENCE_*` | fallbacki w kodzie | `skrypt/llm/llmEvidence.js` |
| `LLM_CHUNK_*`, `LLM_CHUNKING_ENABLED` | fallbacki w kodzie | `skrypt/llm/chunksSnapshotu.js`, `skrypt/llm/analizaSnapshotu.js`, `skrypt/llm/pipelineZmian.js` |

## 3. Rekomendowana minimalna konfiguracja DEV

```env
PORT=3001
APP_BASE_URL=http://localhost:3001
JWT_SECRET=local-dev-secret
JWT_EXPIRES=1h

PGHOST=127.0.0.1
PGPORT=5432
PGUSER=postgres
PGPASSWORD=devpass
PGDATABASE=postgres

MONGO_URI=mongodb://127.0.0.1:27017
MONGO_DB=inzynierka
```

Do resetu hasła/powiadomień trzeba dodać `SMTP_*`.

## 4. Ograniczenia i uwagi

- `PORT` jest deklarowany w `.env.example`, ale aktualny `skrypt/serwerStart.js` używa stałej `3001` (do poprawy w kodzie aplikacji, poza zakresem tej zmiany dokumentacji).
- Bez `JWT_SECRET` logowanie/rejestracja nie zadziała (`jwt.js` rzuca wyjątek przy podpisie/weryfikacji).
- Brak działającego SMTP nie blokuje samego API monitoringu, ale blokuje reset hasła i worker powiadomień.
