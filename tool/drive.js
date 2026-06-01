const { withRetry } = require('./utils');

async function listChildren(drive, folderId) {
  const out = [];
  let pageToken;
  do {
    const res = await withRetry(() => drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, webViewLink, videoMediaMetadata, thumbnailLink)',
      pageSize: 1000,
      pageToken,
      orderBy: 'name',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    }), { context: `list children ${folderId}` });
    out.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

async function walk(drive, folderId, { onProgress } = {}) {
  const root = { id: folderId, name: '', children: [], files: [] };
  const stack = [{ node: root, id: folderId, depth: 0 }];
  let folderCount = 0;
  while (stack.length) {
    const cur = stack.pop();
    const kids = await listChildren(drive, cur.id);
    folderCount++;
    if (onProgress) onProgress({ folderCount, depth: cur.depth, name: cur.node.name });
    for (const k of kids) {
      if (k.mimeType === FOLDER_MIME) {
        const sub = { id: k.id, name: k.name, webViewLink: k.webViewLink, modifiedTime: k.modifiedTime, children: [], files: [] };
        cur.node.children.push(sub);
        stack.push({ node: sub, id: k.id, depth: cur.depth + 1 });
      } else {
        cur.node.files.push({
          id: k.id,
          name: k.name,
          mimeType: k.mimeType,
          size: k.size ? Number(k.size) : 0,
          webViewLink: k.webViewLink,
          modifiedTime: k.modifiedTime,
          videoMediaMetadata: k.videoMediaMetadata || null,
        });
      }
    }
  }
  return root;
}

function flattenLeaves(root, opts = {}) {
  const { maxDepth = 99 } = opts;
  const rows = [];
  function walk(node, pathArr) {
    const isLeaf = node.children.length === 0;
    if (isLeaf || pathArr.length >= maxDepth) {
      rows.push({ path: pathArr.slice(), node, files: node.files });
      return;
    }
    for (const c of node.children) {
      walk(c, pathArr.concat([{ id: c.id, name: c.name, webViewLink: c.webViewLink, modifiedTime: c.modifiedTime }]));
    }
  }
  for (const c of root.children) {
    walk(c, [{ id: c.id, name: c.name, webViewLink: c.webViewLink, modifiedTime: c.modifiedTime }]);
  }
  return rows;
}

const VIDEO_MIME_PREFIX = 'video/';
function isVideo(file) {
  if (!file || !file.mimeType) return false;
  return file.mimeType.startsWith(VIDEO_MIME_PREFIX);
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

module.exports = { listChildren, walk, flattenLeaves, FOLDER_MIME, isVideo, formatSize, formatDuration };
