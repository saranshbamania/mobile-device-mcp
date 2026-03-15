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
): Promise<string> {
  if (provider === "google") {
    return analyzeWithTwoImagesGemini(
      apiKey, model, systemPrompt, userPrompt, beforeBase64, afterBase64,
    );
  }
  return analyzeWithTwoImagesAnthropic(
    apiKey, model, maxTokens, systemPrompt, userPrompt, beforeBase64, afterBase64,
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
              media_type: "image/png",
              data: beforeBase64,
            },
          },
          { type: "text", text: "This is the BEFORE screenshot." },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
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
): Promise<string> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const geminiModel = genAI.getGenerativeModel({ model });
  const result = await geminiModel.generateContent({
    systemInstruction: systemPrompt,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/png", data: beforeBase64 } },
          { text: "This is the BEFORE screenshot." },
          { inlineData: { mimeType: "image/png", data: afterBase64 } },
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
  ) {}

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
      });
    } catch (error) {
      throw new Error(
        `analyzeScreen failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Find an element on screen by natural language description.
   */
  async findElement(
    deviceId: string,
    query: string,
  ): Promise<ElementMatch> {
    try {
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
      const afterScreenshot = await this.driver.takeScreenshot(deviceId);
      const userPrompt = buildVisualDiffPrompt();

      const raw = await analyzeWithTwoImages(
        this.config.provider,
        this.config.apiKey,
        this.config.model,
        this.config.maxTokens,
        PROMPTS.VISUAL_DIFF,
        userPrompt,
        beforeBase64,
        afterScreenshot.base64,
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
      const screenshot = await this.driver.takeScreenshot(deviceId);
      const userPrompt = buildExtractTextPrompt();

      const result = await this.client.analyzeJSON<{ texts: string[] }>({
        systemPrompt: PROMPTS.EXTRACT_TEXT,
        userPrompt,
        screenshot: screenshot.base64,
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
   * Capture screenshot and/or UI elements based on config flags.
   */
  private async captureContext(deviceId: string): Promise<CapturedContext> {
    const ctx: CapturedContext = {};

    if (this.config.analyzeWithScreenshot) {
      ctx.screenshot = await this.driver.takeScreenshot(deviceId);
    }

    if (this.config.analyzeWithUITree) {
      ctx.uiElements = await this.driver.getUIElements(deviceId, {
        interactiveOnly: false,
      });
    }

    return ctx;
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
