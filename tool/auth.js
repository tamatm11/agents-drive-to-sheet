const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const CRED_PATH = process.env.GDRIVE_CREDENTIALS || 'C:/Users/giaos/.claude/credentials.json';
const TOKEN_PATH = process.env.GDRIVE_TOKEN || 'C:/Users/giaos/.claude/token.json';
let lastSheetsWriteAt = 0;

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableSheetsWriteError(err) {
  const data = err && err.response && err.response.data;
  const text = JSON.stringify(data || {}) + ' ' + (err && err.message || '');
  const status = err && err.response && err.response.status;
  return (
    /quota|rateLimit|WriteRequestsPerMinute|RESOURCE_EXHAUSTED|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(text) ||
    status === 429 ||
    (status >= 500 && status < 600)
  );
}

async function waitForSheetsWriteSlot() {
  const delayMs = parseInt(process.env.SHEETS_WRITE_DELAY_MS || '1100', 10);
  if (!delayMs) return;
  const elapsed = Date.now() - lastSheetsWriteAt;
  if (elapsed < delayMs) await sleep(delayMs - elapsed);
  lastSheetsWriteAt = Date.now();
}

function wrapSheetsWrites(sheets) {
  const maxRetries = parseInt(process.env.SHEETS_WRITE_MAX_RETRIES || '4', 10);
  const retryDelayMs = parseInt(process.env.SHEETS_WRITE_RETRY_DELAY_MS || '65000', 10);
  const wrap = (holder, methodName) => {
    const original = holder[methodName].bind(holder);
    holder[methodName] = async (...args) => {
      for (let attempt = 0; ; attempt++) {
        await waitForSheetsWriteSlot();
        try {
          return await original(...args);
        } catch (err) {
          if (!isRetryableSheetsWriteError(err) || attempt >= maxRetries) throw err;
          const waitMs = retryDelayMs * (attempt + 1);
          console.warn(`Sheets write quota hit; retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})`);
          await sleep(waitMs);
        }
      }
    };
  };
  wrap(sheets.spreadsheets, 'batchUpdate');
  wrap(sheets.spreadsheets.values, 'update');
  return sheets;
}

function getOAuthClient() {
  const cred = loadJson(CRED_PATH);
  const tok = loadJson(TOKEN_PATH);
  const cfg = cred.installed || cred.web;
  const client = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, (cfg.redirect_uris && cfg.redirect_uris[0]) || 'http://localhost');
  client.setCredentials({
    access_token: tok.token || tok.access_token,
    refresh_token: tok.refresh_token,
    expiry_date: tok.expiry ? new Date(tok.expiry).getTime() : undefined,
    scope: (tok.scopes || []).join(' '),
    token_type: 'Bearer',
  });
  client.on('tokens', (t) => {
    const merged = { ...tok };
    if (t.access_token) merged.token = t.access_token;
    if (t.refresh_token) merged.refresh_token = t.refresh_token;
    if (t.expiry_date) merged.expiry = new Date(t.expiry_date).toISOString();
    try { fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2)); } catch (_) {}
  });
  return client;
}

function getClients() {
  const auth = getOAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  return {
    auth,
    drive: google.drive({ version: 'v3', auth }),
    sheets: wrapSheetsWrites(sheets),
  };
}

module.exports = { getClients };
