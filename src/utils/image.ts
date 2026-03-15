// ============================================================
// Image processing utilities
//
// Provides PNG parsing, JPEG compression, and resize capabilities
// using pure-JS libraries (no native dependencies) for zero-config
// npm distribution.
// ============================================================

import { PNG } from "pngjs";
import * as jpeg from "jpeg-js";
import type { ScreenshotOptions } from "../types.js";

// ------------------------------------------------------------------
// PNG parsing (lightweight — no full decode needed)
// ------------------------------------------------------------------

/**
 * Parse width and height from a PNG buffer by reading the IHDR chunk.
 *
 * PNG layout:
 *   Bytes 0-7:   8-byte PNG signature
 *   Bytes 8-11:  IHDR chunk data length (always 13)
 *   Bytes 12-15: chunk type "IHDR"
 *   Bytes 16-19: width  (big-endian uint32)
 *   Bytes 20-23: height (big-endian uint32)
 *
 * Throws if the buffer is too small or doesn't look like a valid PNG.
 */
export function parsePngDimensions(
  buffer: Buffer,
): { width: number; height: number } {
  // Minimum size: 8 (sig) + 4 (length) + 4 (type) + 8 (w+h) = 24
  if (buffer.length < 24) {
    throw new Error(
      `Buffer too small to be a valid PNG (${buffer.length} bytes, need at least 24)`,
    );
  }

  // Verify PNG signature (first 8 bytes)
  const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Buffer does not contain a valid PNG signature");
  }

  // Verify IHDR chunk type at bytes 12-15
  const chunkType = buffer.subarray(12, 16).toString("ascii");
  if (chunkType !== "IHDR") {
    throw new Error(
      `Expected IHDR chunk but found "${chunkType}"`,
    );
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);

  if (width === 0 || height === 0) {
    throw new Error(
      `Invalid PNG dimensions: ${width}x${height}`,
    );
  }

  return { width, height };
}

/**
 * Convert a Buffer to a base64-encoded string.
 */
export function bufferToBase64(buffer: Buffer): string {
  return buffer.toString("base64");
}

/**
 * Calculate the approximate byte size of data represented by a base64 string.
 *
 * Base64 encodes 3 bytes into 4 characters. The formula accounts for
 * padding characters ('=') which don't represent data.
 */
export function getImageSizeBytes(base64: string): number {
  const len = base64.length;
  // Count trailing '=' padding characters
  let padding = 0;
  if (len > 0 && base64[len - 1] === "=") padding++;
  if (len > 1 && base64[len - 2] === "=") padding++;

  return Math.floor((len * 3) / 4) - padding;
}

// ------------------------------------------------------------------
// Screenshot compression pipeline
// ------------------------------------------------------------------

export interface ProcessedScreenshot {
  buffer: Buffer;
  base64: string;
  width: number;
  height: number;
  format: "png" | "jpeg";
  sizeBytes: number;
}

/**
 * Process a raw PNG screenshot buffer: optionally resize and convert to JPEG.
 *
 * Pipeline: PNG buffer → decode to RGBA → resize (if maxWidth set) → encode
 *
 * When format is "png" and no resize is needed, returns the original buffer
 * untouched (zero-cost passthrough).
 */
export function processScreenshot(
  pngBuffer: Buffer,
  options?: ScreenshotOptions,
): ProcessedScreenshot {
  const format = options?.format ?? "png";
  const quality = options?.quality ?? 80;
  const maxWidth = options?.maxWidth;

  const { width: origWidth, height: origHeight } = parsePngDimensions(pngBuffer);

  // Fast path: no processing needed
  const needsResize = maxWidth !== undefined && maxWidth > 0 && origWidth > maxWidth;
  if (format === "png" && !needsResize) {
    return {
      buffer: pngBuffer,
      base64: pngBuffer.toString("base64"),
      width: origWidth,
      height: origHeight,
      format: "png",
      sizeBytes: pngBuffer.length,
    };
  }

  // Decode PNG to raw RGBA pixels
  const decoded = PNG.sync.read(pngBuffer);
  let { width, height, data } = decoded;

  // Resize if needed (bilinear interpolation)
  if (needsResize) {
    const scale = maxWidth! / width;
    const newWidth = maxWidth!;
    const newHeight = Math.round(height * scale);
    data = resizeBilinear(data, width, height, newWidth, newHeight);
    width = newWidth;
    height = newHeight;
  }

  // Encode to target format
  let outputBuffer: Buffer;
  if (format === "jpeg") {
    const rawImageData = {
      data,
      width,
      height,
    };
    const encoded = jpeg.encode(rawImageData, quality);
    outputBuffer = encoded.data;
  } else {
    // Re-encode as PNG (only reached if resize happened)
    const png = new PNG({ width, height });
    png.data = data;
    outputBuffer = PNG.sync.write(png);
  }

  return {
    buffer: outputBuffer,
    base64: outputBuffer.toString("base64"),
    width,
    height,
    format,
    sizeBytes: outputBuffer.length,
  };
}

// ------------------------------------------------------------------
// Bilinear interpolation resize
// ------------------------------------------------------------------

/**
 * Resize RGBA pixel data using bilinear interpolation.
 * Produces smooth results without jagged edges — important for
 * AI vision models to read text accurately.
 */
function resizeBilinear(
  src: Buffer,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Buffer {
  const dst = Buffer.alloc(dstW * dstH * 4);
  const xRatio = (srcW - 1) / (dstW - 1);
  const yRatio = (srcH - 1) / (dstH - 1);

  for (let y = 0; y < dstH; y++) {
    const srcY = y * yRatio;
    const yFloor = Math.floor(srcY);
    const yCeil = Math.min(yFloor + 1, srcH - 1);
    const yFrac = srcY - yFloor;

    for (let x = 0; x < dstW; x++) {
      const srcX = x * xRatio;
      const xFloor = Math.floor(srcX);
      const xCeil = Math.min(xFloor + 1, srcW - 1);
      const xFrac = srcX - xFloor;

      // Four neighboring pixels
      const tlIdx = (yFloor * srcW + xFloor) * 4;
      const trIdx = (yFloor * srcW + xCeil) * 4;
      const blIdx = (yCeil * srcW + xFloor) * 4;
      const brIdx = (yCeil * srcW + xCeil) * 4;

      const dstIdx = (y * dstW + x) * 4;

      // Interpolate each channel (R, G, B, A)
      for (let c = 0; c < 4; c++) {
        const top = src[tlIdx + c] * (1 - xFrac) + src[trIdx + c] * xFrac;
        const bottom = src[blIdx + c] * (1 - xFrac) + src[brIdx + c] * xFrac;
        dst[dstIdx + c] = Math.round(top * (1 - yFrac) + bottom * yFrac);
      }
    }
  }

  return dst;
}
