'use strict';

const DEFAULT_MAX_PAYLOAD_LENGTH = 2048;

function createTerminalSignalParser(onSignal, options = {}) {
  if (typeof onSignal !== 'function') {
    throw new TypeError('onSignal must be a function');
  }

  const maxPayloadLength = Number.isInteger(options.maxPayloadLength)
    ? Math.max(0, options.maxPayloadLength)
    : DEFAULT_MAX_PAYLOAD_LENGTH;
  let state = 'normal';
  let osc = '';
  let oscPayloadLength = 0;
  let oscTruncated = false;

  function appendOsc(value) {
    oscPayloadLength += value.length;
    const remaining = maxPayloadLength - osc.length;
    if (remaining > 0) osc += value.slice(0, remaining);
    if (value.length > remaining) oscTruncated = true;
  }

  function finishOsc(terminator) {
    const separator = osc.indexOf(';');
    const identifierText = separator === -1 ? osc : osc.slice(0, separator);
    const identifier = /^\d+$/.test(identifierText)
      ? Number(identifierText)
      : null;
    const data = separator === -1 ? '' : osc.slice(separator + 1);

    if (identifier === 9 || identifier === 777) {
      onSignal({
        signal: 'osc',
        identifier,
        data,
        payloadLength: Math.max(0, oscPayloadLength - identifierText.length - (separator === -1 ? 0 : 1)),
        truncated: oscTruncated,
        terminator,
      });
    }

    state = 'normal';
    osc = '';
    oscPayloadLength = 0;
    oscTruncated = false;
  }

  return {
    push(chunk) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      for (const char of text) {
        if (state === 'normal') {
          if (char === '\x07') {
            onSignal({ signal: 'bell' });
          } else if (char === '\x1b') {
            state = 'escape';
          }
          continue;
        }

        if (state === 'escape') {
          if (char === ']') {
            state = 'osc';
          } else {
            state = char === '\x1b' ? 'escape' : 'normal';
          }
          continue;
        }

        if (state === 'osc') {
          if (char === '\x07') {
            finishOsc('BEL');
          } else if (char === '\x1b') {
            state = 'osc_escape';
          } else {
            appendOsc(char);
          }
          continue;
        }

        if (state === 'osc_escape') {
          if (char === '\\') {
            finishOsc('ST');
          } else {
            appendOsc(`\x1b${char}`);
            state = 'osc';
          }
        }
      }
    },
  };
}

module.exports = { createTerminalSignalParser };
