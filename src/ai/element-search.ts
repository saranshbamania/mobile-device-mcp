// ============================================================
// Local Element Search — Fast UI tree search without AI calls
//
// Searches UIElement[] by text, content description, resource ID,
// and class name. Returns an ElementMatch compatible with the AI
// findElement response so callers can use it as a drop-in fast
// path before falling back to the AI.
// ============================================================

import type { UIElement, ElementMatch, AnalyzedElement } from "../types.js";

// ----------------------------------------------------------
// Number-word mapping for natural language queries
// ----------------------------------------------------------

const WORD_TO_DIGIT: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
};

const DIGIT_TO_WORD: Record<string, string> = {};
for (const [word, digit] of Object.entries(WORD_TO_DIGIT)) {
  DIGIT_TO_WORD[digit] = word;
}

// Common UI label aliases — maps user-friendly terms to what Android actually uses
const ALIASES: Record<string, string[]> = {
  ac: ["clear", "clr", "all_clear"],
  "all clear": ["clear", "clr", "ac"],
  clear: ["clr", "ac", "all_clear"],
  delete: ["del", "backspace"],
  backspace: ["del", "delete"],
  back: ["navigate_up", "back"],
  close: ["dismiss", "close", "cancel"],
  cancel: ["dismiss", "close", "cancel"],
  ok: ["confirm", "accept", "done"],
  confirm: ["ok", "accept", "done"],
  search: ["search", "find", "query"],
  settings: ["settings", "preferences", "gear"],
  more: ["more_options", "overflow", "menu"],
  share: ["share", "send"],
  add: ["add", "plus", "new", "create"],
  subtract: ["minus", "subtract"],
  minus: ["subtract", "minus"],
  divide: ["division", "divide"],
  enter: ["return", "submit", "done"],
  submit: ["enter", "return", "done"],
};

// Words that provide type hints but are not part of the search text
const TYPE_HINT_WORDS = new Set([
  "button",
  "field",
  "input",
  "text",
  "label",
  "icon",
  "image",
  "checkbox",
  "switch",
  "toggle",
  "link",
  "tab",
  "menu",
  "item",
  "option",
  "card",
  "toolbar",
]);

// Filler words to strip from queries
const FILLER_WORDS = new Set([
  "the",
  "a",
  "an",
  "that",
  "this",
  "which",
  "with",
  "for",
  "on",
  "at",
  "in",
  "of",
  "to",
  "says",
  "saying",
  "labeled",
  "labelled",
  "called",
  "named",
  "number",
  "digit",
]);

// ----------------------------------------------------------
// Query parsing
// ----------------------------------------------------------

interface ParsedQuery {
  /** The raw original query, lowercased and trimmed. */
  raw: string;
  /** Core search tokens after removing fillers and type hints. */
  searchTokens: string[];
  /** Type hints extracted from the query (e.g., "button"). */
  typeHints: string[];
  /** Numeric variants: if query mentions "7", also try "seven" and vice versa. */
  numericVariants: string[];
  /** Alias expansions for common UI terms (e.g., "AC" → ["clear", "clr"]). */
  aliasVariants: string[];
}

function parseQuery(query: string): ParsedQuery {
  const raw = query.toLowerCase().trim();
  const words = raw.split(/\s+/);

  const searchTokens: string[] = [];
  const typeHints: string[] = [];
  const numericVariants: string[] = [];
  const aliasVariants: string[] = [];

  for (const word of words) {
    if (FILLER_WORDS.has(word)) continue;

    if (TYPE_HINT_WORDS.has(word)) {
      typeHints.push(word);
      continue;
    }

    // Convert number words to digits and vice versa
    if (WORD_TO_DIGIT[word]) {
      const digit = WORD_TO_DIGIT[word];
      searchTokens.push(digit);
      numericVariants.push(word);
    } else if (DIGIT_TO_WORD[word]) {
      searchTokens.push(word);
      numericVariants.push(DIGIT_TO_WORD[word]);
    } else {
      searchTokens.push(word);
    }

    // Expand aliases for all non-filler words
    if (ALIASES[word]) {
      aliasVariants.push(...ALIASES[word]);
    }
  }

  // Also check multi-word aliases (e.g., "all clear")
  const joined = words.filter(w => !FILLER_WORDS.has(w)).join(" ");
  if (ALIASES[joined]) {
    aliasVariants.push(...ALIASES[joined]);
  }

  // If all words were fillers/hints, use the full raw query minus fillers
  if (searchTokens.length === 0) {
    // Use type hints as search tokens as fallback
    searchTokens.push(...typeHints);
  }

  return { raw, searchTokens, typeHints, numericVariants, aliasVariants };
}

