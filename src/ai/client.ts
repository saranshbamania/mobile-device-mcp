// ============================================================
// AIClient — Multi-provider SDK wrapper for visual analysis
//
// Supports both Anthropic Claude and Google Gemini, providing
// a unified interface so callers never deal with provider
// specifics.
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages/messages.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { GenerativeModel } from "@google/generative-ai";
import type { AIConfig } from "../types.js";

/**
 * Options accepted by {@link AIClient.analyze} and {@link AIClient.analyzeJSON}.
 */
export interface AnalyzeOptions {
  systemPrompt: string;
  userPrompt: string;
  /** Base-64 encoded screenshot (PNG by default). */
  screenshot?: string;
  /** MIME type for the screenshot. Defaults to `"image/png"`. */
  screenshotMimeType?: string;
  /** Override the default max tokens for this request. */
  maxTokens?: number;
}

/** Delay (ms) before a manual retry for retryable errors. */
const RETRY_DELAY_MS = 2_000;

/** Per-request timeout in milliseconds. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Wraps both the Anthropic and Google Generative AI SDKs for all
 * AI visual-analysis features.
 *
 * Create one instance and reuse it — the underlying HTTP client is
 * allocated once in the constructor.
 */
export class AIClient {
  private readonly anthropicClient?: Anthropic;
  private readonly geminiModel?: GenerativeModel;
  private readonly config: AIConfig;

  constructor(config: AIConfig) {
    this.config = config;

    if (config.provider === "google") {
      const genAI = new GoogleGenerativeAI(config.apiKey);
      this.geminiModel = genAI.getGenerativeModel({ model: config.model });
    } else {
      // Default: Anthropic
      this.anthropicClient = new Anthropic({
        apiKey: config.apiKey || undefined,
        maxRetries: 1,
        timeout: REQUEST_TIMEOUT_MS,
      });
    }
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Returns `true` when a non-empty API key has been configured,
   * meaning AI features can be used.
   */
  isAvailable(): boolean {
    return typeof this.config.apiKey === "string" && this.config.apiKey.length > 0;
  }

  /**
   * Send a prompt (with an optional screenshot) to the configured
   * AI provider and return the plain-text response.
   */
  async analyze(options: AnalyzeOptions): Promise<string> {
    this.assertAvailable();

    if (this.config.provider === "google") {
      return this.analyzeWithGemini(options);
    }
    return this.analyzeWithAnthropic(options);
  }

  /**
   * Convenience wrapper: call {@link analyze}, then parse the response
   * as JSON.  Handles responses wrapped in markdown code fences.
   */
  async analyzeJSON<T>(options: AnalyzeOptions): Promise<T> {
    const raw = await this.analyze(options);
    return this.parseJSON<T>(raw);
  }

  // ------------------------------------------------------------------
  // Anthropic implementation
  // ------------------------------------------------------------------

  private async analyzeWithAnthropic(options: AnalyzeOptions): Promise<string> {
    const {
      systemPrompt,
      userPrompt,
      screenshot,
      screenshotMimeType = "image/png",
      maxTokens = this.config.maxTokens,
    } = options;

    const content = this.buildAnthropicContent(userPrompt, screenshot, screenshotMimeType);

    const request: MessageCreateParamsNonStreaming = {
      model: this.config.model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user" as const, content }],
    };

    const response = await this.createWithRetryAnthropic(request);
    return this.extractAnthropicText(response);
  }

  /**
   * Build the `content` array for the Anthropic user message.
   */
  private buildAnthropicContent(
    text: string,
    screenshot: string | undefined,
    mimeType: string,
  ): Anthropic.MessageCreateParams["messages"][0]["content"] {
    if (!screenshot) {
      return [{ type: "text" as const, text }];
    }

    return [
      {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
          data: screenshot,
        },
      },
      { type: "text" as const, text },
    ];
  }

