// Summarizes a probe log produced by probe-hook.cjs.
//
// Usage:
//   node view-probe.cjs <logPath>
//
// Prints, per event kind: count, field schema, id continuity, stop_hook_active
// values, env presence, and timing. Designed to answer the D0 gate questions
// without exposing prompt/tool_input content.

'use strict';

const fs = require('fs');

function loadEntries(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    })
    .filter(Boolean);
}

function summarize(logPath) {
  const entries = loadEntries(logPath);
  if (entries.length === 0) {
    console.log('No probe events recorded yet.');
    return;
  }

  console.log(`Total events: ${entries.length}`);
  console.log('');

  const byEvent = new Map();
  const calledMarkers = [];
  for (const e of entries) {
    if (e.phase === 'called') {
      calledMarkers.push(e);
      continue;
    }
    const key = e.hook_event_name || '(unknown)';
    if (!byEvent.has(key)) byEvent.set(key, []);
    byEvent.get(key).push(e);
  }

  if (calledMarkers.length > 0) {
    console.log(`=== "called" markers (hook invoked, before stdin)  (${calledMarkers.length}) ===`);
    for (const m of calledMarkers) {
      console.log(`  ${m.observedAt}  pid=${m.pid}  ptyId=${m.pmPtyId}`);
    }
    console.log('');
  }

  for (const [name, list] of byEvent) {
    console.log(`=== ${name}  (${list.length}) ===`);
    // Field schema union across all events of this kind.
    const schemaUnion = {};
    for (const e of list) {
      for (const [k, t] of Object.entries(e.fieldSchema || {})) {
        if (!(k in schemaUnion)) schemaUnion[k] = new Set();
        schemaUnion[k].add(t);
      }
    }
    console.log('  fields:');
    for (const [k, types] of Object.entries(schemaUnion)) {
      console.log(`    ${k}: ${[...types].join(' | ')}`);
    }
    // session_id continuity.
    const sessions = new Set(list.map((e) => e.session_id));
    console.log(`  session_id values: ${sessions.size} (${[...sessions].slice(0, 3).join(', ')}${sessions.size > 3 ? ', ...' : ''})`);
    // prompt_id rotation / absence.
    const promptIds = list.map((e) => e.prompt_id);
    const present = promptIds.filter((v) => v !== null);
    const distinct = new Set(present);
    console.log(`  prompt_id present: ${present.length}/${list.length}, distinct: ${distinct.size}`);
    if (name === 'Stop') {
      const vals = list.map((e) => e.stop_hook_active);
      console.log(`  stop_hook_active values: ${JSON.stringify(vals)}`);
    }
    if (name === 'PermissionRequest') {
      const tools = list.map((e) => e.tool_name);
      console.log(`  tool_name values: ${JSON.stringify(tools)}`);
    }
    // env presence.
    const ptyPresent = list.filter((e) => e.pmPtyId_present).length;
    const portPresent = list.filter((e) => e.pmPortFilePresent).length;
    const devinDirPresent = list.filter((e) => e.devinProjectDir_present).length;
    console.log(`  PROJECT_MIXER_PTY_ID present: ${ptyPresent}/${list.length}${ptyPresent ? ` (values: ${[...new Set(list.map((e) => e.pmPtyId))].join(',')})` : ''}`);
    console.log(`  PROJECT_MIXER_PORT_FILE present: ${portPresent}/${list.length}`);
    console.log(`  DEVIN_PROJECT_DIR present: ${devinDirPresent}/${list.length}`);
    // timing.
    const elapsed = list.map((e) => Math.round(Number(e.elapsedNs) / 1e6));
    console.log(`  elapsed ms (min/avg/max): ${Math.min(...elapsed)}/${Math.round(elapsed.reduce((a, b) => a + b, 0) / elapsed.length)}/${Math.max(...elapsed)}`);
    console.log('');
  }

  // Cross-event ordering: print the chronological sequence of event names
  // with their prompt_id, to inspect arrival order and stale stops.
  console.log('=== Chronological sequence ===');
  for (const e of entries) {
    console.log(`  ${e.observedAt}  ${e.hook_event_name}  prompt_id=${e.prompt_id}  session=${e.session_id ? e.session_id.slice(0, 8) : '-'}${e.hook_event_name === 'Stop' ? `  stop_hook_active=${e.stop_hook_active}` : ''}`);
  }
}

module.exports = { summarize, loadEntries };

if (require.main === module) {
  const logPath = process.argv[2];
  if (!logPath) {
    console.error('Usage: node view-probe.cjs <logPath>');
    process.exit(1);
  }
  summarize(logPath);
}
