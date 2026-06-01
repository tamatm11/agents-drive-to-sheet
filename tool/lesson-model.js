// Pure lesson model shared by render.js and sync-state.js.
// It keeps section folders as sections and materializes file-only lessons such
// as "Theme 10" from files stored directly under a chapter or resource folder.

const crypto = require('crypto');

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function stripExtension(name) {
  return String(name || '').replace(/\.[a-z0-9]{1,8}$/i, '').replace(/\s+/g, ' ').trim();
}

function isVideoFile(file) {
  return !!(file && file.mimeType && String(file.mimeType).startsWith('video/'));
}

function isResourceContainer(node) {
  const n = normalizeName(node && node.name);
  if (!n) return false;
  return /\b(tai lieu|document|documents|docs|pdf|handout|worksheet|bai tap|de bai|tai nguyen|file|files)\b/.test(n);
}

function isSectionFolder(node, depth) {
  const n = normalizeName(node && node.name);
  if (!n) return false;
  if (/^(?:\d+\s*[.)-]?\s*)?(chapter|chuong|chuyen de|chu de)\b/.test(n)) return true;
  if (/^cd\d+\b/.test(n)) return true;
  return depth === 0 && (node.children || []).some(isResourceContainer);
}

function assetKeyFromName(name) {
  const n = normalizeName(stripExtension(name));
  const patterns = [
    ['theme', /\btheme\s*0*(\d{1,3})\b/],
    ['bai', /\b(?:bai|lesson)\s*0*(\d{1,3})\b/],
    ['buoi', /\b(?:buoi|tiet)\s*0*(\d{1,3})\b/],
  ];
  for (const [kind, re] of patterns) {
    const m = re.exec(n);
    if (m) return { key: `${kind}:${parseInt(m[1], 10)}`, kind, num: parseInt(m[1], 10) };
  }
  return null;
}

function fallbackAssetKey(file) {
  const id = file && file.id ? String(file.id) : normalizeName(stripExtension(file && file.name));
  return { key: `file:${id}`, kind: 'file', num: Number.POSITIVE_INFINITY };
}

function withSourceParent(file, parentName) {
  return { ...file, __sourceParentName: parentName || '' };
}

function collectFilesForVirtualLessons(node) {
  const files = [];
  for (const f of node.files || []) files.push(withSourceParent(f, node.name));

  function collectContainer(container) {
    for (const f of container.files || []) files.push(withSourceParent(f, container.name));
    for (const child of container.children || []) collectContainer(child);
  }

  for (const child of node.children || []) {
    if (isResourceContainer(child)) collectContainer(child);
  }
  return files;
}

function chooseDisplayFile(files) {
  return files.find(isVideoFile) || files[0] || null;
}

function latestModifiedFromFiles(files, fallback) {
  let latest = fallback || '';
  for (const f of files || []) {
    if (f.modifiedTime && f.modifiedTime > latest) latest = f.modifiedTime;
  }
  return latest;
}

function buildVirtualLessonsForNode(node, depth) {
  if (!node) return [];
  const files = collectFilesForVirtualLessons(node);
  if (!files.length) return [];

  const groups = new Map();
  for (const file of files) {
    const detected = assetKeyFromName(file.name) || fallbackAssetKey(file);
    if (!groups.has(detected.key)) {
      groups.set(detected.key, {
        key: detected.key,
        kind: detected.kind,
        num: detected.num,
        files: [],
      });
    }
    groups.get(detected.key).files.push(file);
  }

  return [...groups.values()]
    .sort((a, b) => {
      if (a.num !== b.num) return a.num - b.num;
      return a.key.localeCompare(b.key, 'vi');
    })
    .map((group) => {
      const displayFile = chooseDisplayFile(group.files);
      const name = stripExtension(displayFile && displayFile.name) || `${node.name} ${group.key}`;
      return {
        id: `${node.id}::${group.key}`,
        name,
        webViewLink: (displayFile && displayFile.webViewLink) || node.webViewLink,
        modifiedTime: latestModifiedFromFiles(group.files, node.modifiedTime),
        children: [],
        files: group.files,
        virtual: true,
        virtualParentId: node.id,
        virtualParentName: node.name,
        virtualKey: group.key,
        depth: depth + 1,
      };
    });
}

function shouldSplitFolderIntoVirtualLessons(node, depth, virtualLessons) {
  const lessons = virtualLessons || buildVirtualLessonsForNode(node, depth);
  if (!lessons.length) return false;
  if (!isSectionFolder(node, depth) && isConcreteLessonNode(node, depth)) return false;
  if (isSectionFolder(node, depth)) return true;
  if ((node.children || []).some(isResourceContainer) && lessons.length > 1) return true;
  return lessons.filter((l) => /^theme:\d+$/i.test(l.virtualKey || '')).length > 1;
}

function isConcreteLessonNode(node, depth) {
  if (!node || depth < 1) return false;
  const children = node.children || [];
  if (children.length === 0) return true;

  const raw = String(node.name || '').trim();
  const n = normalizeName(raw);
  if (/^tdm[a-z]{2}\d/i.test(raw)) return true;
  if (/^[a-z]{1,6}\d{1,3}(?:[-\u2013\u2014_\s][a-z]?\d+)?\b/i.test(n)) return true;
  return false;
}

function collectAllFiles(node) {
  const files = [];
  function visit(n) {
    for (const f of n.files || []) files.push(f);
    for (const c of n.children || []) visit(c);
  }
  visit(node);
  return files;
}

function computeRenderableLessonChecksum(lessonNode) {
  const files = lessonNode && lessonNode.virtual
    ? (lessonNode.files || [])
    : collectAllFiles(lessonNode || {});
  const latest = latestModifiedFromFiles(files, lessonNode && lessonNode.modifiedTime);
  const sig = files
    .map((f) => `${f.id || ''}:${f.modifiedTime || ''}:${f.name || ''}:${f.mimeType || ''}`)
    .sort()
    .join('|');
  if (!(lessonNode && lessonNode.virtual)) return `${latest || ''}|${files.length}`;
  const hash = crypto.createHash('sha1').update(sig).digest('hex').slice(0, 12);
  return `${latest || ''}|${files.length}|${hash}`;
}

function extractRenderableLessons(courseNode) {
  const out = [];

  function visit(node, depth, parentName) {
    const virtualLessons = buildVirtualLessonsForNode(node, depth);
    const splitVirtual = shouldSplitFolderIntoVirtualLessons(node, depth, virtualLessons);

    if (!splitVirtual && isConcreteLessonNode(node, depth)) {
      out.push({
        id: node.id,
        name: node.name,
        parentName: parentName || '',
        checksum: computeRenderableLessonChecksum(node),
        virtual: false,
      });
      return;
    }

    if (splitVirtual) {
      for (const lesson of virtualLessons) {
        out.push({
          id: lesson.id,
          name: lesson.name,
          parentName: node.name || parentName || '',
          checksum: computeRenderableLessonChecksum(lesson),
          virtual: true,
        });
      }
    }

    for (const child of node.children || []) {
      if (splitVirtual && isResourceContainer(child)) continue;
      visit(child, depth + 1, node.name);
    }
  }

  for (const top of courseNode.children || []) visit(top, 0, courseNode.name);
  return out;
}

module.exports = {
  normalizeName,
  stripExtension,
  isResourceContainer,
  isSectionFolder,
  isConcreteLessonNode,
  buildVirtualLessonsForNode,
  shouldSplitFolderIntoVirtualLessons,
  computeRenderableLessonChecksum,
  extractRenderableLessons,
};
