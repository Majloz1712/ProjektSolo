# Inwentarz funkcji (automatycznie z kodu)

> Zakres: pliki `*.js` w `skrypt/`, `orchestrator/`, `extractors/`, `utils/`.

## `extractors/domStructuredText.js`

- **Exporty**: DOM_STRUCTURED_TEXT_VERSION, PARA, PARA_MARKER, domToStructuredText
- **Funkcje/stałe funkcyjne lokalne**: _cloneAndDrop, _listDepth, _serializeDl, _serializeTable, _textOf, cleanInlineText, cleanLinePreserveIndent, cleanMultilineText, decodeBasicEntities, extractFromDom, finalizeToOcrLike, findMatchingBracket, insertSpacesBetweenLettersAndDigits, isHiddenByAttrs, isInBoilerplate, isString, looksSerialized, pickContentRoot, removeSerializedBlobs, shouldDropLine, splitToLines, stripHtmlTags, stripZeroWidth, tagNameLower

## `extractors/jsonldExtractor.js`

- **Exporty**: jsonldExtractor
- **Funkcje/stałe funkcyjne lokalne**: buildStructuredTextFromItemList, buildStructuredTextFromProduct, extractAttributes, extractImages, extractItemFromListElement, flattenScripts, hasType, normalizeItemListElements, normalizeTypes, parseJson, pickDescription, pickName, pickOfferPrice, scoreEntry

## `extractors/metaOgExtractor.js`

- **Exporty**: metaOgExtractor
- **Funkcje/stałe funkcyjne lokalne**: collectImages, detectPrice, pickMeta

## `extractors/priceUtils.js`

- **Exporty**: detectMainPriceFromDom
- **Funkcje/stałe funkcyjne lokalne**: isExcludedPriceText, readElementPrice

## `extractors/readabilityExtractor.js`

- **Exporty**: readabilityExtractor
- **Funkcje/stałe funkcyjne lokalne**: detectPrice, findBestContainer, scoreElement

## `extractors/visibleTextExtractor.js`

- **Exporty**: visibleTextExtractor
- **Funkcje/stałe funkcyjne lokalne**: collectVisibleTextByWalker, detectPrice, findHeuristicContainerHtml, pickMainContainer

## `orchestrator/extractOrchestrator.js`

- **Exporty**: fetchAndExtract
- **Funkcje/stałe funkcyjne lokalne**: _collapseSpacesPreserveNewlines, _lineExactKey, _lineQuality, _normalizePreserveNewlines, _stripJsonBlobs, _wrapIfSingleLine, _wrapLongLine, attachCleanExtracted, buildBlockedResult, buildRawExtractedText, cleanExtractedToLines, createDocument, createLogger, detectBlock, enrichResult, fallbackExtraction, fetchImpl, fetchStaticDocument, isResultAcceptable, renderDocument, runExtractors, toLogLine

## `skrypt/agentSkanu.js`

- **Exporty**: POLICY, determineModeByPolicy, handleCookieConsent, hardenPage, launchWithPolicy, persistSession, pickProxy, profilePath, restoreSession, runBrowserFlow
- **Funkcje/stałe funkcyjne lokalne**: buildCleanSnapshot, clearMongoSnapshots, closeAllBrowsers, createPluginTask, detectBotProtection, ensureMongo, extractPlainTextFromHtml, fetchWithTimeout, finishTask, getBrowser, gracefulExit, hashString, humanize, isPriceMissing, isUuid, loadMonitor, loadPendingTasks, loadPendingTasksForMonitor, main, markMonitorRequiresIntervention, normalizeTrybSkanu, normalizeUrl, parseSelector, pickMetaFromDocument, processTask, randomViewport, runCookieScreenshotFlow, runExecutionCycle, saveSnapshotToMongo, scanStatic, scheduleBatch, scheduleMonitorDue, sha256, sleep, updateMonitorScanMode, updateTask, waitForAny, wantsPricePlugin, withMonitorLock, withPg

## `skrypt/app.js`

- **Exporty**: (brak)
- **Funkcje/stałe funkcyjne lokalne**: setMsg

