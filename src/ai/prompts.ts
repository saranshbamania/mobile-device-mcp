// ============================================================
// AI Visual Analysis — System Prompts & User Prompt Builders
// ============================================================

import type { UIElement } from '../types.js';

// ----------------------------------------------------------
// Compact UI element summary (token-efficient)
// ----------------------------------------------------------

export interface UIElementSummary {
  idx: number;
  text: string;
  desc: string;
  type: string;   // simplified class name
  id: string;     // resource ID
  cx: number;     // center X
  cy: number;     // center Y
  actions: string[]; // ["tap", "scroll", etc]
}

// ----------------------------------------------------------
// System Prompts
// ----------------------------------------------------------

const ANALYZE_SCREEN = `You are a mobile app screenshot analyzer. Return ONLY valid JSON, no markdown or explanation.

Coordinate system: origin (0,0) at top-left, x increases right, y increases down.

JSON schema:
{"description":"string","appName":"string","screenType":"string","elements":[{"description":"string","type":"string","text":"string","bounds":{"left":0,"top":0,"right":0,"bottom":0,"centerX":0,"centerY":0},"suggestedAction":"string","confidence":0.0}],"visibleText":["string"],"suggestions":["string"]}

screenType: one of "login","settings","list","detail","dialog","home","search","menu","form","media","navigation","error","loading","onboarding","other".
type: one of "button","text_field","checkbox","switch","icon","image","link","tab","text","toolbar","menu_item","list_item","card","other".
suggestedAction: one of "tap","type","scroll","long_press","swipe","none".
confidence: 0.0 to 1.0.

Identify all interactive elements with precise bounding boxes. Include all visible text strings.`;

const FIND_ELEMENT = `You are a UI element locator for mobile app screenshots. Return ONLY valid JSON, no markdown or explanation.

Coordinate system: origin (0,0) at top-left, x increases right, y increases down.

JSON schema:
{"found":true,"element":{"description":"string","type":"string","text":"string","bounds":{"left":0,"top":0,"right":0,"bottom":0,"centerX":0,"centerY":0},"suggestedAction":"string","confidence":0.0},"confidence":0.0,"alternatives":[]}

If no match, set found=false, element=null, confidence=0, and list any partial matches in alternatives.
confidence: 0.0 to 1.0. Return the single best match as element, up to 3 runners-up in alternatives.`;

const SUGGEST_ACTIONS = `You are a mobile app automation planner. Given the current screen and a goal, plan a sequence of actions. Return ONLY valid JSON, no markdown or explanation.

Coordinate system: origin (0,0) at top-left, x increases right, y increases down.

JSON schema:
{"goal":"string","steps":[{"step":1,"action":"tap","target":"string","coordinates":{"x":0,"y":0},"text":null,"key":null,"swipe":null,"description":"string"}]}

action: one of "tap","type","swipe","press_key","wait","long_press".
For "type": set text to the string to enter.
For "press_key": set key (e.g. "KEYCODE_BACK","KEYCODE_HOME","KEYCODE_ENTER").
For "swipe": set swipe to {"startX":0,"startY":0,"endX":0,"endY":0}.
For "wait": coordinates may be null.
Provide precise coordinates for tap/long_press targets. Keep steps minimal.`;

const VISUAL_DIFF = `You are a visual diff analyzer for mobile app screenshots. You will receive two images: the first is "before", the second is "after". Return ONLY valid JSON, no markdown or explanation.

JSON schema:
{"hasChanges":true,"summary":"string","changes":[{"description":"string","region":"string","type":"added|removed|changed"}]}

region: one of "top-left","top-center","top-right","center-left","center","center-right","bottom-left","bottom-center","bottom-right".
type: one of "added","removed","changed".
If screens are identical, set hasChanges=false, summary="No changes detected", changes=[].`;

const EXTRACT_TEXT = `You are an OCR engine for mobile app screenshots. Extract every readable text element. Return ONLY valid JSON, no markdown or explanation.

JSON schema:
{"texts":["string"]}

Read in order: top to bottom, left to right. Include all labels, buttons, headers, body text, hints, placeholders, status bar text, and navigation items. Preserve original casing and punctuation.`;

