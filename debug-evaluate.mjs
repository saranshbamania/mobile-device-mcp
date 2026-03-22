/**
 * Debug: test evaluate() calls on Flutter VM service
 */

import { FlutterDriver } from './dist/drivers/flutter/index.js';

const DEVICE_ID = '192.168.1.7:45215';

async function main() {
  const flutter = new FlutterDriver();

  console.log('Connecting to Flutter...');
  const conn = await flutter.connect(DEVICE_ID);
  console.log(`Connected: ${conn.isolateId}\n`);

  // Get a widget with valueId
  const tree = await flutter.getWidgetTree();
  let targetWidget = null;
  function walk(node) {
    if (!targetWidget && node.valueId && (node.widgetRuntimeType === 'FilledButton' || node.widgetRuntimeType === 'IconButton')) {
      targetWidget = node;
    }
    if (node.children) node.children.forEach(walk);
  }
  walk(tree);

  if (!targetWidget) {
    // Fall back to any widget with valueId
    function walkAny(node) {
      if (!targetWidget && node.valueId && node.widgetRuntimeType !== 'MyApp' && node.widgetRuntimeType !== 'MaterialApp') {
        targetWidget = node;
      }
      if (node.children) node.children.forEach(walk);
    }
    walkAny(tree);
  }

  console.log(`Target widget: ${targetWidget?.widgetRuntimeType} valueId=${targetWidget?.valueId}`);

  // Access client and isolateId directly for low-level testing
  const client = flutter['client'];
  const isolateId = flutter['isolateId'];

  // Step 1: Get isolate libraries
  console.log('\n=== Isolate Libraries (Flutter-related) ===');
  const isolate = await client.getIsolate(isolateId);
  const flutterLibs = isolate.libraries.filter(l =>
    l.uri?.includes('widget_inspector') ||
    l.uri?.includes('binding') ||
    l.uri?.includes('package:flutter/src/widgets/')
  );
  for (const lib of flutterLibs.slice(0, 10)) {
    console.log(`  ${lib.uri} (id=${lib.id})`);
  }

  // Step 2: Try setSelectionById
  console.log('\n=== setSelectionById ===');
  try {
    const selResult = await client.callExtension(
      'ext.flutter.inspector.setSelectionById',
      isolateId,
      { objectGroup: 'mcp-inspector', arg: targetWidget.valueId },
    );
    console.log(`  Result: ${JSON.stringify(selResult)}`);
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }

  // Step 3: Try simple evaluate
  console.log('\n=== Simple Evaluate Tests ===');

  // Find a suitable library
  const inspectorLib = flutterLibs.find(l => l.uri?.includes('widget_inspector'));
  const widgetsLib = flutterLibs.find(l => l.uri?.includes('package:flutter/src/widgets/'));
  const appLib = isolate.libraries.find(l => l.uri?.startsWith('package:') && !l.uri?.startsWith('package:flutter/'));

  const testLib = inspectorLib || widgetsLib || appLib;
  console.log(`  Using library: ${testLib?.uri} (id=${testLib?.id})`);

  // Test 1: Simple string
  try {
    const r1 = await client.evaluate(isolateId, testLib.id, '"hello"');
    console.log(`  evaluate('"hello"'): type=${r1.type} value=${r1.valueAsString}`);
  } catch (err) {
    console.log(`  evaluate('"hello"'): ERROR ${err.message}`);
  }

  // Test 2: Access WidgetInspectorService
  try {
    const r2 = await client.evaluate(isolateId, testLib.id, 'WidgetInspectorService.instance.toString()');
    console.log(`  evaluate('WidgetInspectorService.instance.toString()'): type=${r2.type} value=${r2.valueAsString?.slice(0, 80)}`);
  } catch (err) {
    console.log(`  evaluate('WidgetInspectorService.instance'): ERROR ${err.message}`);
  }

  // Test 3: Access selection
  try {
    const r3 = await client.evaluate(isolateId, testLib.id, 'WidgetInspectorService.instance.selection?.current?.toString() ?? "null"');
    console.log(`  evaluate('selection.current'): type=${r3.type} value=${r3.valueAsString?.slice(0, 120)}`);
  } catch (err) {
    console.log(`  evaluate('selection.current'): ERROR ${err.message}`);
  }

  // Test 4: Access render object
  try {
    const r4 = await client.evaluate(isolateId, testLib.id, 'WidgetInspectorService.instance.selection?.current?.findRenderObject()?.toString() ?? "null"');
    console.log(`  evaluate('findRenderObject'): type=${r4.type} value=${r4.valueAsString?.slice(0, 120)}`);
  } catch (err) {
    console.log(`  evaluate('findRenderObject'): ERROR ${err.message}`);
  }

  // Test 5: Get bounds via IIFE
  try {
    const expr = `(() {
  try {
    final sel = WidgetInspectorService.instance.selection;
    if (sel == null || sel.current == null) return 'no-selection';
    final ro = sel.current!.findRenderObject();
    if (ro == null) return 'no-render-object';
    if (ro is! RenderBox) return 'not-renderbox:\${ro.runtimeType}';
    if (!ro.hasSize) return 'no-size';
    final pos = ro.localToGlobal(Offset.zero);
    return '\${pos.dx},\${pos.dy},\${ro.size.width},\${ro.size.height}';
  } catch (e) {
    return 'error:\$e';
  }
})()`;
    const r5 = await client.evaluate(isolateId, testLib.id, expr);
    console.log(`  evaluate(IIFE bounds): type=${r5.type} value=${r5.valueAsString}`);
  } catch (err) {
    console.log(`  evaluate(IIFE bounds): ERROR ${err.message}`);
  }

  // Test 6: Try with app library instead
  if (appLib && appLib.id !== testLib?.id) {
    console.log(`\n=== Retry with app library: ${appLib.uri} ===`);
    try {
      const r6 = await client.evaluate(isolateId, appLib.id, '"hello from app"');
      console.log(`  evaluate('"hello from app"'): type=${r6.type} value=${r6.valueAsString}`);
    } catch (err) {
      console.log(`  evaluate('"hello from app"'): ERROR ${err.message}`);
    }

    try {
      const expr = `(() {
  try {
    final sel = WidgetInspectorService.instance.selection;
    if (sel == null || sel.current == null) return 'no-selection';
    final ro = sel.current!.findRenderObject();
    if (ro == null) return 'no-render-object';
    if (ro is! RenderBox) return 'not-renderbox:\${ro.runtimeType}';
    if (!ro.hasSize) return 'no-size';
    final pos = ro.localToGlobal(Offset.zero);
    return '\${pos.dx},\${pos.dy},\${ro.size.width},\${ro.size.height}';
  } catch (e) {
    return 'error:\$e';
  }
})()`;
      const r7 = await client.evaluate(isolateId, appLib.id, expr);
      console.log(`  evaluate(IIFE bounds from app): type=${r7.type} value=${r7.valueAsString}`);
    } catch (err) {
      console.log(`  evaluate(IIFE bounds from app): ERROR ${err.message}`);
    }
  }

  await flutter.disconnect();
}

main().catch(console.error);
