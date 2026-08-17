// src/commands/schemas.js
// Zod schemas for command args. Each schema validates the declared fields
// from COMMAND_TYPES (types.js) and allows extra keys to pass through
// unchanged — handlers receive the original args object, not a stripped copy.
//
// Discipline: when adding a command, add both a COMMAND_TYPES entry and a
// schema here. The registry uses the schema to fail-closed on bad args.

import { z } from 'zod';

const optStr = z.string().nullable().optional();
const optNum = z.number().nullable().optional();
const optBool = z.boolean().nullable().optional();

const p = (shape) => z.object(shape).passthrough();

export const COMMAND_SCHEMAS = {
  select_project: p({ projectId: z.string() }),
  remove_project: p({ projectId: z.string() }),
  open_file: p({ path: z.string(), name: z.string() }),
  open_preview: p({ path: z.string(), name: z.string() }),
  open_browser: p({ url: z.string() }),
  close_tab: p({ filePath: z.string() }),
  switch_tab: p({ filePath: z.string() }),
  append_to_scratch: p({ text: z.string() }),
  update_editor_content: p({ filePath: optStr, content: z.string() }),
  update_editor_selection: p({}),
  save_active_file: p({}),
  undo_last_send: p({}),
  focus_terminal: p({ tabId: z.number() }),
  create_terminal: p({
    command: optStr,
    cwd: optStr,
    projectId: optStr,
    label: optStr,
  }),
  close_terminal: p({ tabId: z.number() }),
  send_to_terminal: p({ text: optStr, tabId: optNum }),
  get_focus: p({}),
  add_project: p({}),
  new_file: p({}),
  new_folder: p({}),
  toggle_sidebar: p({}),
  preview_open: p({ path: z.string(), reason: optStr, newTab: optBool }),
  preview_reveal: p({ previewPath: optStr, line: z.number(), endLine: optNum }),
  tab_activate: p({ filePath: z.string() }),
  project_set_badge: p({ projectId: z.string(), kind: z.string() }),
  agent_notification_received: p({
    tabId: z.number(),
    projectId: optStr,
    kind: z.enum(['turn_started', 'needs_attention', 'turn_completed', 'turn_failed']),
    eventType: z.string(),
    source: z.string(),
    reason: optStr,
    title: optStr,
    message: optStr,
    sessionId: optStr,
  }),
  agent_notification_seen: p({ tabId: z.number() }),
  terminal_set_waiting: p({ tabId: z.number(), projectId: optStr, waiting: z.boolean(), cause: optStr }),
  terminal_clear_attention: p({ tabId: z.number() }),
  agent_session_bound: p({ tabId: z.number(), provider: z.string(), sessionId: z.string(), status: optStr }),
  agent_session_unbound: p({ tabId: z.number() }),
  // Phase 5 S0: keybinding commands
  focus_scratch: p({}),
  terminal_copy: p({}),
  terminal_paste_image: p({}),
  close_overlay_menus: p({}),
  // Phase 5 S1: tree filter
  tree_filter_focus: p({}),
  tree_filter_clear: p({}),
  // Phase 5 S2: text search
  search_text_open: p({}),
  search_text: p({ query: z.string(), cwd: optStr, caseSensitive: optBool }),
};
