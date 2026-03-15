// ============================================================
// Image processing utilities
// ============================================================

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
