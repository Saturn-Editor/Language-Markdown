import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
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

/**
 * The preview iframe has no access to the project folder, so local images are inlined as data URIs.
 * Remote images pass through untouched; anything else unreadable is dropped.
 */
function inlineImage(url, docPath) {
  if (/^(https?:)?\/\//i.test(url) || url.startsWith('data:image/')) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('file:')) return null;
  try {
    const clean = decodeURIComponent(url.replace(/[?#].*$/, ''));
    const file = clean.startsWith('file:') ? fileURLToPath(clean) : resolve(dirname(docPath), clean);
    const type = IMAGE_TYPES[extname(file).toLowerCase()];
    if (!type || statSync(file).size > MAX_INLINE_IMAGE) return null;
    return `data:${type};base64,${readFileSync(file).toString('base64')}`;
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

const titleCase = (name) => name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function activate(saturn) {
  saturn.previews.registerRenderer('markdown.preview', (text, ctx) => {
    const docPath = isAbsolute(ctx.path) ? ctx.path : join(ctx.projectPath, ctx.path);
    const body = renderMarkdown(text, { image: (url) => inlineImage(url, docPath) });
    return `<style>${previewCss}</style>\n<article class="markdown-body">\n${body}\n</article>`;
  });

  saturn.files.registerTemplate('markdown.readme', {
    fileName: ({ name }) => (/\.[^.]+$/.test(name) ? name : `${name}.md`),
    content: ({ name }) => `# ${titleCase(basename(name, extname(name)))}\n\n`,
  });

  saturn.commands.register('markdown.openReadme', async ({ projectPath }) => {
    const files = await markdownFiles(saturn, projectPath);
    const readme =
      files.find((f) => /^readme\.(md|markdown)$/i.test(relative(projectPath, f))) ??
      files.find((f) => /^readme\.(md|markdown)$/i.test(basename(f)));
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
