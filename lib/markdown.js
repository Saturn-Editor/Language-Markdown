/**
 * A small, dependency-free Markdown → HTML renderer (CommonMark-ish plus GFM tables, task lists,
 * strikethrough and bare-URL autolinks). Raw HTML in the source is always escaped, and link/image
 * URLs with unsafe schemes are dropped, so the output is safe to show without a further sanitiser.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'ftp']);

export function safeUrl(url) {
  const trimmed = url.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (scheme && !SAFE_SCHEMES.has(scheme[1].toLowerCase())) return null;
  return trimmed;
}

export function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

export function headingSlugger() {
  const seen = new Map();
  return (text) => {
    const base = slugify(text) || 'section';
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

export const splitLines = (src) => src.split(/\r\n?|\n/);

const ZERO_WIDTH = /[\p{Mn}\p{Me}​-‏︀-️]/u;
const WIDE =
  /[\p{Emoji_Presentation}ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]/u;

export function displayWidth(text) {
  let width = 0;
  for (const ch of text) width += ZERO_WIDTH.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1;
  return width;
}

export function plainText(md) {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .trim();
}

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const LIST = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const INDENTED = /^(?: {4}|\t)/;
const REF_DEF = /^ {0,3}\[([^\]]+)\]:[ \t]*<?(\S+?)>?(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/;

const isBlank = (line) => /^[ \t]*$/.test(line);

const closesFence = (match, marker) =>
  !!match && match[2][0] === marker[0] && match[2].length >= marker.length && !match[3];

function fenceTracker() {
  let fence = null;
  return (line) => {
    const f = FENCE.exec(line);
    if (fence) {
      if (closesFence(f, fence)) fence = null;
      return true;
    }
    if (f) fence = f[2];
    return !!f;
  };
}

const leadingSpaces = (line) => /^ */.exec(line)[0].length;

function frontMatterLength(lines) {
  if (!/^---[ \t]*$/.test(lines[0] ?? '')) return 0;
  const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)[ \t]*$/.test(line));
  return end === -1 ? 0 : end + 1;
}

function interruptsParagraph(line) {
  if (FENCE.test(line) || ATX.test(line) || HR.test(line) || QUOTE.test(line)) return true;
  const list = LIST.exec(line);
  // An ordered list may only interrupt a paragraph when it starts at 1, and empty items never do.
  return !!list && list[3] !== '' && (!/\d/.test(list[2]) || parseInt(list[2], 10) === 1);
}

const normaliseLabel = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase();

function refDefinition(line) {
  const def = REF_DEF.exec(line);
  return def && { label: def[1], url: def[2], title: def[3] ?? def[4] ?? def[5] };
}

export function referenceDefinitions(src) {
  const inFence = fenceTracker();
  return splitLines(src).flatMap((line) => (inFence(line) ? [] : refDefinition(line) ?? []));
}

const BACKTICKS = /`+/g;

const runLength = (text, i) => {
  let n = 1;
  while (text[i + n] === '`') n++;
  return n;
};

/**
 * Index just past the backtick run that closes the `run`-long one at `start`, or -1.
 * `missing` remembers run lengths known to have no closer, so repeated scans stay linear.
 */
function codeSpanEnd(text, start, run, missing) {
  if (missing.has(run)) return -1;
  BACKTICKS.lastIndex = start + run;
  for (let m; (m = BACKTICKS.exec(text)); ) if (m[0].length === run) return m.index + run;
  missing.add(run);
  return -1;
}

function scanOutsideCode(text, visit) {
  const missing = new Set();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') i++;
    else if (ch === '`') {
      const run = runLength(text, i);
      const end = codeSpanEnd(text, i, run, missing);
      i = (end === -1 ? i + run : end) - 1;
    } else visit(ch, i);
  }
}

function bracketPairs(text) {
  const pairs = new Map();
  const open = [];
  scanOutsideCode(text, (ch, i) => {
    if (ch === '[') open.push(i);
    else if (ch === ']' && open.length) pairs.set(open.pop(), i);
  });
  return pairs;
}

export function splitRow(line) {
  const cells = [];
  let start = 0;
  scanOutsideCode(line, (ch, i) => {
    if (ch !== '|') return;
    cells.push(line.slice(start, i));
    start = i + 1;
  });
  cells.push(line.slice(start));
  if (cells.length > 1 && !cells[0].trim()) cells.shift();
  if (cells.length > 1 && !cells[cells.length - 1].trim()) cells.pop();
  return cells.map((cell) => cell.trim());
}

