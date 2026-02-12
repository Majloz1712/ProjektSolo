# Diagramy architektury (Mermaid)

Ten plik zawiera komplet najważniejszych diagramów na podstawie aktualnego kodu repo.

## Spis diagramów

1. [System Context](#1-system-context)
2. [Kontenery/komponenty](#2-kontenery-i-komponenty)
3. [Przepływ danych pipeline](#3-przepływ-danych-pipeline)
4. [Sekwencja A: snapshot + evidence + judge](#4-sekwencja-a-snapshot-analysis--evidence--judge)
5. [Sekwencja B: brak userPrompt → paragrafy evidence + generic judge](#5-sekwencja-b-brak-userprompt--paragrafy-evidence--generic-judge)
6. [Sekwencja C: monitor task → open page → OCR → chunks → DB](#6-sekwencja-c-monitor-task--open-page--ocr--chunks--db)
7. [ERD / model danych](#7-erd--model-danych)
8. [State machine zadania/monitoringu](#8-state-machine-zadaniamonitoringu)
9. [Deployment runtime](#9-deployment-runtime)
10. [Luki informacyjne / placeholdery](#10-luki-informacyjne--placeholdery)

---

## 1. System Context

```mermaid
flowchart LR
    U[Użytkownik] -->|UI w przeglądarce| FE[Frontend statyczny\nstrona/*.html + skrypt/app.js]
    FE -->|REST + JWT| API[Backend Express\nskrypt/serwerStart.js + routes/*]
    API -->|SQL| PG[(PostgreSQL)]
    API -->|Mongo driver| MG[(MongoDB)]

    AG[Agent skanujący\nskrypt/agentSkanu.js] -->|SQL| PG
    AG -->|Mongo| MG
    AG -->|wywołanie pipeline| PL[Pipeline zmian\nskrypt/llm/pipelineZmian.js]
    PL -->|Mongo analyses/oceny| MG
    PL -->|wykrycia/powiadomienia| PG

    WP[Worker powiadomień\nskrypt/workerPowiadomien.js] -->|czyta i aktualizuje| PG
    WP -->|SMTP| SMTP[(Serwer SMTP)]

    CH[Plugin Chrome\nskrypt/plugin/background.js] -->|GET /api/plugin-tasks/next\nPOST /api/plugin-tasks/:id/screenshot| API
```

---

## 2. Kontenery i komponenty

```mermaid
flowchart TB
    subgraph Runtime
      API[Express API\nserwerStart.js]
      AG[Agent\nagentSkanu.js]
      WP[Worker\nworkerPowiadomien.js]
      PL[LLM/OCR Pipeline\npipelineZmian.js]
      EXT[Ekstraktory\norchestrator + extractors]
      PLUGIN[Chrome Extension\nplugin/background.js]
    end

    API --> AUTH[routes/auth.js]
    API --> MON[routes/monitory.js]
    API --> HIS[routes/historia.js]
    API --> STA[routes/statystyki.js]
    API --> PT[routes/pluginTasks.js]

    AG --> EXT
    AG --> PL
    PT --> PL

    API <--> PG[(PostgreSQL)]
    API <--> MG[(MongoDB)]
    AG <--> PG
    AG <--> MG
    PL <--> MG
    PL <--> PG
    WP <--> PG
    PLUGIN <--> PT
```

---

## 3. Przepływ danych pipeline

```mermaid
flowchart LR
    S1[Snapshot nowy\nMongo snapshots] --> P0[handleNewSnapshot]
    S0[Snapshot poprzedni\ngetPreviousSnapshot] --> P0

    P0 --> D1[computeMachineDiff lite]
    D1 --> E1{Early exit?}
    E1 -- tak --> END1[Stop: no_change/negligible]
    E1 -- nie --> O1[ensureSnapshotOcr\n(gdy potrzebne)]

    O1 --> A1[ensureSnapshotAnalysis\n(new analysis)]
    A1 --> A0[getSnapshotAnalysis\n(prev analysis)]
    A0 --> D2[computeMachineDiff full\n+ universal_data]
    D2 --> EV[evidence_v1 / evidence pool]
    EV --> J[evaluateChangeWithLLM\njudge / judge_generic]
    J --> IMP{important?}
    IMP -- nie --> END2[Stop: not_important]
    IMP -- tak --> SAVE[saveDetectionAndNotification]
    SAVE --> PG[(PG: wykrycia + powiadomienia)]
```

---

## 4. Sekwencja A: snapshot analysis + evidence + judge

```mermaid
sequenceDiagram
    participant A as Agent/Plugin Route
    participant M as Mongo snapshots
    participant P as pipelineZmian.handleNewSnapshot
    participant AN as analizaSnapshotu.ensureSnapshotAnalysis
    participant DI as diffEngine.computeMachineDiff
    participant EV as llmEvidence.extractEvidenceFromChunksLLM
    participant J as ocenaZmianyLLM.evaluateChangeWithLLM
    participant PG as PostgreSQL

    A->>M: zapis snapshot
    A->>P: handleNewSnapshot(snapshotId)
    P->>DI: getPreviousSnapshot + diffLite
    alt potrzeba OCR
      P->>M: ensureSnapshotOcr (update vision_ocr)
    end
    P->>AN: ensureSnapshotAnalysis(new)
    AN->>M: insert/find analyses
    P->>DI: computeMachineDiff(full)
    DI-->>J: diff + evidence_v1
    J->>EV: selekcja evidence z chunków
    J->>J: judgeImportanceWithLLM
    alt important=true
      J->>PG: INSERT wykrycia
      J->>PG: INSERT powiadomienia
    else important=false
      J-->>P: not important
    end
```

---

## 5. Sekwencja B: brak userPrompt → paragrafy evidence + generic judge

```mermaid
sequenceDiagram
    participant P as pipelineZmian
    participant J as ocenaZmianyLLM
    participant E as llmEvidence
    participant L as LLM Judge

    P->>J: evaluateChangeWithLLM(..., userPrompt=null)
    J->>J: normalizeUserPrompt => ""
    J->>J: effectiveUserPrompt=DEFAULT_GENERIC_USER_PROMPT
    J->>E: extractEvidenceFromChunksLLM(chunks, userPrompt="")
    E->>E: no-prompt mode: all paragraph blocks (deterministic)
    E-->>J: evidence items + focusChunkIds
    J->>L: judgeImportanceWithLLM(genericPromptUsed=true)
    L-->>J: JSON {important, category, reason, evidence_used}
    J-->>P: decision (mode=judge_generic)
```

---

## 6. Sekwencja C: monitor task -> open page -> OCR -> chunks -> DB

```mermaid
sequenceDiagram
    participant AG as agentSkanu.processTask
    participant WEB as Strona WWW
    participant EXT as extractOrchestrator
    participant M as Mongo snapshots
    participant PL as pipelineZmian
    participant OCR as ocrSnapshotu
    participant CH as chunksSnapshotu
    participant A as analizaSnapshotu

    AG->>WEB: fetch static/browser
    WEB-->>AG: HTML (+ opcjonalny screenshot)
    AG->>EXT: fetchAndExtract(finalUrl, html)
    EXT-->>AG: extracted_v2
    AG->>M: insert snapshot
    AG->>PL: handleNewSnapshot(snapshot)
    alt brak tekstu i jest screenshot
      PL->>OCR: ensureSnapshotOcr
      OCR->>M: update snapshots.vision_ocr
    end
    PL->>A: ensureSnapshotAnalysis
    A->>CH: ensureSnapshotChunks
    CH->>M: update snapshots.text_chunks_v1
    A->>M: insert analyses
```

---

## 7. ERD / model danych

```mermaid
erDiagram
    UZYTKOWNICY ||--o{ MONITORY : "uzytkownik_id"
    UZYTKOWNICY ||--o{ POWIADOMIENIA : "uzytkownik_id"
    UZYTKOWNICY ||--o{ PASSWORD_RESETS : "user_id"

    MONITORY ||--o{ ZADANIA_SKANU : "monitor_id"
    MONITORY ||--o{ PLUGIN_TASKS : "monitor_id"
    MONITORY ||--o{ WYKRYCIA : "monitor_id"
    MONITORY ||--o{ POWIADOMIENIA : "monitor_id"

    ZADANIA_SKANU ||--o{ PLUGIN_TASKS : "zadanie_id"
    ZADANIA_SKANU ||--o{ WYKRYCIA : "zadanie_id"

    WYKRYCIA ||--o{ POWIADOMIENIA : "wykrycie_id"

    SNAPSHOTS {
      objectid _id
      string monitor_id
      string zadanie_id
      string screenshot_b64
      object extracted_v2
      object vision_ocr
      object text_chunks_v1
    }

    ANALYSES {
      objectid _id
      objectid snapshot_id
      string summary
      object metrics
      object chunk_template
      object watch_spec
    }

    OCENY_ZMIAN {
      objectid _id
      string monitorId
      string zadanieId
      object llm_decision
      object analysis_diff
    }
```

---

## 8. State machine zadania/monitoringu

```mermaid
stateDiagram-v2
    [*] --> oczekuje
    oczekuje --> w_trakcie: loadPendingTasks()
    w_trakcie --> ok: finishTask(status=ok)
    w_trakcie --> blad: finishTask(status=blad)
    w_trakcie --> w_trakcie: WAITING_FOR_PLUGIN_RESULT

    state "Plugin task" as PT {
      [*] --> pending
      pending --> in_progress: GET /plugin-tasks/next
      in_progress --> done: POST /:id/screenshot OK
      in_progress --> error: błąd upload/pipeline
    }
```

---

## 9. Deployment runtime

```mermaid
flowchart TB
    subgraph Host[Maszyna/VM]
      API[Node process\nnpm run start\nport 3001]
      AG[Node process\nnpm run start:agent]
      WP[Node process\nnpm run start:worker]
      CH[Chrome Extension\nna przeglądarce klienta]
    end

    API <--> PG[(PostgreSQL)]
    API <--> MG[(MongoDB)]
    AG <--> PG
    AG <--> MG
    WP <--> PG
    WP --> SMTP[(SMTP)]
    CH <--> API
    AG --> WEB[(Internet: monitorowane strony)]
    CH --> WEB
```

---

## 10. Luki informacyjne / placeholdery

1. **DDL SQL** – brak migracji w repo, więc ERD jest odtworzony z query runtime (do potwierdzenia przez autora bazy).
2. **Docelowy deployment produkcyjny** (Docker/K8s/systemd) – brak plików IaC w repo.
3. **Topologia sieci i security hardening** – brak jawnej konfiguracji reverse proxy/TLS w repo.
