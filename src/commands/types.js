// src/commands/types.js
// Command definitions: name, args, return type.
// New features must add an entry here — this prevents ad-hoc "patches".

export const COMMAND_TYPES = {
  select_project: {
    args: { projectId: 'string' },
    returns: 'void',
  },
  remove_project: {
    args: { projectId: 'string' },
    returns: 'void',
  },
  open_file: {
    args: { path: 'string', name: 'string' },
    returns: 'void',
  },
  open_preview: {
    args: { path: 'string', name: 'string' },
    returns: '{ shown: boolean, previewPath: string|null, reason: string }',
  },
  open_browser: {
    args: { url: 'string' },
    returns: 'void',
  },
  close_tab: {
    args: { filePath: 'string' },
    returns: 'void',
  },
  switch_tab: {
    args: { filePath: 'string' },
    returns: 'void',
  },
  append_to_scratch: {
    args: { text: 'string' },
    returns: 'void',
  },
  update_editor_content: {
    args: { filePath: 'string?', content: 'string' },
    returns: 'void',
  },
  update_editor_selection: {
    args: {},
    returns: 'void',
  },
  save_active_file: {
    args: {},
    returns: 'void',
  },
  undo_last_send: {
    args: {},
    returns: 'void',
  },
  focus_terminal: {
    args: { tabId: 'number' },
    returns: 'void',
  },
  create_terminal: {
    args: { command: 'string?', cwd: 'string?', projectId: 'string?', label: 'string?', resumeSessionId: 'string?' },
    returns: 'number',
  },
  close_terminal: {
    args: { tabId: 'number' },
    returns: 'void',
  },
  send_to_terminal: {
    args: { text: 'string?', tabId: 'number?' },
    returns: 'void',
  },
  get_focus: {
    args: {},
    returns: 'FocusState',
  },
  // A8: アプリケーションメニューから既存 UI を呼ぶためのコマンド
  add_project: {
    args: {},
    returns: 'void',
  },
  new_file: {
    args: {},
    returns: 'void',
  },
  new_folder: {
    args: {},
    returns: 'void',
  },
  toggle_sidebar: {
    args: {},
    returns: 'void',
  },
  // 3.4 show_file: commands for external UI control
  preview_open: {
    args: { path: 'string', reason: 'string?', newTab: 'boolean?' },
    returns: 'ShowFileResult',
  },
  preview_reveal: {
    args: { previewPath: 'string?', line: 'number', endLine: 'number?' },
    returns: 'RevealResult',
  },
  tab_activate: {
    args: { filePath: 'string' },
    returns: 'void',
  },
  project_set_badge: {
    args: { projectId: 'string', kind: 'string' },
    returns: 'void',
  },
  agent_notification_received: {
    args: {
      tabId: 'number',
      projectId: 'string?',
      kind: 'turn_started | needs_attention | turn_completed | turn_failed',
      eventType: 'string',
      source: 'string',
      reason: 'string?',
      title: 'string?',
      message: 'string?',
      sessionId: 'string?',
    },
    returns: 'void',
  },
  agent_notification_seen: {
    args: { tabId: 'number' },
    returns: 'void',
  },
  terminal_set_waiting: {
    args: { tabId: 'number', projectId: 'string?', waiting: 'boolean', cause: 'string?' },
    returns: 'void',
  },
  terminal_clear_attention: {
    args: { tabId: 'number' },
    returns: 'void',
  },
  agent_session_bound: {
    args: { tabId: 'number', provider: 'string', sessionId: 'string', status: 'string?' },
    returns: 'void',
  },
  agent_session_unbound: {
    args: { tabId: 'number' },
    returns: 'void',
  },
  // Phase 5 S0: keybinding commands
  focus_scratch: {
    args: {},
    returns: 'void',
  },
  terminal_copy: {
    args: {},
    returns: 'void',
  },
  terminal_paste_image: {
    args: {},
    returns: 'void',
  },
  close_overlay_menus: {
    args: {},
    returns: 'void',
  },
  // Phase 5 S1: tree filter
  tree_filter_focus: {
    args: {},
    returns: 'void',
  },
  tree_filter_clear: {
    args: {},
    returns: 'void',
  },
  // Phase 5 S2: text search
  search_text_open: {
    args: {},
    returns: 'void',
  },
  terminal_select_all: {
    args: {},
    returns: 'void',
  },
  search_text: {
    args: { query: 'string', cwd: 'string?', caseSensitive: 'boolean?' },
    returns: 'SearchResult',
  },
  search_close: {
    args: {},
    returns: 'void',
  },
  // Phase 4.5 A4: point at selected editor lines from the scratch composer
  insert_selection_to_scratch: {
    args: {},
    returns: 'void',
  },
  // Session resume: menu checkbox toggles the mode.
  resume_mode_changed: {
    args: { mode: 'ask | auto' },
    returns: 'void',
  },
  // Phase 5 S3: shared find bar (delegates to editor / preview)
  find_open: {
    args: {},
    returns: 'void',
  },
  // Editor: VSCode-style Ctrl+D (add next occurrence to selection)
  editor_select_next_occurrence: {
    args: {},
    returns: 'void',
  },
  find_next: {
    args: {},
    returns: 'void',
  },
  find_prev: {
    args: {},
    returns: 'void',
  },
  find_close: {
    args: {},
    returns: 'void',
  },
};