const columnAlign = (cell) =>
  cell.length > 1 && cell.startsWith(':') && cell.endsWith(':')
    ? 'center'
    : cell.endsWith(':')
      ? 'right'
      : cell.startsWith(':')
        ? 'left'
        : null;

const looksLikeTable = (lines, i) =>
  lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && TABLE_DELIM.test(lines[i + 1]);

const isTableStart = (lines, i) =>
  looksLikeTable(lines, i) && splitRow(lines[i]).length === splitRow(lines[i + 1]).length;

const isTableRow = (line) => !isBlank(line) && line.includes('|') && !interruptsParagraph(line);

function alignTable(rows) {
  const indent = ' '.repeat(leadingSpaces(rows[0]));
  const cells = rows.map(splitRow);
  const columns = Math.max(...cells.map((row) => row.length));
  const aligns = cells[1].map(columnAlign);
  const widths = Array.from({ length: columns }, (_, c) =>
    Math.max(3, ...cells.map((row, n) => (n === 1 ? 0 : displayWidth(row[c] ?? '')))),
  );
  const pad = (text, c) => {
    const gap = widths[c] - displayWidth(text);
    const left = aligns[c] === 'right' ? gap : aligns[c] === 'center' ? gap >> 1 : 0;
    return ' '.repeat(left) + text + ' '.repeat(gap - left);
  };
  const rule = (c) => {
    const align = aligns[c];
    const start = align === 'left' || align === 'center' ? ':' : '-';
    const end = align === 'right' || align === 'center' ? ':' : '-';
    return start + '-'.repeat(widths[c] - 2) + end;
  };
  return cells.map((row, n) => {
    const out = Array.from({ length: columns }, (_, c) => (n === 1 ? rule(c) : pad(row[c] ?? '', c)));
    return `${indent}| ${out.join(' | ')} |`;
  });
}

export function formatTables(src) {
  const lines = splitLines(src);
  const changed = [];
  for (const i of tableCandidates(lines)) {
    if (!isTableStart(lines, i)) continue;
    let end = i + 2;
    while (end < lines.length && isTableRow(lines[end])) end++;
    const table = lines.slice(i, end);
    const aligned = alignTable(table);
    if (aligned.some((row, n) => row !== table[n])) changed.push({ start: i, end, lines: aligned });
  }
  return changed;
}

function* tableCandidates(lines) {
  const inFence = fenceTracker();
  for (let i = frontMatterLength(lines); i < lines.length; i++) {
    const line = lines[i];
    if (inFence(line) || INDENTED.test(line) || interruptsParagraph(line) || !looksLikeTable(lines, i)) continue;
    yield i;
    i++;
    while (i + 1 < lines.length && isTableRow(lines[i + 1])) i++;
  }
}

export function tableMismatches(src) {
  const lines = splitLines(src);
  const found = [];
  for (const line of tableCandidates(lines)) {
    const header = splitRow(lines[line]).length;
    const delimiter = splitRow(lines[line + 1]).length;
    if (header !== delimiter) found.push({ line, header, delimiter });
  }
  return found;
}

const expandTabs = (line) => {
  let out = '';
  for (const ch of line) out += ch === '\t' ? ' '.repeat(4 - (out.length % 4)) : ch;
  return out;
};

const AUTOLINK = /<((?:https?|ftp|mailto):[^\s<>]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)>/iy;
// Emphasis spans are capped in length so unmatched delimiters can't make a long paragraph quadratic.
const STRONG_STARS = /\*\*(?=\S)([\s\S]{0,1000}?\S)\*\*/g;
const STRONG_UNDERSCORES = /(?<![\w_])__(?=\S)([\s\S]{0,1000}?\S)__(?![\w_])/g;
const EM_STAR = /(?<![\w*])\*(?=[^\s*])([\s\S]{0,1000}?[^\s*])\*(?!\*)/g;
const EM_UNDERSCORE = /(?<![\w_])_(?=[^\s_])([\s\S]{0,1000}?[^\s_])_(?![\w_])/g;
const STRIKE = /~~(?=\S)([\s\S]{0,1000}?\S)~~/g;

class Renderer {
  constructor(options) {
    this.options = options;
    this.refs = new Map();
    this.slug = headingSlugger();
  }

