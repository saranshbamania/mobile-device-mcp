/**
 * Flutter Performance Benchmark v2
 *
 * Measures actual smart_tap/find_element timing for MetroPing
 * comparing the BEFORE (AI-only) vs AFTER (local search + skip redundant)
 * optimization paths.
 */

import { AndroidDriver } from './dist/drivers/android/index.js';
import { FlutterDriver } from './dist/drivers/flutter/index.js';
import { ScreenAnalyzer } from './dist/ai/analyzer.js';
import { AIClient } from './dist/ai/client.js';
import { searchElementsLocally } from './dist/ai/element-search.js';

const DEVICE_ID = '192.168.1.7:45215';
const METROPING_PKG = 'com.metroping.metroping';

const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';
const aiConfig = {
  provider: 'google',
  apiKey,
  model: 'gemini-2.5-flash',
  maxTokens: 4096,
  analyzeWithScreenshot: true,
  analyzeWithUITree: true,
};

function fmt(ms) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function timeIt(fn) {
  const s = Date.now();
  const result = await fn();
  return { elapsed: Date.now() - s, result };
}

async function main() {
  console.log('='.repeat(70));
  console.log(' Flutter smart_tap Performance Benchmark');
  console.log('='.repeat(70));
  console.log(`Device: ${DEVICE_ID}`);
  console.log(`API Key: ${apiKey ? 'YES' : 'NO'}\n`);

  const driver = new AndroidDriver();
  const flutterDriver = new FlutterDriver();

  // Ensure MetroPing is in foreground
  console.log('Launching MetroPing...');
  await driver.launchApp(DEVICE_ID, METROPING_PKG);
  await sleep(3000);
  const app = await driver.getCurrentApp(DEVICE_ID);
  console.log(`Foreground: ${app.packageName}\n`);

  const queries = [
    'Select Station',    // Exact match on content-desc
    'station',           // Partial match
    'Swap',              // Button action
    'Metro',             // App name
    'Quick Tips',        // Section header
    'Arrival Alerts',    // Feature name
  ];

  // ==================================================================
  // TEST 1: Raw UIAutomator dump + local search (what we optimized)
  // ==================================================================
  console.log('=== Test 1: UIAutomator + Local Search (OPTIMIZED PATH) ===\n');

  // First call: includes ADB dump time
  const { elapsed: dumpTime, result: elements } = await timeIt(() =>
    driver.getUIElements(DEVICE_ID, { interactiveOnly: false })
  );
  console.log(`  UIAutomator dump: ${fmt(dumpTime)} (${elements.length} elements, ${elements.filter(e => e.text || e.contentDescription).length} with text)\n`);

  const localResults = [];
  for (const q of queries) {
    const { elapsed, result } = await timeIt(() => searchElementsLocally(elements, q));
    const status = result.found ? `FOUND at (${result.element.bounds.centerX}, ${result.element.bounds.centerY}) conf=${result.confidence.toFixed(2)}` : `NOT FOUND conf=${result.confidence.toFixed(2)}`;
    console.log(`  [${fmt(elapsed)}] "${q}" → ${status}`);
    localResults.push({ query: q, elapsed, found: result.found, total: dumpTime + elapsed });
  }

  // Subsequent calls (cached UIElements)
  console.log(`\n  >> With cached elements (no ADB call):`);
  for (const q of queries) {
    const { elapsed, result } = await timeIt(() => searchElementsLocally(elements, q));
    console.log(`  [${fmt(elapsed)}] "${q}" → ${result.found ? 'FOUND' : 'not found'}`);
  }

  // ==================================================================
  // TEST 2: Full findElement with ScreenAnalyzer (OPTIMIZED - Flutter-aware)
  // ==================================================================
  console.log('\n=== Test 2: ScreenAnalyzer.findElement (OPTIMIZED) ===\n');

  let optimizedResults = [];
  if (apiKey) {
    // Connect Flutter
    let flutterConnected = false;
    try {
      await flutterDriver.connect(DEVICE_ID);
      console.log('  Flutter VM Service: connected\n');
      flutterConnected = true;
    } catch {
      console.log('  Flutter VM Service: NOT connected (using UIAutomator only)\n');
    }

    const aiClient = new AIClient(aiConfig);
    const optimizedAnalyzer = new ScreenAnalyzer(
      aiClient, driver, aiConfig,
      { format: 'jpeg', quality: 80, maxWidth: 720 },
      flutterConnected ? flutterDriver : undefined
    );

    for (const q of queries) {
      const { elapsed, result } = await timeIt(() => optimizedAnalyzer.findElement(DEVICE_ID, q));
      const status = result.found
        ? `FOUND "${result.element?.text || result.element?.description}" conf=${result.confidence?.toFixed(2)}`
        : `NOT FOUND conf=${result.confidence?.toFixed(2)}`;
      console.log(`  [${fmt(elapsed)}] "${q}" → ${status}`);
      optimizedResults.push({ query: q, elapsed, found: result.found });
    }

    // Second pass (cached)
    console.log(`\n  >> Second pass (cached UIElements):`);
    for (const q of queries) {
      const { elapsed, result } = await timeIt(() => optimizedAnalyzer.findElement(DEVICE_ID, q));
      console.log(`  [${fmt(elapsed)}] "${q}" → ${result.found ? 'FOUND' : 'not found'} (${fmt(elapsed)})`);
    }

    if (flutterConnected) await flutterDriver.disconnect();
  } else {
    console.log('  (Skipped — no API key)\n');
  }

  // ==================================================================
  // TEST 3: AI-ONLY findElement (BEFORE optimization simulation)
  // ==================================================================
  console.log('\n=== Test 3: AI-ONLY findElement (BEFORE optimization) ===\n');

  let aiResults = [];
  if (apiKey) {
    const aiClient2 = new AIClient(aiConfig);
    // Simulate BEFORE: high threshold that rejects Flutter content-desc matches
    // by NOT passing flutterDriver and testing with original >0.7 behavior
    // Actually, the threshold change is in element-search.ts, so to simulate
    // "before", we'd need the old code. Instead, let's just measure AI path directly.

    console.log('  (Testing 2 queries to measure AI vision latency)\n');

    for (const q of queries.slice(0, 2)) {
      // Force AI path by calling analyzeJSON directly
      const start = Date.now();
      try {
        const ctx = await timeIt(async () => {
          const screenshot = await driver.takeScreenshot(DEVICE_ID, { format: 'jpeg', quality: 80, maxWidth: 720 });
          const ui = await driver.getUIElements(DEVICE_ID, { interactiveOnly: false });
          return { screenshot, ui };
        });

        // Build AI request
        const { summarizeUIElements } = await import('./dist/ai/prompts.js');
        const summarized = summarizeUIElements(ctx.result.ui);
        const captureTime = ctx.elapsed;

        const aiStart = Date.now();
        const aiResult = await aiClient2.analyzeJSON({
          systemPrompt: 'You are a UI element locator for mobile app screenshots. Return ONLY valid JSON.\n\nJSON schema:\n{"found":true,"element":{"description":"string","type":"string","text":"string","bounds":{"left":0,"top":0,"right":0,"bottom":0,"centerX":0,"centerY":0},"suggestedAction":"string","confidence":0.0},"confidence":0.0,"alternatives":[]}',
          userPrompt: `Find the element matching: '${q}'\n\nUI element tree:\n${JSON.stringify(summarized)}`,
          screenshot: ctx.result.screenshot.base64,
          screenshotMimeType: `image/${ctx.result.screenshot.format}`,
        });
        const aiTime = Date.now() - aiStart;
        const totalTime = Date.now() - start;

        console.log(`  [${fmt(totalTime)}] "${q}" → capture:${fmt(captureTime)} + AI:${fmt(aiTime)}`);
        if (aiResult.found) {
          console.log(`    Found: "${aiResult.element?.text || aiResult.element?.description}" at (${aiResult.element?.bounds?.centerX}, ${aiResult.element?.bounds?.centerY})`);
        }
        aiResults.push({ query: q, elapsed: totalTime, found: aiResult.found, captureTime, aiTime });
      } catch (err) {
        const elapsed = Date.now() - start;
        console.log(`  [${fmt(elapsed)}] "${q}" → ERROR: ${err.message?.slice(0, 80)}`);
        aiResults.push({ query: q, elapsed, found: false });
      }
    }
  } else {
    console.log('  (Skipped — no API key. Set GOOGLE_API_KEY to measure AI baseline)\n');
  }

  // ==================================================================
  // SUMMARY
  // ==================================================================
  console.log('\n' + '='.repeat(70));
  console.log(' RESULTS SUMMARY');
  console.log('='.repeat(70));

  // Local search times
  const localFound = localResults.filter(r => r.found);
  const localAvgSearch = localFound.length > 0 ? localFound.reduce((a, b) => a + b.elapsed, 0) / localFound.length : 0;
  const localAvgTotal = localFound.length > 0 ? localFound.reduce((a, b) => a + b.total, 0) / localFound.length : 0;

  console.log(`\n  LOCAL SEARCH (optimized path):`);
  console.log(`    UIAutomator dump: ${fmt(dumpTime)} (one-time cost)`);
  console.log(`    Avg search time: ${fmt(localAvgSearch)}`);
  console.log(`    Total (first call): ${fmt(localAvgTotal)}`);
  console.log(`    Total (cached): ${fmt(localAvgSearch)}`);
  console.log(`    Hit rate: ${localFound.length}/${localResults.length}`);

  if (aiResults.length > 0) {
    const aiAvg = aiResults.reduce((a, b) => a + b.elapsed, 0) / aiResults.length;
    console.log(`\n  AI VISION (before optimization):`);
    console.log(`    Avg total: ${fmt(aiAvg)}`);
    for (const r of aiResults) {
      console.log(`    "${r.query}": ${fmt(r.elapsed)} (capture:${fmt(r.captureTime || 0)} AI:${fmt(r.aiTime || 0)})`);
    }

    if (localAvgTotal > 0 && aiAvg > 0) {
      console.log(`\n  SPEEDUP (first call): ${(aiAvg / localAvgTotal).toFixed(1)}x`);
      console.log(`  SPEEDUP (cached): ${(aiAvg / localAvgSearch).toFixed(0)}x`);
    }
  }

  if (optimizedResults.length > 0) {
    const optFound = optimizedResults.filter(r => r.found);
    const optAvg = optFound.length > 0 ? optFound.reduce((a, b) => a + b.elapsed, 0) / optFound.length : 0;
    console.log(`\n  OPTIMIZED findElement:`);
    console.log(`    Avg time: ${fmt(optAvg)}`);
    console.log(`    Hit rate: ${optFound.length}/${optimizedResults.length}`);
  }

  console.log('\n' + '='.repeat(70));
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
