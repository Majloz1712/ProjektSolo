import assert from 'node:assert/strict';
import { parseKeyValueBlock } from '../skrypt/llm/analysisUtils.js';

const keys = ['SUMMARY', 'PRODUCT_TYPE', 'MAIN_CURRENCY', 'PRICE_MIN', 'PRICE_MAX', 'FEATURE'];
const block = `BEGIN_TRACKLY_ANALYSIS
SUMMARY=Krótki opis
PRODUCT_TYPE=buty
MAIN_CURRENCY=PLN
PRICE_MIN=10
PRICE_MAX=20
FEATURE=- lista ofert
END_TRACKLY_ANALYSIS`;

const directResult = parseKeyValueBlock(block, {
  beginMarker: 'BEGIN_TRACKLY_ANALYSIS',
  endMarker: 'END_TRACKLY_ANALYSIS',
  keys,
});
assert.equal(directResult.ok, true);
assert.equal(directResult.mode, 'direct');

const extractedResult = parseKeyValueBlock(`Here is the result:\n${block}\nThanks!`, {
  beginMarker: 'BEGIN_TRACKLY_ANALYSIS',
  endMarker: 'END_TRACKLY_ANALYSIS',
  keys,
});
assert.equal(extractedResult.ok, true);
assert.equal(extractedResult.mode, 'extracted');

const missingResult = parseKeyValueBlock('Brak bloku.', {
  beginMarker: 'BEGIN_TRACKLY_ANALYSIS',
  endMarker: 'END_TRACKLY_ANALYSIS',
  keys,
});
assert.equal(missingResult.ok, false);
const fallbackReason = missingResult.ok ? null : 'NO_KV_FROM_LLM';
const error = missingResult.ok ? null : 'LLM_NO_BLOCK_FOUND';
assert.equal(fallbackReason, 'NO_KV_FROM_LLM');
assert.equal(error, 'LLM_NO_BLOCK_FOUND');

console.log('parseKeyValueBlock checks passed.');
