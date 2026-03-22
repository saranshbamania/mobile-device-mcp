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

// ----------------------------------------------------------
// Semantic Alias Map — Self-healing element search
//
// Each group is a set of synonyms. When a user says "tap Login"
// but the button says "Sign In", the alias system resolves it
// locally in <1ms without an AI call.
//
// Architecture: synonym groups are defined once, then expanded
// into the bidirectional ALIASES map automatically. This avoids
// the maintenance nightmare of manual bidirectional entries.
//
// False-positive notes (terms that appear in multiple groups):
//   "close"  — navigation (close dialog) vs destructive (close account).
//              Kept in navigation only; "close account" is multi-word and
//              won't match the single-word alias.
//   "send"   — communication (send message) vs share (send link).
//              Kept in communication; share group uses "share" as anchor.
//   "save"   — confirmation (save changes) vs social (save/bookmark post).
//              Kept in confirmation only; social uses "bookmark"/"favorite".
//   "update" — edit (update record) vs refresh (update feed).
//              Kept in edit only; refresh uses "reload"/"sync".
//   "new"    — add (new item) vs compose (new message).
//              Kept in add only; compose group uses "compose"/"write".
// ----------------------------------------------------------

/**
 * Synonym groups. Each array is a cluster of interchangeable terms.
 * The buildAliases() function expands these into the flat bidirectional
 * map that the scoring engine consumes.
 */
const SYNONYM_GROUPS: string[][] = [
  // ---- Category 1: Authentication ----
  ["login", "log_in", "log in", "signin", "sign_in", "sign in", "logon", "log_on", "log on", "signon", "sign_on", "sign on"],
  ["signup", "sign_up", "sign up", "register", "create_account", "create account", "join", "get_started", "get started", "enroll", "enrol"],
  ["logout", "log_out", "log out", "signout", "sign_out", "sign out", "logoff", "log_off", "log off"],
  ["forgot_password", "forgot password", "reset_password", "reset password", "recover_password", "recover password", "forgot_pin", "forgot pin"],

  // ---- Category 2: Navigation ----
  ["back", "navigate_up", "go_back", "go back", "previous", "prev", "return", "arrow_back"],
  ["close", "dismiss", "x", "close_button", "btn_close"],
  ["cancel", "nevermind", "never_mind", "never mind", "not_now", "not now", "no_thanks", "no thanks", "skip"],
  ["exit", "quit", "leave"],
  ["forward", "next_page", "next page", "arrow_forward"],
  ["home", "go_home", "go home", "main", "start"],

  // ---- Category 3: Confirmation ----
  ["submit", "confirm", "done", "apply", "save", "finish", "complete"],
  ["ok", "okay", "got_it", "got it", "understood", "acknowledge", "ack"],
  ["yes", "agree", "accept", "allow", "permit", "grant", "approve"],
  ["continue", "proceed", "go", "next", "advance", "move_on", "move on"],
  ["enter", "return"],

  // ---- Category 4: Destructive ----
  ["delete", "del", "remove", "trash", "discard", "erase"],
  ["clear", "clr", "ac", "all_clear", "clear_all", "clear all", "reset"],
  ["backspace", "bksp"],
  ["undo", "revert", "rollback", "roll_back", "roll back"],

  // ---- Category 5: Search / Filter ----
  ["search", "find", "lookup", "look_up", "look up", "query"],
  ["filter", "sort", "refine", "narrow"],
  ["browse", "explore", "discover"],

  // ---- Category 6: Settings / Config ----
  ["settings", "preferences", "prefs", "options", "configuration", "config", "gear", "cog"],
  ["account", "profile", "my_account", "my account", "my_profile", "my profile", "user"],

  // ---- Category 7a: Menu / Overflow ----
  ["menu", "hamburger", "nav_menu", "nav menu", "drawer", "sidebar", "side_menu", "side menu"],
  ["more", "more_options", "more options", "overflow", "three_dots", "three dots", "dots", "ellipsis", "kebab"],

  // ---- Category 7b: Share ----
  ["share", "share_button", "forward", "send_to", "send to"],

  // ---- Category 7c: Edit ----
  ["edit", "modify", "change", "update", "revise", "amend", "pencil", "pen"],

  // ---- Category 7d: Add / Create ----
  ["add", "plus", "new", "create", "insert", "fab"],

  // ---- Category 7e: Refresh ----
  ["refresh", "reload", "sync", "synchronize", "pull_to_refresh", "pull to refresh"],

  // ---- Category 8: Media Controls ----
  ["play", "resume", "start_playback", "start playback"],
  ["pause", "hold"],
  ["stop", "end", "halt"],
  ["mute", "silence", "sound_off", "sound off"],
  ["unmute", "sound_on", "sound on", "unsilence"],
  ["volume", "vol", "sound"],
  ["volume_up", "volume up", "louder", "vol_up", "vol up"],
  ["volume_down", "volume down", "quieter", "softer", "vol_down", "vol down"],
  ["rewind", "rw", "skip_back", "skip back", "seek_back", "seek back"],
  ["fast_forward", "fast forward", "ff", "skip_forward", "skip forward", "seek_forward", "seek forward"],
  ["previous_track", "previous track", "prev_track", "prev track", "skip_previous", "skip previous"],
  ["next_track", "next track", "skip_next", "skip next"],
  ["shuffle", "random"],
  ["repeat", "loop", "replay"],
  ["fullscreen", "full_screen", "full screen", "maximize", "expand_video", "expand video"],

  // ---- Category 9: Shopping / Commerce ----
  ["cart", "bag", "basket", "shopping_cart", "shopping cart", "shopping_bag", "shopping bag"],
  ["checkout", "check_out", "check out", "pay", "payment", "place_order", "place order"],
  ["buy", "purchase", "order", "buy_now", "buy now"],
  ["add_to_cart", "add to cart", "add_to_bag", "add to bag", "add_to_basket", "add to basket"],
  ["wishlist", "wish_list", "wish list", "save_for_later", "save for later", "want"],
  ["coupon", "promo", "promo_code", "promo code", "discount", "voucher", "discount_code", "discount code"],

  // ---- Category 10: Communication ----
  ["chat", "message", "msg", "im", "dm", "direct_message", "direct message", "conversation"],
  ["send", "send_message", "send message", "deliver"],
  ["reply", "respond", "answer"],
  ["compose", "write", "draft", "new_message", "new message"],
  ["comment", "remark", "note"],
  ["attach", "attachment", "paperclip", "clip"],
  ["call", "phone", "dial", "ring"],
  ["video_call", "video call", "video_chat", "video chat", "facetime"],

  // ---- Category 11a: Navigation Labels ----
  ["dashboard", "overview", "summary"],
  ["feed", "timeline", "stream", "wall"],
  ["activity", "recent", "history"],
  ["notifications", "alerts", "bell", "notif", "notifs"],

  // ---- Category 11b: Social Actions ----
  ["like", "love", "heart", "thumbs_up", "thumbs up", "upvote"],
  ["dislike", "thumbs_down", "thumbs down", "downvote"],
  ["favorite", "fav", "star", "bookmark", "pin", "save_post", "save post"],

  // ---- Category 11c: Download / Upload ----
  ["download", "install", "get", "fetch", "save_file", "save file"],
  ["upload", "import", "attach_file", "attach file"],

  // ---- Category 12a: Enable / Disable ----
  ["enable", "activate", "turn_on", "turn on", "switch_on", "switch on", "on"],
  ["disable", "deactivate", "turn_off", "turn off", "switch_off", "switch off", "off"],
  ["toggle", "switch"],

  // ---- Category 12b: Show / Hide ----
  ["show", "reveal", "display", "visible", "unhide"],
  ["hide", "conceal", "invisible", "hidden"],
  ["expand", "open", "unfold", "show_more", "show more", "see_more", "see more", "read_more", "read more"],
  ["collapse", "fold", "show_less", "show less", "see_less", "see less", "minimize"],

  // ---- Calculator (original aliases, preserved) ----
  ["subtract", "minus"],
  ["divide", "division"],
];