const VERIFY_SCREEN = `You are a screen state verifier for mobile app testing. Check whether a given assertion holds true for the screenshot. Return ONLY valid JSON, no markdown or explanation.

JSON schema:
{"verified":true,"confidence":0.0,"details":"string","evidence":["string"]}

verified: true if assertion holds, false otherwise.
confidence: 0.0 to 1.0.
details: brief explanation of your judgment.
evidence: list of specific visual observations supporting your conclusion.`;

export const PROMPTS = {
  ANALYZE_SCREEN,
  FIND_ELEMENT,
  SUGGEST_ACTIONS,
  VISUAL_DIFF,
  EXTRACT_TEXT,
  VERIFY_SCREEN,
} as const;

// ----------------------------------------------------------
// Helper: summarize UIElement[] into compact form
// ----------------------------------------------------------

export function summarizeUIElements(elements: UIElement[]): UIElementSummary[] {
  const results: UIElementSummary[] = [];
  flattenAndSummarize(elements, results);
  return results;
}

function flattenAndSummarize(elements: UIElement[], out: UIElementSummary[]): void {
  for (const el of elements) {
    const actions: string[] = [];
    if (el.clickable) actions.push('tap');
    if (el.scrollable) actions.push('scroll');
    if (el.focusable) actions.push('focus');

    // Only include elements that have at least some useful info
    const hasText = el.text.length > 0;
    const hasDesc = el.contentDescription.length > 0;
    const hasId = el.resourceId.length > 0;
    const hasActions = actions.length > 0;

    if (hasText || hasDesc || hasId || hasActions) {
      out.push({
        idx: el.index,
        text: el.text,
        desc: el.contentDescription,
        type: simplifyClassName(el.className),
        id: stripPackageFromId(el.resourceId),
        cx: el.bounds.centerX,
        cy: el.bounds.centerY,
        actions,
      });
    }

    if (el.children) {
      flattenAndSummarize(el.children, out);
    }
  }
}

function simplifyClassName(className: string): string {
  // "android.widget.Button" → "Button"
  // "com.example.custom.MyView" → "MyView"
  const dot = className.lastIndexOf('.');
  return dot >= 0 ? className.slice(dot + 1) : className;
}

function stripPackageFromId(resourceId: string): string {
  // "com.example.app:id/login_btn" → "login_btn"
  const slash = resourceId.lastIndexOf('/');
  return slash >= 0 ? resourceId.slice(slash + 1) : resourceId;
}

// ----------------------------------------------------------
// Format UI tree summary as compact string for prompt injection
// ----------------------------------------------------------

function formatUITreeContext(uiElements?: UIElementSummary[]): string {
  if (!uiElements || uiElements.length === 0) return '';
  return `\n\nUI element tree:\n${JSON.stringify(uiElements)}`;
}

// ----------------------------------------------------------
// User Prompt Builders
// ----------------------------------------------------------

export function buildAnalyzeScreenPrompt(uiElements?: UIElementSummary[]): string {
  return `Analyze this mobile app screenshot.${formatUITreeContext(uiElements)}`;
}

export function buildFindElementPrompt(query: string, uiElements?: UIElementSummary[]): string {
  return `Find the element matching: '${query}'${formatUITreeContext(uiElements)}`;
}

export function buildSuggestActionsPrompt(
  goal: string,
  currentApp?: string,
  uiElements?: UIElementSummary[],
): string {
  const appCtx = currentApp ? ` Current app: ${currentApp}.` : '';
  return `I want to: ${goal}.${appCtx}${formatUITreeContext(uiElements)}`;
}

export function buildVisualDiffPrompt(): string {
  return 'Compare these two mobile app screenshots and describe what changed.';
}

export function buildExtractTextPrompt(): string {
  return 'Extract all visible text from this mobile app screenshot.';
}

export function buildVerifyScreenPrompt(
  assertion: string,
  uiElements?: UIElementSummary[],
): string {
  return `Verify: ${assertion}${formatUITreeContext(uiElements)}`;
}
