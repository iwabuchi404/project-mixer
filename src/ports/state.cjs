const fs = require('fs');
const path = require('path');

function buildPortRecord({ hookPort, mcpPort, profile, pid }) {
  const record = { profile, pid };
  if (hookPort !== null && hookPort !== undefined) {
    record.port = hookPort;
  }
  if (mcpPort !== null && mcpPort !== undefined) {
    record.mcpPort = mcpPort;
    record.mcpPid = pid;
  }
  return record;
}

function writeTextAtomic(file, contents, encoding = 'utf-8') {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const existingMode = fs.existsSync(file) ? fs.statSync(file).mode : null;
  const tempFile = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tempFile, contents, { encoding, mode: existingMode ?? 0o666 });
    if (existingMode !== null) fs.chmodSync(tempFile, existingMode);
    fs.renameSync(tempFile, file);
  } finally {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}

function writeJsonAtomic(file, data) {
  writeTextAtomic(file, JSON.stringify(data, null, 2), 'utf-8');
}

module.exports = { buildPortRecord, writeJsonAtomic, writeTextAtomic };
