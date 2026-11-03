const fs = require('fs');
const path = require('path');
const m = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE, '.local/share/opencode/mcp-auth.json'), 'utf8'));
const cm = m['context-mixer'];
console.log('top keys:', Object.keys(cm));
const tok = cm.tokens || cm;
console.log('token keys:', Object.keys(tok));
const at = tok.accessToken || tok.access_token;
if (at) {
  fs.writeFileSync(path.join(process.env.TEMP, 'cm-token.txt'), at);
  console.log('accessToken saved to temp, length:', at.length);
} else {
  console.log('no access token found');
}
