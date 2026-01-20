import test from "node:test";
import assert from "node:assert/strict";
import { chunkPageText } from "../dist/index.js";

const sampleText = `
# Section One
Intro paragraph about alpha.

Details line one.
Details line two.

## Section Two
Beta summary paragraph.

- List item A
- List item B

## Section Three
Gamma content paragraph.
`.trim();

test("respects previous chunk count", async () => {
  const previous = {
    chunks: [
      { id: 0, title: "One", text: "Prev one" },
      { id: 1, title: "Two", text: "Prev two" },
      { id: 2, title: "Three", text: "Prev three" },
    ],
  };
  const result = await chunkPageText(
    { text: sampleText, previous },
    { forceFallback: true },
  );
  assert.equal(result.chunks.length, 3);
});

test("no empty chunks and increasing boundaries", async () => {
  const result = await chunkPageText(
    { text: sampleText },
    { forceFallback: true },
  );
  result.chunks.forEach((chunk) => {
    assert.ok(chunk.text.length > 0);
  });
  for (let i = 1; i < result.chunks.length; i += 1) {
    assert.ok(result.chunks[i].unit_start > result.chunks[i - 1].unit_end);
  }
});

test("deterministic output with seed", async () => {
  const options = { forceFallback: true, seed: 123 };
  const first = await chunkPageText({ text: sampleText }, options);
  const second = await chunkPageText({ text: sampleText }, options);
  assert.deepEqual(first.unit_map, second.unit_map);
  assert.deepEqual(
    first.chunks.map((chunk) => chunk.sha256),
    second.chunks.map((chunk) => chunk.sha256),
  );
});