  /**
   * Call `messages.create` with a single manual retry for 429 / 529.
   */
  private async createWithRetryAnthropic(
    request: MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Message> {
    const client = this.anthropicClient!;
    try {
      return await client.messages.create(request);
    } catch (error: unknown) {
      if (this.isRetryableAnthropic(error)) {
        await this.delay(RETRY_DELAY_MS);
        return await client.messages.create(request);
      }
      throw this.wrapError(error);
    }
  }

  /**
   * Determine whether an Anthropic error is a retryable 429 or 529.
   */
  private isRetryableAnthropic(error: unknown): boolean {
    if (error instanceof Anthropic.APIError) {
      const status = error.status;
      return status === 429 || status === 529;
    }
    return false;
  }

  /**
   * Extract the text content from the first Anthropic content block.
   */
  private extractAnthropicText(response: Anthropic.Message): string {
    if (!response.content || response.content.length === 0) {
      throw new Error("AI returned an empty response with no content blocks.");
    }

    const block = response.content[0];
    if (block.type === "text") {
      return block.text;
    }

    throw new Error(
      `Expected a text content block but received type "${block.type}".`,
    );
  }

  // ------------------------------------------------------------------
  // Google Gemini implementation
  // ------------------------------------------------------------------

  private async analyzeWithGemini(options: AnalyzeOptions): Promise<string> {
    const {
      systemPrompt,
      userPrompt,
      screenshot,
      screenshotMimeType = "image/png",
    } = options;

    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

    if (screenshot) {
      parts.push({
        inlineData: { mimeType: screenshotMimeType, data: screenshot },
      });
    }

    parts.push({ text: userPrompt });

    return this.createWithRetryGemini(systemPrompt, parts);
  }

  /**
   * Call Gemini generateContent with a single manual retry for 429 / 503.
   */
  private async createWithRetryGemini(
    systemPrompt: string,
    parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>,
  ): Promise<string> {
    const model = this.geminiModel!;
    const request = {
      systemInstruction: systemPrompt,
      contents: [{ role: "user" as const, parts }],
    };

    try {
      const result = await model.generateContent(request);
      return result.response.text();
    } catch (error: unknown) {
      if (this.isRetryableGemini(error)) {
        await this.delay(RETRY_DELAY_MS);
        const result = await model.generateContent(request);
        return result.response.text();
      }
      throw this.wrapError(error);
    }
  }

  /**
   * Determine whether a Google API error is retryable (429 / 503).
   */
  private isRetryableGemini(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message || "";
      // Google SDK errors include status codes in the message
      return message.includes("429") || message.includes("503");
    }
    return false;
  }

  // ------------------------------------------------------------------
  // Shared internals
  // ------------------------------------------------------------------

  /**
   * Throw immediately when the API key is absent so callers get a
   * clear message instead of an opaque 401.
   */
  private assertAvailable(): void {
    if (!this.isAvailable()) {
      throw new Error(
        "AI API key not set. AI features require a valid API key.",
      );
    }
  }

  /**
   * Parse a string as JSON, stripping markdown code fences if present.
   */
  private parseJSON<T>(raw: string): T {
    // First, try a direct parse — covers well-behaved responses.
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Fall through to extraction attempts.
    }

    // Try extracting from fenced code blocks: ```json ... ``` or ``` ... ```
    const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
      try {
        return JSON.parse(fenceMatch[1].trim()) as T;
      } catch {
        // Fall through.
      }
    }

    // Last resort: look for the first { ... } or [ ... ] block.
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

  /**
   * Wrap unknown errors into Error instances with descriptive messages.
   */
  private wrapError(error: unknown): Error {
    if (error instanceof Anthropic.APIError) {
      return new Error(
        `Anthropic API error (${error.status}): ${error.message}`,
      );
    }
    if (error instanceof Error) {
      return error;
    }
    return new Error(`Unexpected AI client error: ${String(error)}`);
  }

  /**
   * Promise-based delay helper.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
