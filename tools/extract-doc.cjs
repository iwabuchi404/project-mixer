const fs = require('fs');
const p = process.env.TEMP + '/multipane-doc.md';
const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
fs.writeFileSync(p, obj.content, 'utf8');
console.log('extracted, length:', obj.content.length);
