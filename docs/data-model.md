# Model danych (PostgreSQL + MongoDB)

## 1. Źródła prawdy

- **PostgreSQL** – encje biznesowe i workflow (`uzytkownicy`, `monitory`, `zadania_skanu`, `plugin_tasks`, `wykrycia`, `powiadomienia`, `password_resets`).
- **MongoDB** – snapshoty i artefakty analizy (`snapshots`, `analyses`, `oceny_zmian`, opcjonalnie `sessions`).

Potwierdzenie: zapytania SQL w `skrypt/routes/*.js`, `skrypt/agentSkanu.js`, `skrypt/workerPowiadomien.js`, `skrypt/llm/ocenaZmianyLLM.js`; kolekcje Mongo w `skrypt/polaczenieMDB.js`, `skrypt/llm/*.js`, `skrypt/routes/pluginTasks.js`.

## 2. PostgreSQL – tabele i użycie

> Uwaga: repo nie zawiera migracji DDL, więc pola wynikają z realnie używanego SQL (to najpewniejsze źródło).

### `public.uzytkownicy`
- Użycie: auth i adresy e-mail do powiadomień.
- Pola używane w kodzie: `id`, `pelna_nazwa`, `email`, `haslo_hash`, `utworzono_at`.
- Referencje: `skrypt/routes/auth.js`, `skrypt/workerPowiadomien.js`.

### `public.password_resets`
- Użycie: reset hasła.
- Pola: `id`, `user_id`, `token_hash`, `expires_at`, `used_at`.
- Referencje: `skrypt/routes/auth.js`.

### `monitory`
- Użycie: konfiguracja monitoringu URL i promptu.
- Pola: `id`, `uzytkownik_id`, `nazwa`, `url`, `llm_prompt`, `interwal_sec`, `aktywny`, `tryb_skanu`, `css_selector`, `id_ostatniej_dobrej_analizy`, `utworzono_at`.
- Referencje: `skrypt/routes/monitory.js`, `skrypt/agentSkanu.js`, `skrypt/llm/pipelineZmian.js`.

### `zadania_skanu`
- Użycie: kolejka i lifecycle skanowania.
- Pola: `id`, `monitor_id`, `status`, `zaplanowano_at`, `rozpoczecie_at`, `zakonczenie_at`, `blad_opis`, `tresc_hash`, `snapshot_mongo_id`, `analiza_mongo_id`.
- Referencje: `skrypt/agentSkanu.js`, `skrypt/llm/pipelineZmian.js`, `skrypt/routes/historia.js`, `skrypt/routes/statystyki.js`, `skrypt/routes/pluginTasks.js`.

### `plugin_tasks`
- Użycie: kolejka zadań dla pluginu Chrome.
- Pola: `id`, `monitor_id`, `zadanie_id`, `url`, `mode`, `status`, `blad_opis`, `utworzone_at`, `zaktualizowane_at`.
- Referencje: `skrypt/agentSkanu.js`, `skrypt/routes/pluginTasks.js`, `skrypt/routes/statystyki.js`.

### `wykrycia`
- Użycie: zapis istotnych zmian po judge.
- Pola: `id`, `zadanie_id`, `monitor_id`, `url`, `tytul`, `pewnosc`, `snapshot_mongo_id`, `category`, `important`, `reason`, `diff_json`.
- Referencje: `skrypt/llm/ocenaZmianyLLM.js`, `skrypt/workerPowiadomien.js`, `skrypt/routes/monitory.js`.

### `powiadomienia`
- Użycie: kolejka notyfikacji i status wysyłki.
- Pola: `id`, `uzytkownik_id`, `monitor_id`, `wykrycie_id`, `tytul`, `tresc`, `status`, `utworzono_at`, `wyslano_at`.
- Referencje: `skrypt/llm/ocenaZmianyLLM.js`, `skrypt/workerPowiadomien.js`, `skrypt/agentSkanu.js`.

## 3. MongoDB – kolekcje i dokumenty

### `snapshots`
Użycie: snapshot wejściowy dla pipeline.

Kluczowe pola obserwowane w kodzie:
- Identyfikacja: `_id`, `monitor_id`, `zadanie_id`, `ts`, `url`, `final_url`, `mode`
- Dane wejściowe: `screenshot_b64`, `html` (czasami), `extracted_v2`, `llm_prompt`
- OCR: `vision_ocr.{ok,error,raw_text,clean_text,clean_lines,meta,sourceHash}`
- Chunking: `text_chunks_v1`
- Hash screenshotu: `screenshot_sha1`

Referencje: `skrypt/agentSkanu.js`, `skrypt/routes/pluginTasks.js`, `skrypt/llm/ocrSnapshotu.js`, `skrypt/llm/chunksSnapshotu.js`.

### `analyses`
Użycie: wynik analizy snapshotu.

Pola używane pośrednio:
- `snapshot_id`, `summary`, `metrics`, `chunk_template`, `watch_spec`, `prompt_hash`, `prompt_chunks_v1.focus_chunk_ids`, `important_chunk_ids`.

Referencje: `skrypt/llm/analizaSnapshotu.js`, `skrypt/llm/pipelineZmian.js`, `skrypt/llm/diffEngine.js`.

### `oceny_zmian`
Użycie: ślad działania judge (LLM/deterministic).

Pola:
- `monitorId`, `zadanieId`, `url`, `llm_mode`, `model`, `prompt_used`, `raw_response`, `llm_decision`, `analysis_diff`, `durationMs`.

Referencja: `skrypt/llm/ocenaZmianyLLM.js`.

### `sessions` (opcjonalnie)
Użycie: utrwalanie cookies/localStorage dla skanowania browserowego.

Pola: `monitorId`, `origin`, `cookies`, `localStorage`, `updatedAt`.

Referencja: `skrypt/agentSkanu.js` (`persistSession`, `restoreSession`).

## 4. Relacje (skrót)

- `uzytkownicy (1) -> (N) monitory`
- `monitory (1) -> (N) zadania_skanu`
- `zadania_skanu (1) -> (N?) plugin_tasks` (logika dedupe ogranicza równoległe aktywne rekordy)
- `zadania_skanu (1) -> (N) wykrycia`
- `wykrycia (1) -> (N) powiadomienia` (zwykle 1)
- `zadania_skanu.snapshot_mongo_id -> snapshots._id` (relacja referencyjna po stringu)
- `zadania_skanu.analiza_mongo_id -> analyses._id` (relacja referencyjna po stringu)

## 5. Niepewne / do weryfikacji

- Brak oficjalnych migracji SQL w repo – nazwy typów/indeksów/constraints nie są jednoznacznie potwierdzone.
- W `powiadomienia` wstawienie z `agentSkanu.js` używa tylko `(id, monitor_id, tresc)`; wymagalność `uzytkownik_id` zależy od DDL (niepewne).
