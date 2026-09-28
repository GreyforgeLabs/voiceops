import assert from 'node:assert/strict';
import { test } from 'node:test';
import { takeSentenceChunks } from '../src/sentence-chunks.mjs';

test('returns only complete sentences from a growing snapshot', () => {
  const text = 'First sentence. Second is still arriving';
  const result = takeSentenceChunks(text);

  assert.deepEqual(result.chunks, ['First sentence.']);
  assert.equal(text.slice(result.consumed), 'Second is still arriving');
});

test('keeps quoted punctuation together and flushes a final fragment', () => {
  const result = takeSentenceChunks('She said “go!” Then wait', { flush: true });

  assert.deepEqual(result.chunks, ['She said “go!”', 'Then wait']);
  assert.equal(result.consumed, 'She said “go!” Then wait'.length);
});

test('does not create empty chunks for repeated whitespace', () => {
  const result = takeSentenceChunks('One.   Two.\n\nThree', { flush: true });

  assert.deepEqual(result.chunks, ['One.', 'Two.', 'Three']);
});