/**
 * Build the flat bidirectional alias map from synonym groups.
 * For each group, every term maps to all OTHER terms in the group.
 * Multi-word terms (e.g., "sign in") are included as keys so the
 * multi-word lookup in parseQuery() resolves them.
 */
function buildAliases(groups: string[][]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const group of groups) {
    for (const term of group) {
      const others = group.filter((t) => t !== term);
      if (map[term]) {
        // Term appears in multiple groups — merge without duplicates
        const existing = new Set(map[term]);
        for (const o of others) {
          existing.add(o);
        }
        map[term] = [...existing];
      } else {
        map[term] = others;
      }
    }
  }
  return map;
}

// Common UI label aliases — maps user-friendly terms to what the UI actually shows.
// Auto-generated from SYNONYM_GROUPS so every relationship is bidirectional.
const ALIASES: Record<string, string[]> = buildAliases(SYNONYM_GROUPS);

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

  // If all words were fillers/hints, use the original words as tokens.
  // This handles queries like "To" (a filler word that's also a UI label).
  if (searchTokens.length === 0) {
    if (typeHints.length > 0) {
      searchTokens.push(...typeHints);
    } else {
      // All words were fillers — use them as-is since the user clearly
      // means to search for that exact text (e.g., "To", "for")
      for (const word of words) {
        if (FILLER_WORDS.has(word)) searchTokens.push(word);
      }
    }
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
        const score = 0.75 * bestRatio;
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
    .sort((a, b) => {
      // Primary: highest score wins
      if (Math.abs(b.score - a.score) > 0.01) return b.score - a.score;

      // Tiebreakers when scores are equal:
      const aEl = a.element;
      const bEl = b.element;

      // 1. Prefer Button class over generic View
      const aIsButton = aEl.className.toLowerCase().includes("button") ? 1 : 0;
      const bIsButton = bEl.className.toLowerCase().includes("button") ? 1 : 0;
      if (aIsButton !== bIsButton) return bIsButton - aIsButton;

      // 2. Prefer clickable elements
      const aClickable = aEl.clickable ? 1 : 0;
      const bClickable = bEl.clickable ? 1 : 0;
      if (aClickable !== bClickable) return bClickable - aClickable;

      // 3. Prefer larger elements (more prominent on screen)
      const aArea = (aEl.bounds.right - aEl.bounds.left) * (aEl.bounds.bottom - aEl.bounds.top);
      const bArea = (bEl.bounds.right - bEl.bounds.left) * (bEl.bounds.bottom - bEl.bounds.top);
      if (Math.abs(bArea - aArea) > 1000) return bArea - aArea;

      // 4. Prefer elements lower on screen (primary actions are at bottom)
      return bEl.bounds.centerY - aEl.bounds.centerY;
    });

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
    found: best.score >= 0.7,
    element: toAnalyzed(best),
    confidence: best.score,
    alternatives,
  };
}
