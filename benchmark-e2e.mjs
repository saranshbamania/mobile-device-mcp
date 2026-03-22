/**
 * End-to-end benchmark: simulates a real testing session
 * with 10 consecutive smart_tap/findElement calls on MetroPing.
 *
 * Compares total session time BEFORE vs AFTER optimization.
 */

import { AndroidDriver } from './dist/drivers/android/index.js';
import { ScreenAnalyzer } from './dist/ai/analyzer.js';
import { AIClient } from './dist/ai/client.js';

const DEVICE_ID = '192.168.1.7:45215';
const METROPING_PKG = 'com.metroping.metroping';

const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';
const aiConfig = {
  provider: 'google', apiKey, model: 'gemini-2.5-flash',
  maxTokens: 4096, analyzeWithScreenshot: true, analyzeWithUITree: true,
};

function fmt(ms) { return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`; }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  if (!apiKey) {
    console.error('GOOGLE_API_KEY required for AI baseline comparison');
    process.exit(1);
  }

  const driver = new AndroidDriver();

  console.log('Launching MetroPing...');
  await driver.launchApp(DEVICE_ID, METROPING_PKG);
  await sleep(3000);

  // 10 queries simulating a real testing session
  const queries = [
    'MetroPing',
    'Select Station',
    'From',
    'To',
    'Swap',
    'Quick Tips',
    'Arrival Alerts',
    'Transfer Guidance',
    'Works Offline',
    'Select Both Stations',
  ];

  // ============= OPTIMIZED PATH (new code) =============
  console.log('\n=== OPTIMIZED: 10 findElement calls ===\n');
  const aiClient = new AIClient(aiConfig);
  const optimizedAnalyzer = new ScreenAnalyzer(
    aiClient, driver, aiConfig,
    { format: 'jpeg', quality: 80, maxWidth: 720 },
  );

  const optStart = Date.now();
  let optFound = 0;
  for (const q of queries) {
    const s = Date.now();
    const r = await optimizedAnalyzer.findElement(DEVICE_ID, q);
    const e = Date.now() - s;
    if (r.found) optFound++;
    console.log(`  [${fmt(e)}] "${q}" → ${r.found ? 'FOUND' : 'not found'}`);
  }
  const optTotal = Date.now() - optStart;

  // ============= AI-ONLY PATH (old code simulation) =============
  // Simulate the old behavior: force AI path for every call
  console.log('\n=== BEFORE (AI-only): 3 findElement calls (extrapolated to 10) ===\n');

  const aiTimes = [];
  for (let i = 0; i < 3; i++) {
    const q = queries[i];
    const s = Date.now();
    try {
      // Force AI path by calling the AI client directly
      const screenshot = await driver.takeScreenshot(DEVICE_ID, { format: 'jpeg', quality: 80, maxWidth: 720 });
      const ui = await driver.getUIElements(DEVICE_ID, { interactiveOnly: false });
      const { summarizeUIElements } = await import('./dist/ai/prompts.js');
      const summarized = summarizeUIElements(ui);

      const result = await aiClient.analyzeJSON({
        systemPrompt: 'You are a UI element locator. Return ONLY valid JSON.\n{"found":true,"element":{"description":"string","type":"string","text":"string","bounds":{"left":0,"top":0,"right":0,"bottom":0,"centerX":0,"centerY":0},"suggestedAction":"string","confidence":0.0},"confidence":0.0,"alternatives":[]}',
        userPrompt: `Find: '${q}'\n\nUI:\n${JSON.stringify(summarized)}`,
        screenshot: screenshot.base64,
        screenshotMimeType: `image/${screenshot.format}`,
      });

      const e = Date.now() - s;
      console.log(`  [${fmt(e)}] "${q}" → ${result.found ? 'FOUND' : 'not found'}`);
      aiTimes.push(e);
    } catch (err) {
      const e = Date.now() - s;
      console.log(`  [${fmt(e)}] "${q}" → ERROR`);
      aiTimes.push(e);
    }
  }

  const aiAvg = aiTimes.reduce((a, b) => a + b, 0) / aiTimes.length;
  const aiEstimated10 = aiAvg * 10;

  // ============= SUMMARY =============
  console.log('\n' + '='.repeat(60));
  console.log(' END-TO-END COMPARISON');
  console.log('='.repeat(60));
  console.log(`\n  OPTIMIZED (actual 10 calls):`);
  console.log(`    Total time: ${fmt(optTotal)}`);
  console.log(`    Found: ${optFound}/10`);
  console.log(`    Avg per call: ${fmt(optTotal / 10)}`);

  console.log(`\n  AI-ONLY (measured 3, extrapolated to 10):`);
  console.log(`    Avg per call: ${fmt(aiAvg)}`);
  console.log(`    Estimated 10 calls: ${fmt(aiEstimated10)}`);

  console.log(`\n  SPEEDUP: ${(aiEstimated10 / optTotal).toFixed(0)}x faster`);
  console.log(`  TIME SAVED: ${fmt(aiEstimated10 - optTotal)} per 10-operation session`);
  console.log();
}

main().catch(console.error);