// ----------------------------------------------------------
// Scoring
// ----------------------------------------------------------

interface ScoredElement {
  element: UIElement;
  score: number;
  matchReason: string;
}

/**
 * Map simplified class name to AnalyzedElement type.
 */
function classNameToType(className: string): string {
  const simple = className.toLowerCase();
  if (simple.includes("button")) return "button";
  if (simple.includes("edittext") || simple.includes("textfield")) return "text_field";
  if (simple.includes("checkbox")) return "checkbox";
  if (simple.includes("switch") || simple.includes("toggle")) return "switch";
  if (simple.includes("image")) return "image";
  if (simple.includes("tab")) return "tab";
  if (simple.includes("textview") || simple.includes("text")) return "text";
  return "other";
}

/**
 * Map class name to a suggested action.
 */
function suggestedActionForClass(className: string): string {
  const simple = className.toLowerCase();
  if (simple.includes("edittext") || simple.includes("textfield")) return "type";
  if (simple.includes("scroll")) return "scroll";
  return "tap";
}

/**
 * Flatten the element tree, collecting all elements with their children recursively.
 */
function flattenElements(elements: UIElement[]): UIElement[] {
  const result: UIElement[] = [];
  function walk(els: UIElement[]): void {
    for (const el of els) {
      result.push(el);
      if (el.children) {
        walk(el.children);
      }
    }
  }
  walk(elements);
  return result;
}

/**
 * Get the stripped resource ID (after the last '/').
 */
function stripResourceId(resourceId: string): string {
  const slash = resourceId.lastIndexOf("/");
  return slash >= 0 ? resourceId.slice(slash + 1) : resourceId;
}

/**
 * Score a single element against the parsed query.
 * Returns a score from 0.0 to 1.0 and a match reason.
 */
