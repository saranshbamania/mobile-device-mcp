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
  private cacheTTL: number = 3000; // 3 seconds

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
  ) {
    // Default: JPEG at quality 80, resize to 720px for AI — saves tokens
    this.screenshotOptions = screenshotOptions ?? {
      format: "jpeg",
      quality: 80,
      maxWidth: 720,
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
    try {
      // --- Fast path: local UI tree search (no AI call) ---
      if (this.config.analyzeWithUITree) {
        const uiElements = await this.getUIElements(deviceId);
        if (uiElements && uiElements.length > 0) {
          const localMatch = searchElementsLocally(uiElements, query);
          if (localMatch.found && localMatch.confidence > 0.5) {
            return localMatch;
          }
        }
      }

      // --- Slow path: AI-powered search ---
      this.assertClientAvailable();
      const ctx = await this.captureContext(deviceId);
      const summarized = ctx.uiElements
        ? summarizeUIElements(ctx.uiElements)
        : undefined;
      const userPrompt = buildFindElementPrompt(query, summarized);

      return await this.client.analyzeJSON<ElementMatch>({
        systemPrompt: PROMPTS.FIND_ELEMENT,
        userPrompt,
        screenshot: ctx.screenshot?.base64,
        screenshotMimeType: ctx.screenshot ? `image/${ctx.screenshot.format}` : undefined,
      });
    } catch (error) {
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
    try {
      const match = await this.findElement(deviceId, elementDescription);

      if (match.found && match.element && match.confidence > 0.5) {
        await this.driver.tap(
          deviceId,
          match.element.bounds.centerX,
          match.element.bounds.centerY,
        );
        this.invalidateCache();
        return {
          success: true,
          tapped: match.element,
          message: `Tapped: ${match.element.description}`,
        };
      }

      return {
        success: false,
        tapped: null,
        message: `Could not find element: ${elementDescription}`,
      };
    } catch (error) {
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

  // ----------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------

  /**
   * Fetch UI elements for the device, using the cache when valid.
   * This is a lightweight call (no screenshot) used by the local
   * element search fast path.
   */
  private async getUIElements(deviceId: string): Promise<UIElement[] | undefined> {
    if (
      this.cache.uiElements &&
      this.isCacheValid(this.cache.uiElements.timestamp)
    ) {
      return this.cache.uiElements.data;
    }

    try {
      const elements = await this.driver.getUIElements(deviceId, {
        interactiveOnly: false,
      });
      this.cache.uiElements = { data: elements, timestamp: Date.now() };
      return elements;
    } catch {
      return undefined;
    }
  }

  /**
   * Capture screenshot and/or UI elements based on config flags.
   * Uses caching with TTL and parallel capture for performance.
   */
  private async captureContext(deviceId: string): Promise<CapturedContext> {
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

    if (this.config.analyzeWithUITree && !cachedUIElements) {
      promises.push(
        this.driver
          .getUIElements(deviceId, { interactiveOnly: false })
          .then((e) => {
            ctx.uiElements = e;
            this.cache.uiElements = { data: e, timestamp: now };
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
  private invalidateCache(): void {
    this.cache.screenshot = undefined;
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
}
