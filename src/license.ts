// ============================================================
// License key validation and tier management
// ============================================================

const PREFIX = "[mobile-device-mcp]";

export type LicenseTier = "free" | "pro";

export interface LicenseInfo {
  tier: LicenseTier;
  valid: boolean;
}

/** Tools included in the free tier */
export const FREE_TOOLS = new Set([
  // Device info (3)
  "list_devices",
  "get_device_info",
  "get_screen_size",
  // Screenshots & UI tree (2)
  "take_screenshot",
  "get_ui_elements",
  // Basic interaction (6)
  "tap",
  "double_tap",
  "long_press",
  "swipe",
  "type_text",
  "press_key",
  // Basic app management (2)
  "list_apps",
  "get_current_app",
  // Logs (1)
  "get_logs",
]);

/** Upgrade message shown when a free user calls a pro tool */
export const PRO_UPGRADE_MESSAGE = {
  content: [
    {
      type: "text" as const,
      text: [
        "This is a Pro feature. Upgrade to Pro to unlock all 49 tools.",
        "",
        "Pro includes: AI vision, Flutter inspection, iOS simulator, video recording, test generation, and more.",
        "",
        "Get Pro: https://rzp.io/rzp/fCvY9mNK",
        "",
        "After payment, you'll receive a license key. Add it to your .mcp.json:",
        '  "MOBILE_MCP_LICENSE_KEY": "your-key-here"',
      ].join("\n"),
    },
  ],
  isError: true,
};

/**
 * Validate the license key.
 *
 * Current implementation: presence check.
 * Future: integrate with Keygen.sh or xPay for real validation.
 */
export function validateLicense(): LicenseInfo {
  const key = process.env.MOBILE_MCP_LICENSE_KEY;

  if (!key || key.trim() === "") {
    return { tier: "free", valid: true };
  }

  // TODO: Replace with Keygen.sh API validation when payment is set up
  // For now, any non-empty key is treated as valid pro license
  return { tier: "pro", valid: true };
}

/** Log the license tier on startup */
export function logLicenseStatus(info: LicenseInfo): void {
  if (info.tier === "pro") {
    process.stderr.write(`${PREFIX} License: Pro (all 49 tools enabled)\n`);
  } else {
    process.stderr.write(`${PREFIX} License: Free (14 tools — upgrade to Pro for all 49)\n`);
  }
}
