// ============================================================
// ScreenAnalyzer — Orchestrates screenshots, UI trees, and AI
// calls to provide smart visual analysis of mobile device screens.
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type {
  ScreenAnalysis,
  ElementMatch,
  VisualDiff,
  ActionPlan,
  ScreenVerification,
  AnalyzedElement,
  AIConfig,
  DeviceDriver,
  ScreenshotOptions,
  ScreenshotResult,
  UIElement,
} from "../types.js";
import { AIClient } from "./client.js";
import {
  PROMPTS,
  buildAnalyzeScreenPrompt,
  buildFindElementPrompt,
  buildSuggestActionsPrompt,
  buildVisualDiffPrompt,
  buildExtractTextPrompt,
  buildVerifyScreenPrompt,
  summarizeUIElements,
} from "./prompts.js";
import { searchElementsLocally } from "./element-search.js";
import type { FlutterDriver } from "../drivers/flutter/index.js";

// ----------------------------------------------------------
// Two-image analysis helper (used for visual diff)
// ----------------------------------------------------------

/**
 * Sends two screenshots to the AI provider in a single message.
 * This bypasses AIClient (which only supports one image) to allow
 * before/after comparison in a single request.
 *
 * Supports both Anthropic and Google Gemini providers.
 */
async function analyzeWithTwoImages(
  provider: "anthropic" | "google",
  apiKey: string,
  model: string,
  maxTokens: number,
  systemPrompt: string,
  userPrompt: string,
  beforeBase64: string,
  afterBase64: string,
  beforeMimeType: string = "image/png",
  afterMimeType: string = "image/png",
): Promise<string> {
  if (provider === "google") {
    return analyzeWithTwoImagesGemini(
      apiKey, model, systemPrompt, userPrompt, beforeBase64, afterBase64,
      beforeMimeType, afterMimeType,
    );
  }
  return analyzeWithTwoImagesAnthropic(
    apiKey, model, maxTokens, systemPrompt, userPrompt, beforeBase64, afterBase64,
    beforeMimeType, afterMimeType,
  );
}

/**
 * Anthropic implementation: two images in a single message.
 */
async function analyzeWithTwoImagesAnthropic(
  apiKey: string,
  model: string,
  maxTokens: number,
  systemPrompt: string,
  userPrompt: string,
  beforeBase64: string,
  afterBase64: string,
  beforeMimeType: string = "image/png",
  afterMimeType: string = "image/png",
): Promise<string> {
  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: beforeMimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
              data: beforeBase64,
            },
          },
          { type: "text", text: "This is the BEFORE screenshot." },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: afterMimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
              data: afterBase64,
            },
          },
          {
            type: "text",
            text: "This is the AFTER screenshot.\n\n" + userPrompt,
          },
        ],
      },
    ],
  });

  const block = response.content[0];
  if (block.type === "text") return block.text;
  throw new Error("Unexpected response type from Anthropic API.");
}

/**
 * Google Gemini implementation: two images in a single message.
 */
async function analyzeWithTwoImagesGemini(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  beforeBase64: string,
  afterBase64: string,
  beforeMimeType: string = "image/png",
  afterMimeType: string = "image/png",
): Promise<string> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const geminiModel = genAI.getGenerativeModel({ model });
  const result = await geminiModel.generateContent({
    systemInstruction: systemPrompt,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: beforeMimeType, data: beforeBase64 } },
          { text: "This is the BEFORE screenshot." },
          { inlineData: { mimeType: afterMimeType, data: afterBase64 } },
          { text: "This is the AFTER screenshot.\n\n" + userPrompt },
        ],
      },
    ],
  });
  return result.response.text();
}

/**
 * Parse a raw string as JSON, handling markdown code fences.
 */
function parseJSONResponse<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Fall through to extraction.
  }

  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim()) as T;
    } catch {
      // Fall through.
    }
  }

  const objectMatch = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[1]) as T;
    } catch {
      // Fall through.
    }
  }

  throw new Error(
    `Failed to parse AI response as JSON. Raw response:\n${raw.slice(0, 500)}`,
  );
}

