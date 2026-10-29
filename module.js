import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown } from './lib/markdown.js';

const here = dirname(fileURLToPath(import.meta.url));
const previewCss = readFileSync(join(here, 'preview.css'), 'utf8');

const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};
const MAX_INLINE_IMAGE = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

const imageCache = new Map();
let cachedBytes = 0;

function forget(file) {
  const entry = imageCache.get(file);
  if (!entry) return;
  cachedBytes -= entry.uri.length;
  imageCache.delete(file);
}

function remember(file, entry) {
  forget(file);
  imageCache.set(file, entry);
  cachedBytes += entry.uri.length;
  for (const oldest of imageCache.keys()) {
    if (cachedBytes <= MAX_CACHE_BYTES) break;
    forget(oldest);
  }
}

const realOrSelf = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const isInside = (dir, file) => {
  const rel = relative(dir, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/**
 * The preview iframe has no access to the project folder, so local images are inlined as data URIs.
 * Only images inside the project are inlined (after resolving symlinks); remote images pass through
 * untouched unless `remote` is off, and anything else is dropped.
 */
function inlineImage(url, docPath, projectRoot, remote) {
  if (/^(https?:)?\/\//i.test(url)) return remote ? url : null;
  if (url.startsWith('data:image/')) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('file:')) return null;
  try {
    const clean = decodeURIComponent(url.replace(/[?#].*$/, ''));
    const file = realpathSync(clean.startsWith('file:') ? fileURLToPath(clean) : resolve(dirname(docPath), clean));
    const type = IMAGE_TYPES[extname(file).toLowerCase()];
    if (!type || !isInside(projectRoot, file)) return null;
    const { mtimeMs, size } = statSync(file);
    const cached = imageCache.get(file);
    if (cached?.mtimeMs === mtimeMs && cached.size === size) {
      remember(file, cached);
      return cached.uri;
    }
    if (size > MAX_INLINE_IMAGE) return null;
    const uri = `data:${type};base64,${readFileSync(file).toString('base64')}`;
    remember(file, { mtimeMs, size, uri });
    return uri;
  } catch {
    return null;
  }
}

async function markdownFiles(saturn, projectPath) {
  const [md, markdown] = await Promise.all([
    saturn.workspace.findFiles(projectPath, '**/*.md'),
    saturn.workspace.findFiles(projectPath, '**/*.markdown'),
  ]);
  return [...md, ...markdown].sort((a, b) => relative(projectPath, a).localeCompare(relative(projectPath, b)));
}

const README = /^readme\.(md|markdown)$/i;

const titleCase = (name) => name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function activate(saturn) {
  saturn.previews.registerRenderer('markdown.preview', (text, ctx) => {
    const docPath = isAbsolute(ctx.path) ? ctx.path : join(ctx.projectPath, ctx.path);
    const projectRoot = realOrSelf(ctx.projectPath);
    const remote = saturn.settings.get('remoteImages') !== false;
    const body = renderMarkdown(text, { image: (url) => inlineImage(url, docPath, projectRoot, remote) });
    return `<style>${previewCss}</style>\n<article class="markdown-body">\n${body}\n</article>`;
  });

  saturn.files.registerTemplate('markdown.readme', {
    fileName: ({ name }) => (/\.[^.]+$/.test(name) ? name : `${name}.md`),
    content: ({ name }) => `# ${titleCase(basename(name, extname(name)))}\n\n`,
  });

  saturn.commands.register('markdown.openReadme', async ({ projectPath }) => {
    const files = await markdownFiles(saturn, projectPath);
    const readme =
      files.find((f) => README.test(relative(projectPath, f))) ?? files.find((f) => README.test(basename(f)));
    if (readme) {
      saturn.workspace.openFile(projectPath, readme);
      return;
    }
    const path = join(projectPath, 'README.md');
    writeFileSync(path, `# ${basename(projectPath)}\n\n`);
    saturn.workspace.openFile(projectPath, path);
  });

  saturn.projects.onCreate(({ projectPath, fields }) => {
    const title = String(fields.title ?? '').trim() || basename(projectPath);
    mkdirSync(projectPath, { recursive: true });
    if (fields.readme !== false) {
      const readme = join(projectPath, 'README.md');
      if (!existsSync(readme)) writeFileSync(readme, `# ${title}\n\n`);
    }
  });
}
