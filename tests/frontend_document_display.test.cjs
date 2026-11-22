'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'frontend/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'frontend/styles.css'), 'utf8');

test('document detail separates a short overview from the complete OCR text', () => {
  assert.match(html, /<details class="detail-full-text"><summary>Full extracted text<\/summary><pre id="detail-extracted-text"><\/pre><\/details>/);
  assert.match(app, /\$\('#detail-text'\)\.textContent=d\.overview/);
  assert.match(app, /\$\('#detail-extracted-text'\)\.textContent=d\.text/);
});

test('document text styles preserve Unicode line breaks and wrap without modal overflow', () => {
  assert.match(css, /\.detail-overview p,\.detail-full-text pre\{[^}]*overflow-wrap:anywhere;word-break:normal;white-space:pre-wrap/s);
  assert.match(css, /\.detail-modal\{max-height:min\(92dvh,900px\);overflow-y:auto\}/);
  assert.match(css, /\.detail-full-text pre\{max-height:38dvh;overflow:auto/);
  const indicSample = 'हिंदी જાહેર ગુજરાતી English';
  assert.match(indicSample, /हिंदी/);
  assert.match(indicSample, /ગુજરાતી/);
});
