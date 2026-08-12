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
    returns: 'void',
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
    args: { command: 'string?', cwd: 'string?', projectId: 'string?', label: 'string?' },
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
};
