/**
 * Debug script to understand why findWidgetForTap fails
 * and what UIAutomator actually sees on Flutter apps.
 */

import { AndroidDriver } from './dist/drivers/android/index.js';
import { FlutterDriver } from './dist/drivers/flutter/index.js';

const DEVICE_ID = '192.168.1.7:45215';

async function main() {
  const driver = new AndroidDriver();
  const flutter = new FlutterDriver();

  // --- Part 1: What does UIAutomator see? ---
  console.log('=== UIAutomator Elements on MetroPing ===\n');
  const elements = await driver.getUIElements(DEVICE_ID, { interactiveOnly: false });
  for (const el of elements) {
    if (el.text || el.contentDescription) {
      console.log(`  [${el.index}] text="${el.text}" desc="${el.contentDescription}" class=${el.className} bounds=[${el.bounds.left},${el.bounds.top}][${el.bounds.right},${el.bounds.bottom}] clickable=${el.clickable}`);
    }
  }
  console.log(`\nTotal: ${elements.length} elements, ${elements.filter(e => e.text || e.contentDescription).length} with text/desc\n`);

  // --- Part 2: Test local search on these elements ---
  console.log('=== Local Search Results ===\n');
  const { searchElementsLocally } = await import('./dist/ai/element-search.js');
  const queries = ['Metro', 'search', 'station', 'Select', 'From', 'To'];
  for (const q of queries) {
    const result = searchElementsLocally(elements, q);
    if (result.found) {
      console.log(`  "${q}" -> FOUND: "${result.element?.text}" at (${result.element?.bounds?.centerX}, ${result.element?.bounds?.centerY}) conf=${result.confidence.toFixed(2)}`);
    } else {
      console.log(`  "${q}" -> not found (conf=${result.confidence.toFixed(2)})`);
    }
  }

  // --- Part 3: Flutter widget tree ---
  console.log('\n=== Flutter Widget Tree ===\n');
  try {
    const conn = await flutter.connect(DEVICE_ID);
    console.log(`Connected: ${conn.vmServiceUrl}\n`);

    const tree = await flutter.getWidgetTree();

    // Count widgets and list those with text
    let total = 0;
    const textWidgets = [];
    function walk(node, depth = 0) {
      total++;
      const type = node.widgetRuntimeType || '';
      const text = node.textPreview || '';
      const desc = node.description || '';
      if (text || type.includes('Text') || type.includes('Button') || type.includes('Icon')) {
        textWidgets.push({ type, text, desc, valueId: node.valueId, objectId: node.objectId, depth });
      }
      if (node.children) {
        for (const child of node.children) walk(child, depth + 1);
      }
    }
    walk(tree);

    console.log(`Total widgets: ${total}`);
    console.log(`Interactive/text widgets:\n`);
    for (const w of textWidgets.slice(0, 30)) {
      console.log(`  ${'  '.repeat(w.depth)}${w.type}: "${w.text || w.desc}" (valueId=${w.valueId ? 'yes' : 'no'})`);
    }

    // --- Part 4: Test findWidget ---
    console.log('\n=== Flutter findWidget Results ===\n');
    for (const q of queries) {
      const result = flutter.findWidget(tree, q);
      if (result.found) {
        const w = result.widget;
        console.log(`  "${q}" -> FOUND: ${w.widgetRuntimeType} "${w.textPreview || w.description}" (valueId=${w.valueId || 'none'})`);
      } else {
        console.log(`  "${q}" -> not found`);
      }
    }

    // --- Part 5: Test getWidgetBounds on first found widget ---
    console.log('\n=== Widget Bounds Resolution ===\n');
    const testSearch = flutter.findWidget(tree, 'Text');
    if (testSearch.found && testSearch.widget?.valueId) {
      console.log(`Testing bounds for: ${testSearch.widget.widgetRuntimeType} "${testSearch.widget.textPreview}"`);
      console.log(`  valueId: ${testSearch.widget.valueId}`);

      try {
        const bounds = await flutter.getWidgetBounds(testSearch.widget.valueId, DEVICE_ID);
        if (bounds) {
          console.log(`  Bounds: left=${bounds.left} top=${bounds.top} right=${bounds.right} bottom=${bounds.bottom}`);
          console.log(`  Center: (${bounds.centerX}, ${bounds.centerY})`);
        } else {
          console.log(`  Bounds: null (evaluate failed)`);
        }
      } catch (err) {
        console.log(`  Error getting bounds: ${err.message}`);
      }
    }

    // --- Part 6: Test DPR ---
    console.log('\n=== Device Pixel Ratio ===');
    const dpr = await flutter.getDevicePixelRatio(DEVICE_ID);
    console.log(`  DPR: ${dpr}`);

    await flutter.disconnect();
  } catch (err) {
    console.error(`Flutter error: ${err.message}`);
  }
}

main().catch(console.error);
