import assert from 'node:assert/strict';
import { parseKeyValueBlock } from '../skrypt/llm/analysisUtils.js';

const block = `BEGIN_TRACKLY_ANALYSIS
SUMMARY=Krótki opis
PRODUCT_TYPE=buty
MAIN_CURRENCY=PLN
PRICE_MIN=10
PRICE_MAX=20
FEATURE=- lista ofert
END_TRACKLY_ANALYSIS`;

const directResult = parseKeyValueBlock(block);
assert.equal(directResult.parseMode, 'direct');
assert.equal(directResult.error, null);
assert.ok(directResult.parsed);

const extractedResult = parseKeyValueBlock(`Here is the result:\n\`\`\`\n${block}\n\`\`\`\nThanks!`);
assert.equal(extractedResult.parseMode, 'extracted');
assert.equal(extractedResult.error, null);
assert.ok(extractedResult.parsed);

const missingResult = parseKeyValueBlock('Brak bloku.');
assert.equal(missingResult.parseMode, 'none');
assert.equal(missingResult.error, 'LLM_NO_BLOCK_FOUND');
assert.equal(missingResult.parsed, null);

console.log('parseKeyValueBlock checks passed.');
