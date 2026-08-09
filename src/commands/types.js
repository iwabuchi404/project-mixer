// src/commands/types.js
// Command definitions: name, args, return type.
// New features must add an entry here — this prevents ad-hoc "patches".

export const COMMAND_TYPES = {
  select_project: {
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
  close_tab: {
    args: { filePath: 'string' },
    returns: 'void',
  },
  switch_tab: {
    args: { filePath: 'string' },
    returns: 'void',
  },
  focus_terminal: {
    args: { tabId: 'string' },
    returns: 'void',
  },
  send_to_terminal: {
    args: { text: 'string', tabId: 'string?' },
    returns: 'void',
  },
  get_focus: {
    args: {},
    returns: 'FocusState',
  },
};