## `skrypt/jwt.js`

- **Exporty**: signJwt, verifyJwt
- **Funkcje/stałe funkcyjne lokalne**: requireSecret

## `skrypt/llm/analizaSnapshotu.js`

- **Exporty**: ensureSnapshotAnalysis
- **Funkcje/stałe funkcyjne lokalne**: buildOrReuseChunkTemplate, buildUniversalPrompt, buildUniversalSystem, chooseTextSources, getExistingAnalysisForSnapshot, isValidChunkTemplate, normalizeNumberOrNull, normalizeUniversalData, normalizeUserPrompt, safeInsertAnalysis

## `skrypt/llm/analysisUtils.js`

- **Exporty**: clampText, excerpt, extractEvidenceSnippetsFromPair, hashUserPrompt, headTailSnippets, normalizeUserPrompt, normalizeWhitespace, sanitizeNullableString, sanitizeRequiredString, sha1, slugifyKey, stableJsonStringify
- **Funkcje/stałe funkcyjne lokalne**: commonPrefixLen, commonSuffixLen, numberTokens, sliceByRange, uniqRanges, windowRange

## `skrypt/llm/chunksSnapshotu.js`

- **Exporty**: buildChunksSnapshotu, ensureSnapshotChunks, getSnapshotChunks
- **Funkcje/stałe funkcyjne lokalne**: buildSemanticPrompt, buildSemanticRepairPrompt, buildSemanticSystemPrompt, buildStructuralSegmentsFromLines, chunkMode, chunksMethodFamily, clamp, computeParagraphIndexByLine, deterministicLineChunks, deterministicLineChunksFromLines, deterministicStructuredChunksFromLines, endsWithSentencePunct, ensureMongoConnected, envBool, envNum, envStr, getCleanLines, isHeadingLine, isListItemLine, isStandaloneTokenLine, isValidChunksBlob, joinSoft, mergeOneLinersIntoNext, normalizeChunkMode, normalizeLinesForFallback, normalizeNewlinesToLines, paraTag, pickSnapshotTextSource, rebuildChunksFromRanges, renderMarkedTextFromLinesRange, renderMarkedTextFromText, safeJsonParse, semanticEnabled, semanticEnabledByConfig, semanticLineRangeChunks, shouldJoinWrappedLine, shouldReuseCachedChunks, validateRanges

## `skrypt/llm/diffEngine.js`

- **Exporty**: computeMachineDiff, getAnalysisById, getPreviousSnapshot, getSnapshotAnalysis
- **Funkcje/stałe funkcyjne lokalne**: buildTextEvidence, chunkText, collectEvidenceQuotesFromAnalysis, computeTextChunkDiff, diffUniversalData, jaccardSimilarity, normalizeB64, normalizeText, normalizeUniversalMap, parsePriceLike, sha1, simpleTextDiffScore, stableJsonHash, toNumberMaybe, toShingleSet, tokenizeWords

## `skrypt/llm/llmChunker.js`

- **Exporty**: applyChunkTemplate, buildChunkTemplateLLM, computeChunkDiff, extractChunksByTemplate, scoreTemplateFit
- **Funkcje/stałe funkcyjne lokalne**: anchorRegexFromPhrase, buildChunkingPrompt, buildChunkingSystemPrompt, escapeRegex, fallbackTemplateFromText, findBestAnchorIndex, jaccard, normalizeAnchorCandidates, normalizeTemplate, numericRatioDelta, repairTemplateWithLLM, safeParseJson, tokenizeForDiff, uniq, validateTemplate

## `skrypt/llm/llmEvidence.js`

