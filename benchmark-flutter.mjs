/**
 * Flutter Performance Benchmark — Before vs After Optimization
 *
 * Tests smart_tap/find_element performance on a Flutter app (MetroPing)
 * and compares with Chrome (native Android) to quantify the gap.
 *
 * Usage:
 *   node benchmark-flutter.mjs
 *
 * Requirements:
 *   - Pixel 8 connected via ADB
 *   - MetroPing app installed (com.metroping.metroping)
 *   - GOOGLE_API_KEY or GEMINI_API_KEY set (for AI fallback tests)
 */

import { AndroidDriver } from './dist/drivers/android/index.js';
import { FlutterDriver } from './dist/drivers/flutter/index.js';
import { ScreenAnalyzer } from './dist/ai/analyzer.js';
import { AIClient } from './dist/ai/client.js';

const DEVICE_ID = '192.168.1.7:45215';
const METROPING_PKG = 'com.metroping.metroping';

// AI configuration
const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';
const aiConfig = {
  provider: 'google',
  apiKey,
  model: 'gemini-2.5-flash',
  maxTokens: 4096,
  analyzeWithScreenshot: true,
  analyzeWithUITree: true,
};

function formatMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ====================================================================
// Benchmark helpers
// ====================================================================

async function timeIt(label, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    const elapsed = Date.now() - start;
    console.log(`  [${formatMs(elapsed)}] ${label} — ${result ? 'OK' : 'FAILED'}`);
    return { elapsed, success: !!result, label };
  } catch (err) {
    const elapsed = Date.now() - start;
    console.log(`  [${formatMs(elapsed)}] ${label} — ERROR: ${err.message?.slice(0, 80)}`);
    return { elapsed, success: false, label, error: err.message };
  }
}

// ====================================================================
// Test 1: UIAutomator dump on Flutter app (baseline)
// ====================================================================

async function testUiautomatorOnFlutter(driver) {
  console.log('\n--- Test 1: UIAutomator dump on MetroPing (Flutter) ---');

  const result = await timeIt('getUIElements (uiautomator dump)', async () => {
    const elements = await driver.getUIElements(DEVICE_ID, { interactiveOnly: false });
    const hasContent = elements.some(el => el.text || el.contentDescription);
    console.log(`    Elements: ${elements.length}, with text/desc: ${elements.filter(e => e.text || e.contentDescription).length}`);
    return elements.length > 0;
  });

  return result;
}

// ====================================================================
// Test 2: findElement via AI (the slow path)
// ====================================================================

async function testFindElementAI(analyzer, query) {
  console.log(`\n--- Test 2: findElement("${query}") via AI vision ---`);

  const result = await timeIt(`AI findElement("${query}")`, async () => {
    const match = await analyzer.findElement(DEVICE_ID, query);
    if (match.found) {
      console.log(`    Found: ${match.element?.description} at (${match.element?.bounds?.centerX}, ${match.element?.bounds?.centerY}) conf=${match.confidence}`);
    }
    return match.found;
  });

  return result;
}

// ====================================================================
// Test 3: Flutter widget tree search (the fast path)
// ====================================================================

async function testFlutterWidgetSearch(flutterDriver, query) {
  console.log(`\n--- Test 3: Flutter findWidgetForTap("${query}") ---`);

  const result = await timeIt(`Flutter findWidgetForTap("${query}")`, async () => {
    const match = await flutterDriver.findWidgetForTap(query, DEVICE_ID);
    if (match?.found) {
      console.log(`    Found: ${match.element?.description} at (${match.element?.bounds?.centerX}, ${match.element?.bounds?.centerY}) conf=${match.confidence}`);
    }
    return match?.found;
  });

  return result;
}

// ====================================================================
// Test 4: Optimized findElement (with Flutter fast path)
// ====================================================================

async function testFindElementOptimized(analyzer, query) {
  console.log(`\n--- Test 4: Optimized findElement("${query}") with Flutter fast path ---`);

  const result = await timeIt(`Optimized findElement("${query}")`, async () => {
    const match = await analyzer.findElement(DEVICE_ID, query);
    if (match.found) {
      console.log(`    Found: ${match.element?.description} at (${match.element?.bounds?.centerX}, ${match.element?.bounds?.centerY}) conf=${match.confidence}`);
    }
    return match.found;
  });

  return result;
}

// ====================================================================
// Test 5: smartTap timing comparison
// ====================================================================

async function testSmartTap(analyzer, label, query) {
  console.log(`\n--- Test 5: smartTap("${query}") [${label}] ---`);

  const result = await timeIt(`smartTap("${query}")`, async () => {
    const tapResult = await analyzer.smartTap(DEVICE_ID, query);
    console.log(`    ${tapResult.message}`);
    return tapResult.success;
  });

  return result;
}

// ====================================================================
// Main
// ====================================================================

