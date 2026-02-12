# Troubleshooting

## 1. API nie startuje / błąd połączenia z DB

### Objawy
- Błąd przy starcie serwera.
- Brak odpowiedzi na `http://localhost:3001`.

### Diagnostyka
1. Sprawdź ENV i połączenia:
   - PostgreSQL (`skrypt/polaczeniePG.js`)
   - MongoDB (`skrypt/polaczenieMDB.js`)
2. Uruchom serwer i odczytaj logi checka PG w `serwerStart.js`.

### Najczęstsza przyczyna
- Niepoprawne `PG*` lub `MONGO_*` w `.env`.

---

## 2. 401 / „Brak tokenu JWT”

### Objawy
- Endpointy `/api/*` zwracają 401.

### Diagnostyka
- Sprawdź czy frontend zapisuje token po `/auth/login` lub `/auth/register` (`skrypt/app.js`).
- Sprawdź nagłówek `Authorization: Bearer ...` (middleware `verifyJwt` w `skrypt/jwt.js`).

### Najczęstsza przyczyna
- Brak `JWT_SECRET` albo nieprawidłowy token w `localStorage`.

---

## 3. Taski monitoringu „wiszą” w `w_trakcie`

### Objawy
- W statystykach rosną aktywne taski.
- Brak nowych wyników.

### Diagnostyka
- Sprawdź logi agenta (`skrypt/agentSkanu.js`, `processTask`).
- Sprawdź fallback pluginu: czy powstał rekord `plugin_tasks` i czy plugin pobiera `/api/plugin-tasks/next`.

### Najczęstsza przyczyna
- Brak działającego pluginu screenshotowego przy taskach przekazanych do pluginu.
- Błąd pipeline/OCR (logi `pipeline_error`, `snapshot_ocr_done`).

---

## 4. Brak powiadomień e-mail

### Objawy
- Istnieją rekordy `powiadomienia` ze statusem `oczekuje`, ale brak e-maili.

### Diagnostyka
- Uruchom `npm run start:worker`.
- Sprawdź `verifyTransport()` i błędy SMTP w `skrypt/workerPowiadomien.js`.

### Najczęstsza przyczyna
- Błędny `SMTP_HOST/PORT/USER/PASS/FROM`.

---

## 5. OCR nie generuje tekstu

### Objawy
- Snapshot ma screenshot, ale `vision_ocr.clean_text` puste/nieużyteczne.

### Diagnostyka
- Sprawdź logi `ensureSnapshotOcr()` (`skrypt/llm/ocrSnapshotu.js`).
- Zweryfikuj zależności Python/PaddleOCR (`skrypt/llm/paddleOcr.js`, `skrypt/llm/paddle_ocr.py`).

### Najczęstsza przyczyna
- Brak środowiska Python/OCR lub timeout (`OCR_PADDLE_TIMEOUT_MS`).

---

## 6. LLM nie ocenia zmian

### Objawy
- Brak wpisów w `oceny_zmian`, brak kategorii judge.

### Diagnostyka
- Sprawdź `evaluateChangeWithLLM()` i logi `judge_failed` (`skrypt/llm/ocenaZmianyLLM.js`).
- Sprawdź połączenie z Ollama (`skrypt/llm/ollamaClient.js`), model (`LLM_MODEL`/`OLLAMA_TEXT_MODEL`).

### Najczęstsza przyczyna
- Niedostępny host/model Ollama.

---

## 7. „Niepewne / do weryfikacji”

- Jeśli UI/API odwołuje się do plugin endpointów innych niż `GET /next` i `POST /:id/screenshot`, traktuj to jako rozjazd wersji dokumentacji względem kodu i zweryfikuj branch/deployment.
