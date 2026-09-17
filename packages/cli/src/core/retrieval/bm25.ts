/**
 * BM25 ranking, implemented directly rather than pulled in as a dependency.
 *
 * The corpus is a few hundred short capability descriptions, so the whole index fits in
 * memory and is rebuilt per query. That is fast enough (measured in the low
 * milliseconds) and keeps the ranking behaviour inspectable, which matters because the
 * shortlist is the part of routing most likely to be tuned in phase 3.
 */

import { tokenize } from "./tokenize.js";

export interface Bm25Doc {
  id: string;
  /** Text to score. Usually `name` plus `description`. */
  text: string;
}

export interface ScoredDoc {
  id: string;
  score: number;
}

export interface Bm25Options {
  /** Term frequency saturation. 1.2 is the usual default. */
  k1?: number;
  /** Length normalisation strength, 0 disables it. 0.75 is the usual default. */
  b?: number;
}

const DEFAULT_K1 = 1.2;
const DEFAULT_B = 0.75;

/** Inverse document frequency, BM25's probabilistic variant, which cannot go negative. */
function idf(docCount: number, docFreq: number): number {
  return Math.log(1 + (docCount - docFreq + 0.5) / (docFreq + 0.5));
}

/**
 * Score every document against the query and return them sorted best first.
 *
 * Documents that share no term with the query score zero and are still returned, ordered
 * by id so the result is deterministic. Dropping them would silently shrink the
 * shortlist; keeping them lets the caller decide whether a zero-match corpus is worth
 * sending. Ties are broken by id so a rerun on the same catalog gives the same order.
 */
export function rankBm25(
  docs: readonly Bm25Doc[],
  query: string,
  options: Bm25Options = {},
): ScoredDoc[] {
  const k1 = options.k1 ?? DEFAULT_K1;
  const b = options.b ?? DEFAULT_B;
  const queryTerms = tokenize(query);

  if (docs.length === 0) return [];
  if (queryTerms.length === 0) {
    return docs.map((doc) => ({ id: doc.id, score: 0 })).sort((x, y) => (x.id < y.id ? -1 : 1));
  }

  const termFrequencies: Map<string, number>[] = [];
  const documentFrequencies = new Map<string, number>();
  let totalLength = 0;

  for (const doc of docs) {
    const terms = tokenize(doc.text);
    totalLength += terms.length;

    const frequencies = new Map<string, number>();
    for (const term of terms) {
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
    termFrequencies.push(frequencies);

    for (const term of frequencies.keys()) {
      documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1);
    }
  }

  const averageLength = totalLength / docs.length;
  const scored: ScoredDoc[] = [];

  for (let i = 0; i < docs.length; i += 1) {
    const doc = docs[i];
    const frequencies = termFrequencies[i];
    if (doc === undefined || frequencies === undefined) continue;

    const length = [...frequencies.values()].reduce((sum, count) => sum + count, 0);
    // Only the length part of the formula is normalised here; an empty document would
    // otherwise divide by zero.
    const lengthRatio = averageLength === 0 ? 0 : length / averageLength;

    let score = 0;
    for (const term of queryTerms) {
      const frequency = frequencies.get(term);
      if (frequency === undefined) continue;
      const docFreq = documentFrequencies.get(term) ?? 0;
      const numerator = frequency * (k1 + 1);
      const denominator = frequency + k1 * (1 - b + b * lengthRatio);
      score += idf(docs.length, docFreq) * (numerator / denominator);
    }

    scored.push({ id: doc.id, score });
  }

  return scored.sort((x, y) => (y.score - x.score) || (x.id < y.id ? -1 : 1));
}