- **Exporty**: extractEvidenceFromChunksLLM
- **Funkcje/stałe funkcyjne lokalne**: buildCandidatesForChunk, buildFxCandidatesFromText, buildKeywordsForRouterLabels, buildRankCandidatesFromText, candidatePriority, clamp, countParagraphHits, countRankLinesUpTo, detWantsDiff, detectPromptIntents, deterministicSelectAvailabilityEvidence, deterministicSelectFxEvidence, deterministicSelectNewItemEvidence, deterministicSelectNewsListEvidence, deterministicSelectParagraphEvidenceFromChunks, deterministicSelectPriceEvidence, deterministicSelectRankingEvidence, deterministicSelectRankingSetEvidence, deterministicSelectReviewsEvidence, escapeRegExp, extractParagraphBlock, extractParagraphNumbersFromText, extractPromptKeywords, extractWindowByChars, extractWindowByLines, extractWindowByWords, extractWindowSmart, fallbackSelectCandidatesDeterministic, filterTextToParagraphs, hasReviewHintLower, intFromMaybe, isFinanceContextLower, isPriceOrDeliveryNoiseLower, isSellerPercentContextLower, isWs, logEmptyEvidence, normKey, normalizeParagraphSelection, padParagraphNumber, parseFxTargetsFromPrompt, parseParagraphSelectionFromPrompt, parseRankLimitFromPrompt, promptKeywords, promptWantsSellerInfo, pushCandidate, scoreChunkForEvidence, selectChunksForEvidence, stableProductKeyForEvidence, trimToWsBoundaries

## `skrypt/llm/ocenaZmianyLLM.js`

- **Exporty**: evaluateChangeWithLLM, saveDetectionAndNotification
- **Funkcje/stałe funkcyjne lokalne**: buildDeterministicDecision, buildQuoteToIdMap, diffUniversalData, extractRatingFromEvidenceQuotes, extractRatingFromText, extractReviewsCountFromEvidenceQuotes, extractReviewsCountFromText, judgeImportanceWithLLM, mapEvidenceUsedQuotesToIds, metricDelta, normalizeKey, normalizeQuoteForMatch, normalizeUserPrompt, normalizeValue, promptMentions, safeParseJsonFromLLM, sanitizeEvidenceUsedAgainstAllowedKeys, universalDataToMap, userCaresAboutKey, userIgnoresKey

## `skrypt/llm/ocrSnapshotu.js`

- **Exporty**: ensureSnapshotOcr
- **Funkcje/stałe funkcyjne lokalne**: normalizeB64, sha1

## `skrypt/llm/ollamaClient.js`

- **Exporty**: analyzeImageWithOllama, compareImagesWithOllama, generateTextWithOllama
- **Funkcje/stałe funkcyjne lokalne**: attachAsStringObject, getCallerHint, isJsonRequested, looksLikeJsonText, normalizeB64, ollamaGenerate, resolveKeepAlive, safePreview, sha1

## `skrypt/llm/paddleOcr.js`

- **Exporty**: ocrImageWithPaddle
- **Funkcje/stałe funkcyjne lokalne**: _collapseSpacesPreserveNewlines, _countByScriptAndClass, _fixSpacingHeuristics, _lineExactKey, _lineFingerprint, _lineQuality, _mergeHyphenatedAcrossNewlines, _normalizeCommon, _stripCjkCharsEverywhere, _stripLeadingIsolatedIcons, _stripUiGlyphTokens, _stripWeirdControlAndBoxChars, cleanOcrToLines, mapLang, normalizeBase64

## `skrypt/llm/pipelineZmian.js`

- **Exporty**: handleNewSnapshot
- **Funkcje/stałe funkcyjne lokalne**: getMonitorLastGoodAnalysisId, isGoodAnalysisForBaseline, needNewOcrForDiff, needPrevOcrForDiff, setMonitorLastGoodAnalysisId, setTaskAnalysisMongoId, shouldEarlyExit, shouldRunOcr

## `skrypt/llm/semaforOllama.js`

- **Exporty**: getOllamaSemaphoreState, withOllamaSemaphore
- **Funkcje/stałe funkcyjne lokalne**: acquire, release

## `skrypt/loggerZadan.js`

- **Exporty**: createTaskLogger
- **Funkcje/stałe funkcyjne lokalne**: getMonitorMeta, slugify

## `skrypt/plugin/background.js`

