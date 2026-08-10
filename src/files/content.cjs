'use strict';

function isProbablyBinary(buffer) {
  if (!buffer || buffer.length === 0) return false;

  const sampleLength = Math.min(buffer.length, 8192);
  let controlBytes = 0;

  for (let index = 0; index < sampleLength; index++) {
    const byte = buffer[index];
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) controlBytes++;
  }

  return controlBytes / sampleLength > 0.1;
}

module.exports = { isProbablyBinary };
