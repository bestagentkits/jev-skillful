/**
 * Tokenizer for BM25 retrieval over capability descriptions.
 *
 * Capability names are written in every convention at once, so the tokenizer has to
 * normalise them before scoring: `ak-backend-development` has to become three terms,
 * and `claudeFable` has to become two. A tokenizer bug here is silent — retrieval
 * simply gets worse — so the behaviour is pinned by tests using real catalog ids.
 */

/**
 * Minimal English stopword list.
 *
 * Deliberately small. Words like `use`, `add`, `create`, `fix` and `write` carry most of
 * the signal in a capability description and are kept even though a general-purpose list
 * would drop them.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "can",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "his",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "she",
  "so",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "will",
  "with",
  "you",
  "your",
]);

/** A trailing file extension is naming noise, not content: `SKILL.md` is `skill`. */
const TRAILING_EXTENSION = /\.(md|markdown|toml|json|ya?ml|txt)$/i;

/** Boundary between a lower/digit run and an upper run: `claudeFable` -> `claude Fable`. */
const LOWER_TO_UPPER = /(\p{Ll}|\p{N})(\p{Lu})/gu;

/** Boundary inside an acronym run: `HTTPServer` -> `HTTP Server`. */
const ACRONYM_TO_WORD = /(\p{Lu}+)(\p{Lu}\p{Ll})/gu;

/**
 * Split text into lowercase search terms.
 *
 * Order-independent and safe for accented text, because the separator is defined as
 * "not a letter and not a number" rather than as ASCII punctuation. Vietnamese prompts
 * tokenise on their syllables without special handling.
 */
export function tokenize(input: string): string[] {
  if (input.length === 0) return [];

  const withoutExtension = input.replace(TRAILING_EXTENSION, "");
  const spaced = withoutExtension
    .replace(LOWER_TO_UPPER, "$1 $2")
    .replace(ACRONYM_TO_WORD, "$1 $2")
    .toLowerCase();

  const tokens: string[] = [];
  for (const raw of spaced.split(/[^\p{L}\p{N}]+/u)) {
    // Single characters carry almost no retrieval signal and match noise such as
    // list markers, but they are cheap to keep for languages where they are words.
    if (raw.length === 0) continue;
    if (STOPWORDS.has(raw)) continue;
    tokens.push(raw);
  }
  return tokens;
}
