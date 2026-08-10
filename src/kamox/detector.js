// src/kamox/detector.js
// Phase 3.1: kamox detection — reads kamox.config.json from a project path
// and checks if the kamox server is running on that port.

const fs = require('fs');
const path = require('path');
const http = require('http');

/**
 * Read kamox.config.json from a project directory and return the port.
 * Returns null if not found or no port configured.
 */
function readKamoxPort(projectPath) {
  if (!projectPath) return null;
  const configPath = path.join(projectPath, 'kamox.config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    return config.port || null;
  } catch {
    return null;
  }
}

/**
 * Check if kamox is running on the given port.
 * Calls GET /status and resolves with the status object, or null if not running.
 * Timeout after 2000ms.
 */
function checkKamoxStatus(port) {
  return new Promise((resolve) => {
    if (!port) {
      resolve(null);
      return;
    }

    const req = http.get(
      `http://127.0.0.1:${port}/status`,
      { timeout: 2000 },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.success && parsed.data) {
              resolve(parsed.data);
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

module.exports = { readKamoxPort, checkKamoxStatus };
