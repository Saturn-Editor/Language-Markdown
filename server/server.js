import { readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatTables, headingSlugger, headings, referenceDefinitions, splitLines, tableMismatches } from '../lib/markdown.js';

const { version } = JSON.parse(readFileSync(new URL('../saturn-language.json', import.meta.url), 'utf8'));

const CompletionKind = { Text: 1, Reference: 18, File: 17, Folder: 19, Snippet: 15 };

const documents = new Map();
let root = process.cwd();

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const length = Number(/Content-Length: *(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))?.[1]);
    const start = headerEnd + 4;
    if (!Number.isFinite(length)) {
      buffer = buffer.subarray(start);
      continue;
    }
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString('utf8');
    buffer = buffer.subarray(start + length);
    try {
      void dispatch(JSON.parse(body));
    } catch (e) {
      log(`bad message: ${e}`);
    }
  }
});

function send(message) {
  const json = JSON.stringify({ jsonrpc: '2.0', ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}

const log = (message) => process.stderr.write(`[markdown-ls] ${message}\n`);

const handlers = {
  initialize(params) {
    const folder = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
    if (folder) root = toPath(folder);
    else if (params.rootPath) root = params.rootPath;
    return {
      capabilities: {
        textDocumentSync: 1,
        completionProvider: { triggerCharacters: ['(', '/', '#', '['] },
        documentSymbolProvider: true,
        documentFormattingProvider: true,
      },
      serverInfo: { name: 'saturn-markdown', version },
    };
  },
  shutdown: () => null,
  'textDocument/completion': (params) => complete(params),
  'textDocument/documentSymbol': ({ textDocument }) => symbols(textOf(textDocument.uri)),
  'textDocument/formatting': ({ textDocument }) => format(textOf(textDocument.uri)),
};

const notifications = {
  exit: () => process.exit(0),
  'textDocument/didOpen': ({ textDocument }) => update(textDocument.uri, textDocument.text),
  'textDocument/didChange': ({ textDocument, contentChanges }) => {
    const last = contentChanges[contentChanges.length - 1];
    if (last && !last.range) update(textDocument.uri, last.text);
  },
  'textDocument/didClose': ({ textDocument }) => {
    documents.delete(textDocument.uri);
    send({ method: 'textDocument/publishDiagnostics', params: { uri: textDocument.uri, diagnostics: [] } });
  },
};

function update(uri, text) {
  documents.set(uri, text);
  send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: diagnose(text) } });
}