  render(src) {
    // NUL marks placeholder slots in inline(), so it may not appear in the source (CommonMark replaces it too).
    const lines = splitLines(src.replace(/\u0000/g, '�')).map(expandTabs);
    return this.blocks(this.collectRefs(lines.slice(frontMatterLength(lines))), false);
  }

  collectRefs(lines) {
    const inFence = fenceTracker();
    return lines.filter((line) => {
      const def = !inFence(line) && refDefinition(line);
      if (!def) return true;
      const label = normaliseLabel(def.label);
      if (!this.refs.has(label)) this.refs.set(label, def);
      return false;
    });
  }

  blocks(lines, tight) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) {
        i++;
        continue;
      }

      let m;
      if ((m = FENCE.exec(line))) {
        const [, indent, marker, lang] = m;
        const body = [];
        i++;
        while (i < lines.length) {
          if (closesFence(FENCE.exec(lines[i]), marker)) {
            i++;
            break;
          }
          body.push(lines[i].slice(Math.min(indent.length, leadingSpaces(lines[i]))));
          i++;
        }
        const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
        out.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}${body.length ? '\n' : ''}</code></pre>`);
        continue;
      }

      if ((m = ATX.exec(line))) {
        out.push(this.heading(m[1].length, m[2] ?? ''));
        i++;
        continue;
      }

      if (HR.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }

      if (QUOTE.test(line)) {
        const body = [];
        while (i < lines.length && !isBlank(lines[i])) {
          if (QUOTE.test(lines[i])) body.push(lines[i].replace(QUOTE, ''));
          else if (!interruptsParagraph(lines[i])) body.push(lines[i]);
          else break;
          i++;
        }
        out.push(`<blockquote>\n${this.blocks(body, false)}\n</blockquote>`);
        continue;
      }

      if ((m = LIST.exec(line))) {
        i = this.list(lines, i, out);
        continue;
      }

      if (INDENTED.test(line)) {
        const body = [];
        while (i < lines.length && (INDENTED.test(lines[i]) || isBlank(lines[i]))) {
          body.push(lines[i].replace(INDENTED, ''));
          i++;
        }
        while (body.length && isBlank(body[body.length - 1])) body.pop();
        out.push(`<pre><code>${escapeHtml(body.join('\n'))}\n</code></pre>`);
        continue;
      }

      if (isTableStart(lines, i)) {
        i = this.table(lines, i, out);
        continue;
      }

      const para = [line];
      i++;
      let setext = 0;
      while (i < lines.length && !isBlank(lines[i])) {
        const underline = SETEXT.exec(lines[i]);
        if (underline) {
          setext = underline[1][0] === '=' ? 1 : 2;
          i++;
          break;
        }
        if (interruptsParagraph(lines[i])) break;
        para.push(lines[i]);
        i++;
      }
      const text = para.map((l) => l.replace(/^[ \t]+/, '')).join('\n').replace(/[ \t]+$/, '');
      if (setext) out.push(this.heading(setext, text));
      else out.push(tight ? this.inline(text) : `<p>${this.inline(text)}</p>`);
    }
    return out.join('\n');
  }

  heading(level, text) {
    const id = this.slug(plainText(text));
    return `<h${level} id="${escapeHtml(id)}">${this.inline(text)}</h${level}>`;
  }

  list(lines, start, out) {
    const first = LIST.exec(lines[start]);
    const ordered = /\d/.test(first[2]);
    const delimiter = first[2].slice(-1);
    const items = [];
    let loose = false;
    let i = start;

    while (i < lines.length) {
      const m = LIST.exec(lines[i]);
      if (!m || /\d/.test(m[2]) !== ordered || m[2].slice(-1) !== delimiter) break;
      const markerWidth = m[1].length + m[2].length;
      // A marker followed by 5+ spaces starts indented code; content then begins one space in.
      const gap = m[3].length === 0 || m[3].length > 4 ? 1 : m[3].length;
      const contentIndent = markerWidth + gap;
      const body = [lines[i].slice(Math.min(contentIndent, lines[i].length))];
      i++;
      while (i < lines.length) {
        const line = lines[i];
        if (isBlank(line)) {
          body.push('');
          i++;
          continue;
        }
        const indent = line.length - line.trimStart().length;
        if (indent >= contentIndent) {
          body.push(line.slice(contentIndent));
        } else if (!isBlank(body[body.length - 1]) && !interruptsParagraph(line) && !LIST.test(line)) {
          body.push(line);
        } else {
          break;
        }
        i++;
      }
      let trailingBlank = false;
      while (body.length && isBlank(body[body.length - 1])) {
        body.pop();
        trailingBlank = true;
      }
      // Blank lines between items, or between blocks inside an item, make the whole list loose.
      if (trailingBlank && i < lines.length && LIST.test(lines[i])) loose = true;
      if (body.some((l, idx) => isBlank(l) && idx > 0 && idx < body.length - 1)) loose = true;
      items.push(body);
      if (trailingBlank && !(i < lines.length && LIST.test(lines[i]))) break;
    }

    const rendered = items.map((body) => {
      const task = /^\[([ xX])\][ \t]+/.exec(body[0]);
      if (task) body = [body[0].slice(task[0].length), ...body.slice(1)];
      const content = this.blocks(body, !loose);
      if (!task) return `<li>${content}</li>`;
      const checked = task[1] === ' ' ? '' : ' checked';
      return `<li class="task-list-item"><input type="checkbox" disabled${checked}> ${content}</li>`;
    });
    const startNum = ordered ? parseInt(first[2], 10) : 1;
    const open = ordered ? (startNum === 1 ? '<ol>' : `<ol start="${startNum}">`) : '<ul>';
    out.push(`${open}\n${rendered.join('\n')}\n${ordered ? '</ol>' : '</ul>'}`);
    return i;
  }

  table(lines, start, out) {
    const header = splitRow(lines[start]);
    const aligns = splitRow(lines[start + 1]).map(columnAlign);
    const cell = (tag, text, col) => {
      const align = aligns[col] ? ` style="text-align:${aligns[col]}"` : '';
      // GFM unescapes \| in cells before inline parsing, even inside code spans.
      return `<${tag}${align}>${this.inline((text ?? '').replace(/\\\|/g, '|'))}</${tag}>`;
    };
    let i = start + 2;
    const rows = [];
    while (i < lines.length && isTableRow(lines[i])) {
      const cells = splitRow(lines[i]);
      rows.push(`<tr>${header.map((_, c) => cell('td', cells[c], c)).join('')}</tr>`);
      i++;
    }
    const head = `<thead>\n<tr>${header.map((h, c) => cell('th', h, c)).join('')}</tr>\n</thead>`;
    const bodyHtml = rows.length ? `\n<tbody>\n${rows.join('\n')}\n</tbody>` : '';
    out.push(`<table>\n${head}${bodyHtml}\n</table>`);
    return i;
  }

  inline(text) {
    const slots = [];
    const hold = (html) => `\u0000${slots.push(html) - 1}\u0000`;
    const missing = new Set();
    let pairs = null;
    let out = '';
    let i = 0;

    while (i < text.length) {
      const ch = text[i];

      if (ch === '\\' && i + 1 < text.length) {
        const next = text[i + 1];
        if (next === '\n') {
          out += hold('<br>\n');
          i += 2;
          continue;
        }
        if (/[!-/:-@[-`{-~]/.test(next)) {
          out += hold(escapeHtml(next));
          i += 2;
          continue;
        }
      }

      if (ch === '`') {
        const run = runLength(text, i);
        const end = codeSpanEnd(text, i, run, missing);
        if (end !== -1) {
          let code = text.slice(i + run, end - run).replace(/\n/g, ' ');
          if (code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
          out += hold(`<code>${escapeHtml(code)}</code>`);
          i = end;
          continue;
        }
        out += '`'.repeat(run);
        i += run;
        continue;
      }

      if (ch === '<') {
        AUTOLINK.lastIndex = i;
        const auto = AUTOLINK.exec(text);
        if (auto) {
          const href = auto[1].includes(':') ? auto[1] : `mailto:${auto[1]}`;
          out += hold(`<a href="${escapeHtml(href)}">${escapeHtml(auto[1])}</a>`);
          i += auto[0].length;
          continue;
        }
      }

      if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
        pairs ??= bracketPairs(text);
        const link = this.link(text, i, pairs);
        if (link) {
          out += hold(link.html);
          i = link.end;
          continue;
        }
      }

      out += ch;
      i++;
    }

    out = escapeHtml(out)
      .replace(STRONG_STARS, '<strong>$1</strong>')
      .replace(STRONG_UNDERSCORES, '<strong>$1</strong>')
      .replace(EM_STAR, '<em>$1</em>')
      .replace(EM_UNDERSCORE, '<em>$1</em>')
      .replace(STRIKE, '<del>$1</del>')
      .replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<\u0000]*[^\s<\u0000.,:;"')\]!?])/g, (m, lead, url) => {
        const href = url.startsWith('www.') ? `http://${url}` : url;
        return `${lead}<a href="${href}">${url}</a>`;
      })
      .replace(/ {2,}\n/g, '<br>\n');

    // Slots can nest (a link's text holds its own slots), so restore until none remain.
    while (/\u0000\d+\u0000/.test(out)) out = out.replace(/\u0000(\d+)\u0000/g, (_, n) => slots[Number(n)]);
    return out;
  }

  link(text, start, pairs) {
    const image = text[start] === '!';
    const open = image ? start + 1 : start;
    const close = pairs.get(open);
    if (close === undefined) return null;
    const label = text.slice(open + 1, close);
    let i = close + 1;
    let dest = null;

    if (text[i] === '(') {
      const parsed = parseDestination(text, i + 1);
      if (!parsed) return null;
      dest = { url: parsed.url, title: parsed.title };
      i = parsed.end;
    } else {
      let refLabel = label;
      if (text[i] === '[') {
        const refClose = text.indexOf(']', i + 1);
        if (refClose !== -1) {
          const explicit = text.slice(i + 1, refClose);
          if (explicit.trim()) refLabel = explicit;
          i = refClose + 1;
        }
      }
      const ref = this.refs.get(normaliseLabel(refLabel));
      if (!ref) return null;
      dest = ref;
    }

    const title = dest.title ? ` title="${escapeHtml(dest.title)}"` : '';
    if (image) {
      const resolved = this.options.image ? this.options.image(dest.url) : safeUrl(dest.url);
      const alt = escapeHtml(plainText(label));
      return { html: resolved ? `<img src="${escapeHtml(resolved)}" alt="${alt}"${title}>` : alt, end: i };
    }
    const href = safeUrl(dest.url);
    const inner = this.inline(label);
    return { html: href === null ? inner : `<a href="${escapeHtml(href)}"${title}>${inner}</a>`, end: i };
  }
}