- **Exporty**: (brak)
- **Funkcje/stałe funkcyjne lokalne**: apiFetch, arrayBufferToBase64, blobToDataUrl, captureBestEffortFullPageScreenshot, captureBestEffortScreenshot, captureFullPageScreenshotDataUrl, captureVisibleTabDataUrl, captureVisibleTabDataUrlWithRetry, dataUrlToImageBitmap, drainQueue, extractDomForBackend, extractPricesFromDom, fetchNextPluginTask, focusAndActivate, getPageMetrics, openWindowForTask, pollForTasks, processTask, scrollToYAndWait, sendPluginDomResult, sendPluginPriceResult, sendPluginScreenshotOnly, sendPluginScreenshotResult, sleep, tryAcceptCookies, waitForLoadAndExtractPrices, waitForLoadAndScreenshot, waitForLoadAndSendScreenshot, waitTwoRafsInPage

## `skrypt/plugin/config.js`

- **Exporty**: AUTH_TOKEN, BACKEND_BASE_URL, POLL_INTERVAL_SECONDS
- **Funkcje/stałe funkcyjne lokalne**: (brak)

## `skrypt/polaczenieMDB.js`

- **Exporty**: connectMongo, getDb, mongoClient
- **Funkcje/stałe funkcyjne lokalne**: (brak)

## `skrypt/polaczeniePG.js`

- **Exporty**: pool
- **Funkcje/stałe funkcyjne lokalne**: (brak)

## `skrypt/routes/auth.js`

- **Exporty**: (brak)
- **Funkcje/stałe funkcyjne lokalne**: buildResetUrl, createMailTransporter, getBaseUrl, isEmail, sendPasswordResetEmail, sha256

## `skrypt/routes/historia.js`

- **Exporty**: (brak)
- **Funkcje/stałe funkcyjne lokalne**: buildMeta, detailsToText, ensureTaskAccess, fetchAnaliza, fetchOcena, fetchSnapshot, isValidObjectId, normalizeMongoDoc, safeStringId

## `skrypt/routes/monitory.js`

- **Exporty**: (brak)
- **Funkcje/stałe funkcyjne lokalne**: normalizeTrybSkanu

## `skrypt/routes/pluginTasks.js`

- **Exporty**: (brak)
- **Funkcje/stałe funkcyjne lokalne**: ensureMongoDb, finishScanTask, loadMonitorPrompt, normalizeB64, resolvePluginTaskByAnyId, safeLoadMonitorPrompt, setPluginTaskStatus, sha1

## `skrypt/routes/statystyki.js`

- **Exporty**: (brak)
- **Funkcje/stałe funkcyjne lokalne**: getUserMonitors

## `skrypt/tools/exportScreenshots.js`

- **Exporty**: (brak)
- **Funkcje/stałe funkcyjne lokalne**: arg, detectExtFromBase64, main, stripPrefix

## `skrypt/workerPowiadomien.js`

- **Exporty**: (brak)
- **Funkcje/stałe funkcyjne lokalne**: fetchPendingNotifications, markAsSent, processBatch, sendNotificationEmail, verifyTransport

## `utils/cleanLines.js`

- **Exporty**: cleanTextToLines, splitToLineCandidates, truncateLinesForMongo
- **Funkcje/stałe funkcyjne lokalne**: _collapseSpacesPreserveNewlines, _countByScriptAndClass, _countNewlines, _findMatchingBracket, _fixSpacingHeuristics, _lineExactKey, _lineFingerprint, _lineQuality, _looksLikeSerializedState, _mergeHyphenatedAcrossNewlines, _normalizeCommon, _stripCjkCharsEverywhere, _stripLeadingIsolatedIcons, _stripUiGlyphTokens, _stripWeirdControlAndBoxChars, isStructuralMarker, sanitizeRawText, stripSerializedStateBlocks

## `utils/normalize.js`

- **Exporty**: clampTextLength, inferContentType, normalizePriceCandidate, normalizeWhitespace, sanitizeArray, toISODate
- **Funkcje/stałe funkcyjne lokalne**: detectCurrency

## `utils/retryBackoff.js`

- **Exporty**: retryWithBackoff
- **Funkcje/stałe funkcyjne lokalne**: (brak)

