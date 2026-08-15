'use strict';

function emit(message) {
  process.stdout.write(`\x07\x1b]9;${message}\x07\x1b]777;notify;Devin;${message}\x07`);
}

// Real TUIs enable focus reporting. When their tab receives focus, xterm
// writes ESC [ I through onData even though the user has not typed anything.
process.stdout.write('\x1b[?1004h');

setTimeout(() => emit('Devin needs input'), 1000);
setTimeout(() => emit('Devin finished'), 3500);
setTimeout(() => process.exit(0), 5000);
