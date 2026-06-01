const fs = require('fs');
const path = require('path');
const { validateSchema } = require('./utils');

function loadCachedSchema(teacherFolderId) {
  const schemaPath = path.join(__dirname, 'schemas', `${teacherFolderId}.json`);
  if (!fs.existsSync(schemaPath)) return null;

  const payload = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  if (payload && payload.schema) validateSchema(payload.schema);
  return payload;
}

module.exports = { loadCachedSchema };
