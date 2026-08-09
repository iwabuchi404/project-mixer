// src/commands/registry.js
// Command registry: single dispatch point for all UI state changes.
// Discipline: state changes must go through commands. The library is not
// the point — the discipline is.

import { COMMAND_TYPES } from './types.js';

const handlers = new Map();

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
  return handler(args);
}

export function has(name) {
  return handlers.has(name);
}

export function list() {
  return Array.from(handlers.keys());
}
