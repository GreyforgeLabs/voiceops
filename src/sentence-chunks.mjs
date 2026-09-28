const SENTENCE_END = /[.!?]["'”’)}\]]*\s+/gu;

/**
 * Take complete sentences from a growing assistant-text snapshot.
 * Whitespace after a boundary is consumed so a later snapshot starts cleanly.
 */
export function takeSentenceChunks(text, { flush = false } = {}) {
  const source = typeof text === 'string' ? text : '';
  const chunks = [];
  let start = 0;
  let consumed = 0;

  for (const match of source.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    const whitespace = match[0].match(/\s+$/u)?.[0].length ?? 0;
    const sentenceEnd = end - whitespace;
    const sentence = source.slice(start, sentenceEnd).trim();
    if (sentence) chunks.push(sentence);
    start = end;
    consumed = end;
  }

  if (flush) {
    const remainder = source.slice(start).trim();
    if (remainder) chunks.push(remainder);
    consumed = source.length;
  }

  return { chunks, consumed };
}
