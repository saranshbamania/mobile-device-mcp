// ============================================================
// Mobile Device MCP Server — Shared Types & Interfaces
// All modules implement against these contracts.
// ============================================================

export interface DeviceInfo {
  id: string;
  name: string;
  model: string;
  manufacturer: string;
  androidVersion: string;
  sdkVersion: string;
  status: "device" | "offline" | "unauthorized" | "unknown";
  isEmulator: boolean;
  platform?: "android" | "ios";
  osVersion?: string;
  screenSize?: { width: number; height: number };
}

export interface ScreenshotResult {
  base64: string;
  width: number;
  height: number;
  format: "png" | "jpeg";
  timestamp: number;
  sizeBytes: number;
}

export interface UIElement {
  index: number;
  text: string;
  contentDescription: string;
  className: string;
  packageName: string;
  resourceId: string;
  bounds: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    centerX: number;
    centerY: number;
  };
  clickable: boolean;
  scrollable: boolean;
  focusable: boolean;
  enabled: boolean;
  selected: boolean;
  checked: boolean;
  children?: UIElement[];
}

export interface TapResult {
  success: boolean;
  x: number;
  y: number;
}

export interface SwipeResult {
  success: boolean;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  duration: number;
}

export interface AppInfo {
  packageName: string;
  appName?: string;
  versionName?: string;
  versionCode?: number;
  isSystemApp: boolean;
}

export interface LogEntry {
  timestamp: string;
  pid: number;
  tid: number;
  level: "V" | "D" | "I" | "W" | "E" | "F";
  tag: string;
  message: string;
}

export interface LogOptions {
  filter?: string;
  level?: LogEntry["level"];
  lines?: number;
  since?: string;
  pid?: number;
}

export interface ADBResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ============================================================
// Driver interface — all platform drivers implement this
// ============================================================

export interface DeviceDriver {
  // Device management
  listDevices(): Promise<DeviceInfo[]>;
  getDeviceInfo(deviceId: string): Promise<DeviceInfo>;
  getScreenSize(deviceId: string): Promise<{ width: number; height: number }>;

  // Screenshots & UI
  takeScreenshot(deviceId: string, options?: ScreenshotOptions): Promise<ScreenshotResult>;
  getUIElements(deviceId: string, options?: UIElementOptions): Promise<UIElement[]>;

  // Interaction
  tap(deviceId: string, x: number, y: number): Promise<TapResult>;
  doubleTap(deviceId: string, x: number, y: number): Promise<TapResult>;
  longPress(deviceId: string, x: number, y: number, duration?: number): Promise<TapResult>;
  swipe(
    deviceId: string,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    duration?: number,
  ): Promise<SwipeResult>;
  typeText(deviceId: string, text: string): Promise<{ success: boolean }>;
  pressKey(deviceId: string, keycode: string): Promise<{ success: boolean }>;

  // App management
  listApps(deviceId: string, includeSystem?: boolean): Promise<AppInfo[]>;
  getCurrentApp(deviceId: string): Promise<{ packageName: string; activityName: string }>;
  launchApp(deviceId: string, packageName: string): Promise<{ success: boolean }>;
  stopApp(deviceId: string, packageName: string): Promise<{ success: boolean }>;
  installApp(deviceId: string, apkPath: string): Promise<{ success: boolean }>;
  uninstallApp(deviceId: string, packageName: string): Promise<{ success: boolean }>;

  // Logs
  getLogs(deviceId: string, options?: LogOptions): Promise<LogEntry[]>;

  // Raw shell
  shell(deviceId: string, command: string): Promise<ADBResult>;
}

export interface ScreenshotOptions {
  format?: "png" | "jpeg";
  quality?: number; // 1-100, for JPEG
  maxWidth?: number; // downscale if wider
}

export interface UIElementOptions {
  interactiveOnly?: boolean; // only clickable/focusable elements
  maxDepth?: number;
}

// ============================================================
// AI Visual Analysis Types (Phase 2)
// ============================================================

export interface ScreenAnalysis {
  description: string;
  appName: string;
  screenType: string; // "login", "settings", "list", "detail", "dialog", "home", etc.
  elements: AnalyzedElement[];
  visibleText: string[];
  suggestions: string[];
}

export interface AnalyzedElement {
  description: string; // "Blue login button at bottom center"
  type: string; // "button", "text_field", "checkbox", "switch", "icon", "image", "link", "tab"
  text: string; // visible text on the element
  bounds: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    centerX: number;
    centerY: number;
  };
  suggestedAction: string; // "tap", "type", "scroll", "long_press"
  confidence: number; // 0.0-1.0
}

export interface VisualDiff {
  hasChanges: boolean;
  summary: string;
  changes: DiffChange[];
}

export interface DiffChange {
  description: string;
  region: string; // "top-left", "top-center", "top-right", "center-left", "center", "center-right", "bottom-left", "bottom-center", "bottom-right"
  type: "added" | "removed" | "changed";
}

export interface ElementMatch {
  found: boolean;
  element?: AnalyzedElement;
  confidence: number;
  alternatives?: AnalyzedElement[];
}

export interface ActionPlan {
  goal: string;
  steps: PlannedAction[];
}

export interface PlannedAction {
  step: number;
  action: "tap" | "type" | "swipe" | "press_key" | "wait" | "long_press";
  target: string;
  coordinates?: { x: number; y: number };
  text?: string;
  key?: string;
  swipe?: { startX: number; startY: number; endX: number; endY: number };
  description: string;
}

export interface ScreenVerification {
  verified: boolean;
  confidence: number;
  details: string;
  evidence: string[];
}

// ============================================================
// AI Configuration
// ============================================================

export interface AIConfig {
  provider: "anthropic" | "google";
  apiKey: string;
  model: string;
  maxTokens: number;
  analyzeWithScreenshot: boolean;
  analyzeWithUITree: boolean;
}

export const DEFAULT_AI_CONFIG: AIConfig = {
  provider: "anthropic",
  apiKey: "",
  model: "claude-sonnet-4-20250514",
  maxTokens: 4096,
  analyzeWithScreenshot: true,
  analyzeWithUITree: true,
};

// ============================================================
// Server configuration
// ============================================================

export interface ServerConfig {
  adbPath: string;
  defaultDevice?: string;
  screenshotFormat: "png" | "jpeg";
  screenshotQuality: number;
  screenshotMaxWidth: number;
  ai?: AIConfig;
}

export const DEFAULT_CONFIG: ServerConfig = {
  adbPath: "adb",
  screenshotFormat: "jpeg",
  screenshotQuality: 80,
  screenshotMaxWidth: 720,
};
