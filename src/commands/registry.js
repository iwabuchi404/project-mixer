// src/commands/registry.js
// Command registry: single dispatch point for all UI state changes.
// Discipline: state changes must go through commands. The library is not
// the point — the discipline is.

import { COMMAND_TYPES } from './types.js';

const handlers = new Map();
const trace = [];
const traceSubscribers = new Set();
let traceCounter = 0;
const TRACE_LIMIT = 200;

function emitTrace(entry) {
  trace.push(Object.freeze({ ...entry }));
  if (trace.length > TRACE_LIMIT) trace.splice(0, trace.length - TRACE_LIMIT);
  for (const subscriber of traceSubscribers) {
    try { subscriber(trace[trace.length - 1]); } catch (error) {
      console.error('[commands] trace subscriber error:', error);
    }
  }
}

function finishTrace(started, status, error) {
  emitTrace({
    ...started,
    status,
    durationMs: Math.max(0, performance.now() - started.startedAt),
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
  });
}

export function register(name, handler) {
  if (!COMMAND_TYPES[name]) {
    throw new Error(`[commands] Unknown command: ${name}`);
  }
  if (handlers.has(name)) {
    console.warn(`[commands] Overwriting existing handler: ${name}`);
  }
  handlers.set(name, handler);
}

export function dispatch(name, args = {}) {
  if (!COMMAND_TYPES[name]) {
    throw new Error(`[commands] Unknown command: ${name}`);
  }
  const handler = handlers.get(name);
  if (!handler) {
    console.error(`[commands] No handler registered for: ${name}`);
    return undefined;
  }
  const started = {
    id: ++traceCounter,
    name,
    // Keep command contents out of the trace. The keys are enough to diagnose
    // which transition ran without retaining terminal text or file contents.
    argKeys: Object.keys(args || {}).sort(),
    startedAt: performance.now(),
    timestamp: new Date().toISOString(),
  };
  try {
    const result = handler(args);
    if (result && typeof result.then === 'function') {
      return result.then((value) => {
        finishTrace(started, 'fulfilled');
        return value;
      }, (error) => {
        finishTrace(started, 'rejected', error);
        throw error;
      });
    }
    finishTrace(started, 'fulfilled');
    return result;
  } catch (error) {
    finishTrace(started, 'rejected', error);
    throw error;
  }
}

export function has(name) {
  return handlers.has(name);
}

export function list() {
  return Array.from(handlers.keys());
}

export function getTrace() {
  return trace.map((entry) => ({ ...entry }));
}

export function subscribeTrace(fn) {
  traceSubscribers.add(fn);
  return () => traceSubscribers.delete(fn);
}