async function main() {
  console.log('='.repeat(70));
  console.log(' Flutter Performance Benchmark — mobile-device-mcp');
  console.log('='.repeat(70));
  console.log(`Device: ${DEVICE_ID}`);
  console.log(`AI Key: ${apiKey ? 'configured (' + aiConfig.provider + ')' : 'NOT SET'}`);
  console.log();

  const driver = new AndroidDriver();
  const flutterDriver = new FlutterDriver();

  // Launch MetroPing
  console.log('Launching MetroPing...');
  await driver.launchApp(DEVICE_ID, METROPING_PKG);
  await sleep(3000); // Wait for app to load

  // Verify it's running
  const current = await driver.getCurrentApp(DEVICE_ID);
  console.log(`Current app: ${current.packageName}`);
  if (current.packageName !== METROPING_PKG) {
    console.error('MetroPing not in foreground!');
    process.exit(1);
  }

  const results = { before: [], after: [] };

  // ==================================================================
  // PHASE 1: BEFORE optimization (no Flutter connection)
  // ==================================================================
  console.log('\n' + '='.repeat(70));
  console.log(' PHASE 1: BEFORE OPTIMIZATION (AI-only path)');
  console.log('='.repeat(70));

  // Test 1: UIAutomator dump
  results.before.push(await testUiautomatorOnFlutter(driver));

  // Test 2: AI findElement (if API key available)
  if (apiKey) {
    const aiClient = new AIClient(aiConfig);
    const analyzerNoFlutter = new ScreenAnalyzer(aiClient, driver, aiConfig, {
      format: 'jpeg', quality: 80, maxWidth: 720,
    });
    // No flutter driver passed = old behavior

    const queries = ['Metro', 'search', 'station'];
    for (const q of queries) {
      results.before.push(await testFindElementAI(analyzerNoFlutter, q));
    }
  } else {
    console.log('\n  (Skipping AI tests — no API key set)');
  }

  // ==================================================================
  // PHASE 2: AFTER optimization (Flutter connected)
  // ==================================================================
  console.log('\n' + '='.repeat(70));
  console.log(' PHASE 2: AFTER OPTIMIZATION (Flutter fast path)');
  console.log('='.repeat(70));

  // Connect Flutter
  console.log('\nConnecting to Flutter VM Service...');
  try {
    const conn = await flutterDriver.connect(DEVICE_ID);
    console.log(`Connected! VM: ${conn.vmServiceUrl}, Isolate: ${conn.isolateId}`);
  } catch (err) {
    console.error(`Failed to connect Flutter: ${err.message}`);
    console.log('\nFalling back to non-Flutter benchmarks only.');
    printSummary(results);
    process.exit(0);
  }

  // Test 3: Direct Flutter widget search
  const queries = ['Metro', 'search', 'station', 'Text'];
  for (const q of queries) {
    results.after.push(await testFlutterWidgetSearch(flutterDriver, q));
  }

  // Test 4: Optimized findElement (with Flutter fast path)
  if (apiKey) {
    const aiClient = new AIClient(aiConfig);
    const analyzerWithFlutter = new ScreenAnalyzer(aiClient, driver, aiConfig, {
      format: 'jpeg', quality: 80, maxWidth: 720,
    }, flutterDriver);

    for (const q of queries) {
      results.after.push(await testFindElementOptimized(analyzerWithFlutter, q));
    }

    // Test 5: Smart tap comparison
    // Don't actually tap on real elements to avoid navigation
    // Just measure findElement timing
  }

  // Disconnect
  await flutterDriver.disconnect();

  // ==================================================================
  // SUMMARY
  // ==================================================================
  printSummary(results);
}

function printSummary(results) {
  console.log('\n' + '='.repeat(70));
  console.log(' SUMMARY');
  console.log('='.repeat(70));

  if (results.before.length > 0) {
    const beforeTimes = results.before.filter(r => r.success).map(r => r.elapsed);
    const beforeAvg = beforeTimes.length > 0 ? beforeTimes.reduce((a, b) => a + b, 0) / beforeTimes.length : 0;
    console.log(`\n  BEFORE (AI-only path):`);
    console.log(`    Avg time: ${formatMs(beforeAvg)}`);
    console.log(`    Results:`);
    for (const r of results.before) {
      console.log(`      ${r.success ? 'OK' : 'FAIL'} ${formatMs(r.elapsed).padStart(8)} — ${r.label}`);
    }
  }

  if (results.after.length > 0) {
    const afterTimes = results.after.filter(r => r.success).map(r => r.elapsed);
    const afterAvg = afterTimes.length > 0 ? afterTimes.reduce((a, b) => a + b, 0) / afterTimes.length : 0;
    console.log(`\n  AFTER (Flutter fast path):`);
    console.log(`    Avg time: ${formatMs(afterAvg)}`);
    console.log(`    Results:`);
    for (const r of results.after) {
      console.log(`      ${r.success ? 'OK' : 'FAIL'} ${formatMs(r.elapsed).padStart(8)} — ${r.label}`);
    }

    // Calculate speedup
    const beforeAvg = results.before.filter(r => r.success).map(r => r.elapsed);
    const bAvg = beforeAvg.length > 0 ? beforeAvg.reduce((a, b) => a + b, 0) / beforeAvg.length : 0;
    if (bAvg > 0 && afterAvg > 0) {
      console.log(`\n  SPEEDUP: ${(bAvg / afterAvg).toFixed(1)}x faster`);
    }
  }

  console.log();
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