// ----------------------------------------------------------
// ScreenAnalyzer
// ----------------------------------------------------------

interface CapturedContext {
  screenshot?: ScreenshotResult;
  uiElements?: UIElement[];
}

export class ScreenAnalyzer {
  private cache: {
    screenshot?: { data: ScreenshotResult; timestamp: number };
    uiElements?: { data: UIElement[]; timestamp: number };
  } = {};
  private cacheTTL: number = 5000; // 5 seconds — UI layout rarely changes after tap
  private pendingPrefetch: Promise<void> | null = null;

  /** Track when getUIElements returns empty (Flutter apps) to avoid redundant calls. */
  private lastUIElementsEmpty: boolean = false;

  /** Screenshot options used for AI analysis (compressed for performance). */
  private screenshotOptions: ScreenshotOptions;

  constructor(
    private client: AIClient,
    private driver: DeviceDriver,
    private config: {
      provider: "anthropic" | "google";
      analyzeWithScreenshot: boolean;
      analyzeWithUITree: boolean;
      apiKey: string;
      model: string;
      maxTokens: number;
    },
    screenshotOptions?: ScreenshotOptions,
    private flutterDriver?: FlutterDriver,
  ) {
    // Default: JPEG at quality 60, resize to 400px for AI — saves tokens
    this.screenshotOptions = screenshotOptions ?? {
      format: "jpeg",
      quality: 60,
      maxWidth: 400,
    };
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  /**
   * Analyze the current screen state — identifies elements, screen
   * type, visible text, and actionable suggestions.
   */
  async analyzeScreen(deviceId: string): Promise<ScreenAnalysis> {
    try {
      this.assertClientAvailable();
      const ctx = await this.captureContext(deviceId);
      const summarized = ctx.uiElements
        ? summarizeUIElements(ctx.uiElements)
        : undefined;
      const userPrompt = buildAnalyzeScreenPrompt(summarized);

      return await this.client.analyzeJSON<ScreenAnalysis>({
        systemPrompt: PROMPTS.ANALYZE_SCREEN,
        userPrompt,
        screenshot: ctx.screenshot?.base64,
        screenshotMimeType: ctx.screenshot ? `image/${ctx.screenshot.format}` : undefined,
      });
    } catch (error) {
      throw new Error(
        `analyzeScreen failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Find an element on screen by natural language description.
   *
   * Fast path: searches the UI tree locally first. If a high-confidence
   * match is found (>0.7), returns immediately without calling the AI.
   * Falls back to AI for ambiguous or complex queries.
   */
  async findElement(
    deviceId: string,
    query: string,
  ): Promise<ElementMatch> {
    const t0 = Date.now();
    try {
      // --- Flutter fast path (Tier 0): widget tree search + coordinate resolution ---
      if (this.flutterDriver?.isConnected) {
        try {
          const flutterMatch = await this.flutterDriver.findWidgetForTap(query, deviceId);
          if (flutterMatch && flutterMatch.found && flutterMatch.confidence > 0.5) {
            console.error(`[findElement] Tier 0 (flutter): "${query}" → conf=${flutterMatch.confidence.toFixed(2)} in ${Date.now() - t0}ms`);
            return flutterMatch as ElementMatch;
          }
        } catch {
          // Flutter fast path failed — fall through
        }
      }

      // --- Fast path: local UI tree search (no AI call) ---
      if (this.config.analyzeWithUITree) {
        // Try stale cache first (any cached elements, interactive or full)
        const staleElements = await this.getUIElements(deviceId, true);
        if (staleElements && staleElements.length > 0) {
          const localMatch = searchElementsLocally(staleElements, query);
          if (localMatch.found && localMatch.confidence >= 0.7) {
            console.error(`[findElement] Tier 1 (stale cache): "${query}" → conf=${localMatch.confidence.toFixed(2)} in ${Date.now() - t0}ms`);
            return localMatch;
          }
        }

        // Fresh UI tree — interactive-only first (faster, smaller payload)
        const t1 = Date.now();
        const interactiveElements = await this.getUIElements(deviceId, false, true);
        const dumpMs = Date.now() - t1;
        if (interactiveElements && interactiveElements.length > 0) {
          const localMatch = searchElementsLocally(interactiveElements, query);
          if (localMatch.found && localMatch.confidence > 0.5) {
            console.error(`[findElement] Tier 2a (fresh interactive): "${query}" → conf=${localMatch.confidence.toFixed(2)} in ${Date.now() - t0}ms (dump=${dumpMs}ms)`);
            return localMatch;
          }
        }

        // Full tree fallback if interactive-only didn't match
        const t2 = Date.now();
        const fullElements = await this.getUIElements(deviceId);
        const dump2Ms = Date.now() - t2;
        if (fullElements && fullElements.length > 0) {
          const localMatch = searchElementsLocally(fullElements, query);
          if (localMatch.found && localMatch.confidence > 0.5) {
            console.error(`[findElement] Tier 2b (fresh full): "${query}" → conf=${localMatch.confidence.toFixed(2)} in ${Date.now() - t0}ms (dump=${dump2Ms}ms)`);
            return localMatch;
          }
        }
      }

      // --- Slow path: AI-powered search ---
      this.assertClientAvailable();
      const tAI = Date.now();
      const ctx = await this.captureContext(deviceId);
      const summarized = ctx.uiElements
        ? summarizeUIElements(ctx.uiElements)
        : undefined;
      const userPrompt = buildFindElementPrompt(query, summarized);

      const result = await this.client.analyzeJSON<ElementMatch>({
        systemPrompt: PROMPTS.FIND_ELEMENT,
        userPrompt,
        screenshot: ctx.screenshot?.base64,
        screenshotMimeType: ctx.screenshot ? `image/${ctx.screenshot.format}` : undefined,
      });
      console.error(`[findElement] Tier 3 (AI vision): "${query}" → conf=${result.confidence?.toFixed(2) ?? "?"} in ${Date.now() - t0}ms (ai=${Date.now() - tAI}ms)`);
      return result;
    } catch (error) {
      console.error(`[findElement] FAILED: "${query}" in ${Date.now() - t0}ms — ${error instanceof Error ? error.message : String(error)}`);
      throw new Error(
        `findElement failed for query "${query}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Plan a sequence of actions to achieve a goal on the current screen.
   */
  async suggestActions(
    deviceId: string,
    goal: string,
  ): Promise<ActionPlan> {
    try {
      this.assertClientAvailable();
      const ctx = await this.captureContext(deviceId);
      const summarized = ctx.uiElements
        ? summarizeUIElements(ctx.uiElements)
        : undefined;

      let currentApp: string | undefined;
      try {
        const appInfo = await this.driver.getCurrentApp(deviceId);
        currentApp = appInfo.packageName;
      } catch {
        // getCurrentApp may fail on some devices — proceed without it.
      }

      const userPrompt = buildSuggestActionsPrompt(
        goal,
        currentApp,
        summarized,
      );

      return await this.client.analyzeJSON<ActionPlan>({
        systemPrompt: PROMPTS.SUGGEST_ACTIONS,
        userPrompt,
        screenshot: ctx.screenshot?.base64,
        screenshotMimeType: ctx.screenshot ? `image/${ctx.screenshot.format}` : undefined,
      });
    } catch (error) {
      throw new Error(
        `suggestActions failed for goal "${goal}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Compare the current screen with a previous screenshot and
   * describe what changed.
   */
  async compareScreenshots(
    deviceId: string,
    beforeBase64: string,
  ): Promise<VisualDiff> {
    try {
      this.assertClientAvailable();

      // Always take a fresh screenshot for the "after" state.
      const afterScreenshot = await this.driver.takeScreenshot(deviceId, this.screenshotOptions);
      const userPrompt = buildVisualDiffPrompt();

      // Before image might be PNG (from take_screenshot tool) or JPEG (from cached).
      // Detect from base64 header: JPEG starts with /9j/, PNG starts with iVBOR.
      const beforeMimeType = beforeBase64.startsWith("/9j/") ? "image/jpeg" : "image/png";
      const afterMimeType = `image/${afterScreenshot.format}`;

      const raw = await analyzeWithTwoImages(
        this.config.provider,
        this.config.apiKey,
        this.config.model,
        this.config.maxTokens,
        PROMPTS.VISUAL_DIFF,
        userPrompt,
        beforeBase64,
        afterScreenshot.base64,
        beforeMimeType,
        afterMimeType,
      );

      return parseJSONResponse<VisualDiff>(raw);
    } catch (error) {
      throw new Error(
        `compareScreenshots failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Extract all readable text from the current screen.
   */
  async extractText(deviceId: string): Promise<string[]> {
    try {
      this.assertClientAvailable();

      // Always need a screenshot for OCR — ignore UITree config.
      const screenshot = await this.driver.takeScreenshot(deviceId, this.screenshotOptions);
      const userPrompt = buildExtractTextPrompt();

      const result = await this.client.analyzeJSON<{ texts: string[] }>({
        systemPrompt: PROMPTS.EXTRACT_TEXT,
        userPrompt,
        screenshot: screenshot.base64,
        screenshotMimeType: `image/${screenshot.format}`,
      });

      return result.texts;
    } catch (error) {
      throw new Error(
        `extractText failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Verify an assertion about the current screen state.
   */
  async verifyScreen(
    deviceId: string,
    assertion: string,
  ): Promise<ScreenVerification> {
    try {
      this.assertClientAvailable();
      const ctx = await this.captureContext(deviceId);
      const summarized = ctx.uiElements
        ? summarizeUIElements(ctx.uiElements)
        : undefined;
      const userPrompt = buildVerifyScreenPrompt(assertion, summarized);

      return await this.client.analyzeJSON<ScreenVerification>({
        systemPrompt: PROMPTS.VERIFY_SCREEN,
        userPrompt,
        screenshot: ctx.screenshot?.base64,
        screenshotMimeType: ctx.screenshot ? `image/${ctx.screenshot.format}` : undefined,
      });
    } catch (error) {
      throw new Error(
        `verifyScreen failed for assertion "${assertion}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Smart tap: find an element by natural language description and
   * tap its center.
   */
  async smartTap(
    deviceId: string,
    elementDescription: string,
  ): Promise<{
    success: boolean;
    tapped: AnalyzedElement | null;
    message: string;
  }> {
    const t0 = Date.now();
    try {
      const match = await this.findElement(deviceId, elementDescription);
      const findMs = Date.now() - t0;

      if (match.found && match.element && match.confidence > 0.5) {
        const tTap = Date.now();
        await this.driver.tap(
          deviceId,
          match.element.bounds.centerX,
          match.element.bounds.centerY,
        );
        const tapMs = Date.now() - tTap;
        this.invalidateCache();
        this.startPrefetch(deviceId);
        console.error(`[smartTap] "${elementDescription}" → (${match.element.bounds.centerX},${match.element.bounds.centerY}) conf=${match.confidence.toFixed(2)} | find=${findMs}ms tap=${tapMs}ms total=${Date.now() - t0}ms`);
        return {
          success: true,
          tapped: match.element,
          message: `Tapped: ${match.element.description}`,
        };
      }

      console.error(`[smartTap] "${elementDescription}" → NOT FOUND in ${Date.now() - t0}ms`);
      return {
        success: false,
        tapped: null,
        message: `Could not find element: ${elementDescription}`,
      };
    } catch (error) {
      console.error(`[smartTap] "${elementDescription}" → FAILED in ${Date.now() - t0}ms`);
      throw new Error(
        `smartTap failed for "${elementDescription}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Smart type: find an input field by description, tap to focus it,
   * then type the provided text.
   */
  async smartType(
    deviceId: string,
    fieldDescription: string,
    text: string,
  ): Promise<{
    success: boolean;
    field: AnalyzedElement | null;
    message: string;
  }> {
    try {
      const match = await this.findElement(deviceId, fieldDescription);

      if (match.found && match.element && match.confidence > 0.5) {
        // Tap to focus the field first.
        await this.driver.tap(
          deviceId,
          match.element.bounds.centerX,
          match.element.bounds.centerY,
        );

        // Brief delay for focus to settle.
        await this.delay(300);

        // Type the text.
        await this.driver.typeText(deviceId, text);
        this.invalidateCache();
        this.startPrefetch(deviceId);

        return {
          success: true,
          field: match.element,
          message: `Typed into: ${match.element.description}`,
        };
      }

      return {
        success: false,
        field: null,
        message: `Could not find field: ${fieldDescription}`,
      };
    } catch (error) {
      throw new Error(
        `smartType failed for field "${fieldDescription}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Detect and handle system dialogs / popups (permission requests,
   * update prompts, system alerts). Can dismiss, accept, or auto-handle.
   */
  async handlePopup(
    deviceId: string,
    action: "dismiss" | "accept" | "auto" = "auto",
  ): Promise<{
    found: boolean;
    popup_type?: string;
    action_taken?: string;
    message: string;
  }> {
    // Known system dialog packages
    const SYSTEM_PACKAGES = new Set([
      "com.android.systemui",
      "com.android.permissioncontroller",
      "com.google.android.permissioncontroller",
      "com.google.android.packageinstaller",
      "android",
      "com.android.packageinstaller",
      "com.android.documentsui",
    ]);

    const ACCEPT_TEXTS = new Set([
      "allow", "while using the app", "only this time", "ok", "okay",
      "accept", "yes", "got it", "continue", "agree", "permit", "grant",
    ]);
    const DISMISS_TEXTS = new Set([
      "deny", "don't allow", "cancel", "later", "not now", "no thanks",
      "dismiss", "close", "skip", "no", "decline", "never",
    ]);

    try {
      const elements = await this.getUIElements(deviceId);
      if (!elements || elements.length === 0) {
        return { found: false, message: "No UI elements found on screen" };
      }

      // Flatten and find system dialog elements
      const flat = this.flattenUIElements(elements);
      const systemElements = flat.filter(el => SYSTEM_PACKAGES.has(el.packageName));

      if (systemElements.length === 0) {
        return { found: false, message: "No system dialog detected on screen" };
      }

      // Detect popup type
      const popupType = systemElements.some(el =>
        el.packageName.includes("permission")) ? "permission_dialog" : "system_dialog";

      // Find clickable buttons
      const buttons = systemElements.filter(el => el.clickable && (el.text || el.contentDescription));

      if (buttons.length === 0) {
        return { found: true, popup_type: popupType, message: "System dialog found but no clickable buttons detected" };
      }

      // Find the right button based on action preference
      let targetButton: typeof buttons[0] | undefined;

      for (const btn of buttons) {
        const btnText = (btn.text || btn.contentDescription).toLowerCase().trim();
        if (action === "accept" || action === "auto") {
          if (ACCEPT_TEXTS.has(btnText)) {
            targetButton = btn;
            if (action === "accept") break;
          }
        }
        if (action === "dismiss" || (action === "auto" && !targetButton)) {
          if (DISMISS_TEXTS.has(btnText)) {
            targetButton = btn;
            if (action === "dismiss") break;
          }
        }
      }

      // Fallback: if auto mode found nothing specific, tap the first clickable button
      if (!targetButton && action === "auto" && buttons.length > 0) {
        targetButton = buttons[0];
      }

      if (!targetButton) {
        return {
          found: true,
          popup_type: popupType,
          message: `System dialog found but no matching ${action} button found`,
        };
      }

      // Tap the button
      await this.driver.tap(deviceId, targetButton.bounds.centerX, targetButton.bounds.centerY);
      this.invalidateCache(true); // Full invalidate since dialog changes screen

      return {
        found: true,
        popup_type: popupType,
        action_taken: `Tapped "${targetButton.text || targetButton.contentDescription}"`,
        message: `Dismissed ${popupType} by tapping "${targetButton.text || targetButton.contentDescription}"`,
      };
    } catch (error) {
      return { found: false, message: `Error detecting popup: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * Fill multiple form fields in a single operation. For each field,
   * finds the matching input element, clears it, and types the new value.
   */
  async fillForm(
    deviceId: string,
    fields: Record<string, string>,
  ): Promise<{
    success: boolean;
    filled: { field: string; success: boolean; message: string }[];
    message: string;
  }> {
    const results: { field: string; success: boolean; message: string }[] = [];

    try {
      for (const [fieldName, value] of Object.entries(fields)) {
        try {
          // Find the field
          const match = await this.findElement(deviceId, fieldName);

          if (!match.found || !match.element || match.confidence <= 0.3) {
            results.push({ field: fieldName, success: false, message: `Field not found: ${fieldName}` });
            continue;
          }

          // Tap to focus
          await this.driver.tap(deviceId, match.element.bounds.centerX, match.element.bounds.centerY);
          await this.delay(300);

          // Select all existing text (Ctrl+A equivalent: triple tap then select all)
          await this.driver.longPress(deviceId, match.element.bounds.centerX, match.element.bounds.centerY, 500);
          await this.delay(200);
          // Try select all via key combo
          await this.driver.pressKey(deviceId, "29"); // KEYCODE_A with meta
          await this.delay(100);
          // Delete selected text
          await this.driver.pressKey(deviceId, "67"); // KEYCODE_DEL
          await this.delay(200);

          // Type new value
          await this.driver.typeText(deviceId, value);
          await this.delay(200);

          results.push({ field: fieldName, success: true, message: `Filled "${fieldName}" with "${value}"` });

          // Invalidate cache after each field since screen state changes
          this.invalidateCache();
        } catch (error) {
          results.push({
            field: fieldName,
            success: false,
            message: `Error filling ${fieldName}: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      const allSuccess = results.every(r => r.success);
      return {
        success: allSuccess,
        filled: results,
        message: allSuccess
          ? `Successfully filled ${results.length} fields`
          : `Filled ${results.filter(r => r.success).length}/${results.length} fields`,
      };
    } catch (error) {
      throw new Error(`fillForm failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ----------------------------------------------------------
  // Element-specific wait
  // ----------------------------------------------------------

  /**
   * Wait for a specific element to appear on screen.
   * More reliable and faster than generic wait_for_settle — returns
   * as soon as the target element is found instead of requiring
   * two identical consecutive UI dumps.
   */
  async waitForElement(
    deviceId: string,
    query: string,
    options: {
      /** Max time to wait in ms (default: 5000) */
      timeout?: number;
      /** Interval between polls in ms (default: 300) */
      pollInterval?: number;
    } = {},
  ): Promise<{
    found: boolean;
    element?: AnalyzedElement;
    confidence?: number;
    polls: number;
    elapsed_ms: number;
    message: string;
  }> {
    const timeout = options.timeout ?? 5000;
    const pollInterval = options.pollInterval ?? 300;
    const startTime = Date.now();
    let polls = 0;

    while (Date.now() - startTime < timeout) {
      polls++;
      // Force fresh dump (bypass cache)
      this.cache.uiElements = undefined;
      const elements = await this.getUIElements(deviceId);

      if (elements && elements.length > 0) {
        const match = searchElementsLocally(elements, query);
        if (match.found && match.element && match.confidence > 0.5) {
          const elapsed = Date.now() - startTime;
          console.error(`[waitForElement] "${query}" found in ${elapsed}ms (${polls} polls), conf=${match.confidence.toFixed(2)}`);
          return {
            found: true,
            element: match.element,
            confidence: match.confidence,
            polls,
            elapsed_ms: elapsed,
            message: `Element "${query}" found after ${polls} polls (${elapsed}ms)`,
          };
        }
      }

      // Wait before next poll
      if (Date.now() - startTime + pollInterval < timeout) {
        await this.delay(pollInterval);
      } else {
        break;
      }
    }

    const elapsed = Date.now() - startTime;
    console.error(`[waitForElement] "${query}" NOT found after ${elapsed}ms (${polls} polls)`);
    return {
      found: false,
      polls,
      elapsed_ms: elapsed,
      message: `Element "${query}" not found within ${timeout}ms (${polls} polls)`,
    };
  }

  // ----------------------------------------------------------
  // Screen settle detection
  // ----------------------------------------------------------

  /**
   * Wait for the screen to settle after a navigation or action.
   * Polls the UI tree until two consecutive dumps are structurally identical,
   * meaning the screen has stopped animating/loading.
   *
   * @param deviceId - Device ID
   * @param options - Configuration for the settle detection
   * @returns Info about whether the screen settled and how long it took
   */
  async waitForScreenSettle(
    deviceId: string,
    options: {
      /** Max time to wait in ms (default: 3000) */
      timeout?: number;
      /** Interval between polls in ms (default: 500) */
      pollInterval?: number;
      /** Minimum wait before first poll in ms (default: 300) */
      initialDelay?: number;
    } = {},
  ): Promise<{
    settled: boolean;
    polls: number;
    elapsed_ms: number;
    message: string;
  }> {
    const timeout = options.timeout ?? 3000;
    const pollInterval = options.pollInterval ?? 500;
    const initialDelay = options.initialDelay ?? 300;

    const startTime = Date.now();

    // Wait for initial animations to begin
    await this.delay(initialDelay);

    let previousHash = "";
    let polls = 0;
    const maxPolls = Math.ceil(timeout / pollInterval);

    while (polls < maxPolls) {
      polls++;

      // Force fresh UI dump (bypass cache)
      this.cache.uiElements = undefined;
      const elements = await this.getUIElements(deviceId);

      // Build a structural hash of the UI tree
      const currentHash = this.hashUITree(elements);

      if (previousHash && currentHash === previousHash) {
        // Two consecutive identical dumps = screen settled
        const elapsed = Date.now() - startTime;
        // Update cache with the stable state
        return {
          settled: true,
          polls,
          elapsed_ms: elapsed,
          message: `Screen settled after ${polls} polls (${elapsed}ms)`,
        };
      }

      previousHash = currentHash;

      // Check timeout
      if (Date.now() - startTime >= timeout) {
        break;
      }

      await this.delay(pollInterval);
    }

    const elapsed = Date.now() - startTime;
    return {
      settled: false,
      polls,
      elapsed_ms: elapsed,
      message: `Screen did not settle within ${timeout}ms (${polls} polls)`,
    };
  }

  // ----------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------

  /**
   * Fetch UI elements for the device, using the cache when valid.
   * This is a lightweight call (no screenshot) used by the local
   * element search fast path.
   */
  private async getUIElements(deviceId: string, allowStale: boolean = false, interactiveOnly: boolean = false): Promise<UIElement[] | undefined> {
    // For full tree requests, check the cache
    if (
      !interactiveOnly &&
      this.cache.uiElements &&
      this.isCacheValid(this.cache.uiElements.timestamp)
    ) {
      return this.cache.uiElements.data;
    }

    // If stale cache exists and caller allows stale data, return it
    if (allowStale && this.cache.uiElements) {
      return this.cache.uiElements.data;
    }

    try {
      const elements = await this.driver.getUIElements(deviceId, {
        interactiveOnly,
      });
      // Only cache full tree results (interactive-only is a subset)
      if (!interactiveOnly) {
        this.cache.uiElements = { data: elements, timestamp: Date.now() };
      }
      this.lastUIElementsEmpty = !elements || elements.length === 0;
      return elements;
    } catch {
      this.lastUIElementsEmpty = true;
      return undefined;
    }
  }

  /**
   * Capture screenshot and/or UI elements based on config flags.
   * Uses caching with TTL and parallel capture for performance.
   */
  private async captureContext(deviceId: string): Promise<CapturedContext> {
    // Await any pending pre-fetch so its cached data is available
    if (this.pendingPrefetch) {
      await this.pendingPrefetch;
      this.pendingPrefetch = null;
    }

    const ctx: CapturedContext = {};
    const now = Date.now();

    // Check cache for valid screenshot
    const cachedScreenshot =
      this.config.analyzeWithScreenshot &&
      this.cache.screenshot &&
      this.isCacheValid(this.cache.screenshot.timestamp)
        ? this.cache.screenshot.data
        : undefined;

    // Check cache for valid UI elements
    const cachedUIElements =
      this.config.analyzeWithUITree &&
      this.cache.uiElements &&
      this.isCacheValid(this.cache.uiElements.timestamp)
        ? this.cache.uiElements.data
        : undefined;

    if (cachedScreenshot) {
      ctx.screenshot = cachedScreenshot;
    }
    if (cachedUIElements) {
      ctx.uiElements = cachedUIElements;
    }

    // Capture missing data in parallel
    const promises: Promise<void>[] = [];

    if (this.config.analyzeWithScreenshot && !cachedScreenshot) {
      promises.push(
        this.driver.takeScreenshot(deviceId, this.screenshotOptions).then((s) => {
          ctx.screenshot = s;
          this.cache.screenshot = { data: s, timestamp: now };
        }),
      );
    }

    if (this.config.analyzeWithUITree && !cachedUIElements && !this.lastUIElementsEmpty) {
      promises.push(
        this.driver
          .getUIElements(deviceId, { interactiveOnly: false })
          .then((e) => {
            ctx.uiElements = e;
            this.cache.uiElements = { data: e, timestamp: now };
            this.lastUIElementsEmpty = !e || e.length === 0;
          }),
      );
    }

    await Promise.all(promises);

    return ctx;
  }

  /**
   * Check if a cached entry is still valid based on TTL.
   */
  private isCacheValid(timestamp: number): boolean {
    return Date.now() - timestamp < this.cacheTTL;
  }

  /**
   * Invalidate the cache — call after actions that change the screen.
   * Only clears the screenshot. UI element positions (button layout)
   * rarely change after a tap, so keep the UI tree cache to avoid
   * expensive uiautomator dump calls on every interaction.
   */
  private invalidateCache(fullInvalidate: boolean = false): void {
    this.cache.screenshot = undefined;
    if (fullInvalidate) {
      this.cache.uiElements = undefined;
      // Reset empty tracking on full invalidation (screen transitions,
      // popup dismissals, navigation) — the new screen may have elements
      // even if the previous one was empty (e.g., leaving a Flutter app).
      this.lastUIElementsEmpty = false;
    }
  }

  /**
   * Pre-fetch screenshot + UI tree in the background after an action.
   * The next findElement/captureContext call will use this pre-fetched data.
   */
  private startPrefetch(deviceId: string): void {
    // Only prefetch if env var is set
    if (!process.env.MCP_PREFETCH) return;

    // Wait 400ms for animations to settle before capturing
    this.pendingPrefetch = this.delay(400).then(async () => {
      try {
        await this.captureContext(deviceId);
      } catch {
        // Pre-fetch failure is non-fatal
      }
      this.pendingPrefetch = null;
    });
  }

  /**
   * Throw if the AI client is not available (no API key configured).
   */
  private assertClientAvailable(): void {
    if (!this.client.isAvailable()) {
      throw new Error(
        "AI client is not available. Set ANTHROPIC_API_KEY to enable AI features.",
      );
    }
  }

  /**
   * Promise-based delay helper.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Create a structural hash of the UI tree for comparison.
   * Compares element count, text content, and bounds positions.
   * Excludes status bar elements (top 72px) to ignore clock changes.
   */
  private hashUITree(elements: UIElement[] | undefined): string {
    if (!elements || elements.length === 0) return "empty";

    const flat = this.flattenUIElements(elements);
    // Exclude status bar elements (typically top 72px)
    const appElements = flat.filter((el) => el.bounds.top >= 72);

    // Build a string from semantic content only (no bounds).
    // Flutter's accessibility bridge reports slightly different bounds
    // between frames even on static screens, causing false mismatches.
    const parts = appElements.map((el) => {
      const text = el.text || "";
      const desc = el.contentDescription || "";
      return `${text}|${desc}|${el.className}|${el.clickable}`;
    });

    return parts.join(";;");
  }

  /**
   * Flatten a nested UIElement tree into a flat array.
   */
  private flattenUIElements(elements: UIElement[]): UIElement[] {
    const result: UIElement[] = [];
    const stack = [...elements];
    while (stack.length > 0) {
      const el = stack.pop()!;
      result.push(el);
      if (el.children) {
        stack.push(...el.children);
      }
    }
    return result;
  }
}
