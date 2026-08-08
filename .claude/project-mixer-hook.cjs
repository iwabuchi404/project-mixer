#!/usr/bin/env node
// Project Mixer hook - sends notification to local HTTP server
const http = require('http');
const path = require('path');

const payload = JSON.stringify({
  hook_event_type: process.argv[2] || 'Notification',
  cwd: process.cwd(),
});

const req = http.request({
  hostname: '127.0.0.1',
  port: 47832,
  path: '/hook',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
}, () => { process.exit(0); });
req.on('error', () => { process.exit(0); });
req.write(payload);
req.end();