function scoreElement(el: UIElement, pq: ParsedQuery): ScoredElement {
  let bestScore = 0;
  let bestReason = "";

  const elText = el.text.toLowerCase();
  const elDesc = el.contentDescription.toLowerCase();
  const elId = stripResourceId(el.resourceId).toLowerCase();
  const elClass = el.className.toLowerCase();

  // All search tokens joined
  const searchString = pq.searchTokens.join(" ");

  // Also build variant strings that include numeric word forms and aliases
  const allVariants = [...pq.searchTokens, ...pq.numericVariants, ...pq.aliasVariants];

  // ---- Strategy 1: Exact text match (highest confidence) ----
  if (elText && elText === searchString) {
    bestScore = 1.0;
    bestReason = `Exact text match: "${el.text}"`;
  }

  // ---- Strategy 2: Text contains all search tokens ----
  if (bestScore < 0.95 && elText) {
    const tokensMatched = pq.searchTokens.filter(
      (t) => elText.includes(t),
    ).length;
    if (tokensMatched === pq.searchTokens.length && pq.searchTokens.length > 0) {
      // All tokens found in text
      const ratio = searchString.length / Math.max(elText.length, 1);
      const score = 0.85 + 0.1 * Math.min(ratio, 1);
      if (score > bestScore) {
        bestScore = score;
        bestReason = `Text contains all tokens: "${el.text}"`;
      }
    } else if (tokensMatched > 0) {
      const score = 0.5 * (tokensMatched / pq.searchTokens.length);
      if (score > bestScore) {
        bestScore = score;
        bestReason = `Text partial match: "${el.text}"`;
      }
    }
  }

  // ---- Strategy 2b: Text matches numeric variants ----
  if (bestScore < 0.9 && elText && pq.numericVariants.length > 0) {
    const variantsMatched = allVariants.filter((v) => elText.includes(v)).length;
    if (variantsMatched > 0) {
      const score = 0.8 * (variantsMatched / allVariants.length);
      if (score > bestScore) {
        bestScore = score;
        bestReason = `Text matches numeric variant: "${el.text}"`;
      }
    }
  }

  // ---- Strategy 3: Content description match ----
  if (bestScore < 0.9 && elDesc) {
    // Exact match on search string
    if (elDesc === searchString) {
      const score = 0.95;
      if (score > bestScore) {
        bestScore = score;
        bestReason = `Exact content description match: "${el.contentDescription}"`;
      }
    }
    // Exact match on an alias variant (e.g., "AC" → desc="clear")
    if (bestScore < 0.9 && pq.aliasVariants.some((a) => elDesc === a)) {
      const score = 0.9;
      if (score > bestScore) {
        bestScore = score;
        bestReason = `Alias match on content description: "${el.contentDescription}"`;
      }
    }
    // Partial token/variant match
    if (bestScore < 0.85) {
      const tokensMatched = allVariants.filter((t) => elDesc.includes(t)).length;
      if (tokensMatched > 0) {
        // Use max of search tokens and alias variants separately to avoid dilution
        const searchMatched = pq.searchTokens.filter((t) => elDesc.includes(t)).length;
        const aliasMatched = pq.aliasVariants.filter((t) => elDesc.includes(t)).length;
        const bestRatio = Math.max(
          pq.searchTokens.length > 0 ? searchMatched / pq.searchTokens.length : 0,
          pq.aliasVariants.length > 0 ? aliasMatched / pq.aliasVariants.length : 0,
        );
        const score = 0.7 * bestRatio;
        if (score > bestScore) {
          bestScore = score;
          bestReason = `Content description match: "${el.contentDescription}"`;
        }
      }
    }
  }

  // ---- Strategy 3b: Alias matches on text ----
  if (bestScore < 0.9 && elText && pq.aliasVariants.length > 0) {
    if (pq.aliasVariants.some((a) => elText === a)) {
      const score = 0.9;
      if (score > bestScore) {
        bestScore = score;
        bestReason = `Alias match on text: "${el.text}"`;
      }
    }
  }

  // ---- Strategy 4: Resource ID match ----
  if (bestScore < 0.85 && elId) {
    // Resource IDs use snake_case, so split on underscores
    const idParts = elId.split(/[_\-]/);
    // Exact alias match on resource ID
    if (pq.aliasVariants.some((a) => idParts.includes(a))) {
      const score = 0.8;
      if (score > bestScore) {
        bestScore = score;
        bestReason = `Alias match on resource ID: "${el.resourceId}"`;
      }
    }
    // Partial token match
    if (bestScore < 0.75) {
      const tokensMatched = pq.searchTokens.filter(
        (t) => idParts.some((p) => p === t || p.includes(t)),
      ).length;
      if (tokensMatched > 0) {
        const score = 0.6 * (tokensMatched / pq.searchTokens.length);
        if (score > bestScore) {
          bestScore = score;
          bestReason = `Resource ID match: "${el.resourceId}"`;
        }
      }
    }
  }

  // ---- Strategy 5: Class name hint match ----
  if (pq.typeHints.length > 0 && bestScore > 0) {
    // Boost score if the type hint matches the element class
    const classMatches = pq.typeHints.some((hint) => elClass.includes(hint));
    if (classMatches) {
      bestScore = Math.min(bestScore + 0.1, 1.0);
      bestReason += " (type hint match)";
    }
  }

  // ---- Penalty: non-interactive elements get a small penalty ----
  if (!el.clickable && !el.focusable && !el.scrollable) {
    bestScore *= 0.9;
  }

  // ---- Penalty: empty/invisible elements ----
  if (el.bounds.left === el.bounds.right || el.bounds.top === el.bounds.bottom) {
    bestScore *= 0.1;
  }

  return { element: el, score: bestScore, matchReason: bestReason };
}

// ----------------------------------------------------------
// Public API
// ----------------------------------------------------------

/**
 * Search UI elements locally by text matching.
 * This is INSTANT and FREE — no AI API call needed.
 * Falls back to AI only when local search fails (returns found: false).
 *
 * @param elements - The UI element tree from the device
 * @param query - Natural language query like "the number 7 button"
 * @returns An ElementMatch result compatible with AI findElement output
 */
export function searchElementsLocally(
  elements: UIElement[],
  query: string,
): ElementMatch {
  if (!elements || elements.length === 0) {
    return { found: false, confidence: 0 };
  }

  const pq = parseQuery(query);

  // If we couldn't extract any meaningful tokens, bail out to AI
  if (pq.searchTokens.length === 0) {
    return { found: false, confidence: 0 };
  }

  // Flatten the tree and score every element
  const flat = flattenElements(elements);
  const scored = flat
    .map((el) => scoreElement(el, pq))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { found: false, confidence: 0 };
  }

  const best = scored[0];

  // Convert UIElement to AnalyzedElement
  function toAnalyzed(se: ScoredElement): AnalyzedElement {
    const el = se.element;
    return {
      description: se.matchReason,
      type: classNameToType(el.className),
      text: el.text || el.contentDescription,
      bounds: { ...el.bounds },
      suggestedAction: suggestedActionForClass(el.className),
      confidence: se.score,
    };
  }

  const alternatives = scored
    .slice(1, 4) // up to 3 runners-up
    .filter((s) => s.score > 0.2)
    .map(toAnalyzed);

  return {
    found: best.score > 0.7,
    element: toAnalyzed(best),
    confidence: best.score,
    alternatives,
  };
}
