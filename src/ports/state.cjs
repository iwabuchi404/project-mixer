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

function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tempFile = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tempFile, file);
  } finally {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}

module.exports = { buildPortRecord, writeJsonAtomic };