async function dispatch(message) {
  if (message.id === undefined) {
    notifications[message.method]?.(message.params ?? {});
    return;
  }
  const handler = handlers[message.method];
  if (!handler) {
    send({ id: message.id, error: { code: -32601, message: `Unhandled method ${message.method}` } });
    return;
  }
  try {
    send({ id: message.id, result: await handler(message.params ?? {}) });
  } catch (e) {
    send({ id: message.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
  }
}

const toPath = (uri) => (uri.startsWith('file:') ? fileURLToPath(uri) : uri);

/** Saturn replaces the text matching this before the cursor, so insertText must cover exactly that. */
const WORD_BEFORE = /[\w#`[\]-]*$/;

async function complete({ textDocument, position }) {
  const uri = textDocument.uri;
  const text = textOf(uri);
  const lineText = splitLines(text)[position.line] ?? '';
  const before = lineText.slice(0, position.character);
  const word = WORD_BEFORE.exec(before)[0];

  const dest = /\]\(<?([^\s()<>]*)$/.exec(before);
  if (dest) return destinationItems(dest[1], word, toPath(uri), text);

  const ref = /\]\[([^\]]*)$/.exec(before);
  if (ref) return referenceItems(ref[1], word, text);

  if (/^[ \t]*[\w`|-]*$/.test(before)) return snippetItems(before.trimStart(), word);
  return [];
}

function replacing(typed, word, candidate) {
  const kept = typed.slice(0, typed.length - word.length);
  return candidate.startsWith(kept) ? candidate.slice(kept.length) : candidate;
}

async function destinationItems(typed, word, docPath, text) {
  const hash = typed.indexOf('#');
  if (hash !== -1) {
    const target = typed.slice(0, hash);
    let source = text;
    if (target) {
      source = readOrEmpty(join(dirname(docPath), decodeURIComponent(target)));
      if (!source) return [];
    }
    return anchorsOf(source).map(({ slug, title, level }) => {
      const candidate = `${target}#${slug}`;
      return { label: candidate, detail: `${'#'.repeat(level)} ${title}`, insertText: replacing(typed, word, candidate), kind: CompletionKind.Reference };
    });
  }

  const docDir = dirname(docPath);
  const files = await projectFiles();
  const items = files.map((file) => {
    let rel = relative(docDir, file).split(sep).join('/');
    if (!rel.startsWith('.')) rel = rel.includes('/') || !typed.startsWith('./') ? rel : `./${rel}`;
    const candidate = encodeURI(rel);
    return { label: candidate, detail: 'File', insertText: replacing(typed, word, candidate), kind: CompletionKind.File };
  });
  if (!typed) {
    for (const { slug, title, level } of anchorsOf(text)) {
      items.push({ label: `#${slug}`, detail: `${'#'.repeat(level)} ${title}`, insertText: replacing(typed, word, `#${slug}`), kind: CompletionKind.Reference });
    }
  }
  return items;
}

function referenceItems(typed, word, text) {
  const labels = new Set(referenceDefinitions(text).map((def) => def.label));
  return [...labels].map((label) => ({ label, detail: 'Reference', insertText: replacing(typed, word, label), kind: CompletionKind.Reference }));
}

const SNIPPETS = [
  { label: '```', detail: 'Code block', body: '```\n\n```' },
  { label: 'table', detail: 'Table', body: '| Column | Column |\n| ------ | ------ |\n|        |        |' },
  { label: 'task', detail: 'Task list item', body: '- [ ] ' },
  { label: 'details', detail: 'Collapsible section (HTML)', body: '<details>\n<summary>Summary</summary>\n\n</details>' },
  { label: 'link', detail: 'Link', body: '[text](url)' },
  { label: 'image', detail: 'Image', body: '![alt](path)' },
];

function snippetItems(typed, word) {
  if (!word) return [];
  return SNIPPETS.filter((s) => s.label.startsWith(word.toLowerCase()) || s.label.startsWith(typed))
    .map((s) => ({ label: s.label, detail: s.detail, insertText: replacing(typed, word, s.body), kind: CompletionKind.Snippet }));
}

function anchorsOf(text) {
  const slug = headingSlugger();
  return headings(text).map(({ level, text: title }) => ({ level, title, slug: slug(title) }));
}

const SymbolKind = { String: 15 };

function symbols(text) {
  const lines = splitLines(text);
  const end = (line) => ({ line, character: (lines[line] ?? '').length });
  const roots = [];
  const stack = [];
  for (const { level, text: title, line } of headings(text)) {
    while (stack.length && stack[stack.length - 1].level >= level) {
      stack.pop().symbol.range.end = end(line - 2);
    }
    const start = { line: line - 1, character: 0 };
    const symbol = {
      name: title || '(untitled)',
      detail: '#'.repeat(level),
      kind: SymbolKind.String,
      range: { start, end: end(lines.length - 1) },
      selectionRange: { start, end: end(line - 1) },
      children: [],
    };
    (stack.length ? stack[stack.length - 1].symbol.children : roots).push(symbol);
    stack.push({ level, symbol });
  }
  return roots;
}

function format(text) {
  const eol = /\r\n?/.exec(text)?.[0] ?? '\n';
  const lines = splitLines(text);
  return formatTables(text).map(({ start, end, lines: table }) => ({
    range: { start: { line: start, character: 0 }, end: { line: end - 1, character: lines[end - 1].length } },
    newText: table.join(eol),
  }));
}

const Severity = { Warning: 2 };

function diagnose(text) {
  const lines = splitLines(text);
  return tableMismatches(text).map(({ line, header, delimiter }) => ({
    range: { start: { line, character: 0 }, end: { line: line + 1, character: lines[line + 1].length } },
    severity: Severity.Warning,
    source: 'markdown',
    message: `Table header has ${header} column${header === 1 ? '' : 's'} but the delimiter row has ${delimiter}, so it won't render as a table.`,
  }));
}

function textOf(uri) {
  return documents.get(uri) ?? readOrEmpty(toPath(uri));
}

function readOrEmpty(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const SKIP = new Set(['.git', 'node_modules', '.idea', '.vscode', 'dist', 'out', 'build']);
const FILE_LIMIT = 3000;
let fileCache = { at: 0, files: [] };

async function projectFiles() {
  if (Date.now() - fileCache.at < 5000) return fileCache.files;
  const files = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= FILE_LIMIT) return;
      if (e.name.startsWith('.') && e.isDirectory()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await walk(full);
      } else {
        files.push(full);
      }
    }
  };
  await walk(root);
  fileCache = { at: Date.now(), files };
  return files;
}