function parseDestination(text, start) {
  let i = start;
  while (text[i] === ' ' || text[i] === '\n') i++;
  let url = '';
  if (text[i] === '<') {
    const end = text.indexOf('>', i);
    if (end === -1) return null;
    url = text.slice(i + 1, end);
    i = end + 1;
  } else {
    let depth = 0;
    while (i < text.length && !/\s/.test(text[i])) {
      if (text[i] === '\\' && i + 1 < text.length) {
        url += text[i + 1];
        i += 2;
        continue;
      }
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && depth-- === 0) break;
      url += text[i];
      i++;
    }
  }
  while (text[i] === ' ' || text[i] === '\n') i++;
  let title;
  const quote = text[i];
  if (quote === '"' || quote === "'" || quote === '(') {
    const closer = quote === '(' ? ')' : quote;
    const end = text.indexOf(closer, i + 1);
    if (end === -1) return null;
    title = text.slice(i + 1, end);
    i = end + 1;
    while (text[i] === ' ' || text[i] === '\n') i++;
  }
  if (text[i] !== ')') return null;
  return { url, title, end: i + 1 };
}

export function renderMarkdown(src, options = {}) {
  return new Renderer(options).render(src);
}

export function headings(src) {
  const lines = splitLines(src);
  const found = [];
  const inFence = fenceTracker();
  let prev = null;
  for (let idx = frontMatterLength(lines); idx < lines.length; idx++) {
    const line = lines[idx];
    if (inFence(line)) {
      prev = null;
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      found.push({ level: atx[1].length, text: plainText(atx[2] ?? ''), line: idx + 1 });
      prev = null;
      continue;
    }
    const setext = SETEXT.exec(line);
    if (setext && prev !== null) {
      found.push({ level: setext[1][0] === '=' ? 1 : 2, text: plainText(prev), line: idx });
      prev = null;
      continue;
    }
    prev = isBlank(line) || LIST.test(line) || QUOTE.test(line) || HR.test(line) ? null : line;
  }
  return found;
}
