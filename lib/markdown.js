/**
 * A small, dependency-free Markdown → HTML renderer (CommonMark-ish plus GFM tables, task lists,
 * strikethrough and bare-URL autolinks). Raw HTML in the source is always escaped, and link/image
 * URLs with unsafe schemes are dropped, so the output is safe to show without a further sanitiser.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'ftp']);

/** Returns the URL if it is relative or uses a safe scheme, otherwise null. */
export function safeUrl(url) {
  const trimmed = url.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (scheme && !SAFE_SCHEMES.has(scheme[1].toLowerCase())) return null;
  return trimmed;
}

/** GitHub-style heading slug. */
export function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Plain heading text: strips inline markup so slugs and outlines read naturally. */
export function plainText(md) {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .trim();
}

// ---- Block patterns ----

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

/** Number of leading lines taken by YAML front matter ("---" … "---" or "..."), or 0. */
function frontMatterLength(lines) {
  if (!/^---[ \t]*$/.test(lines[0] ?? '')) return 0;
  const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)[ \t]*$/.test(line));
  return end === -1 ? 0 : end + 1;
}

/** Lines that end a paragraph without needing a blank line first. */
function interruptsParagraph(line) {
  if (FENCE.test(line) || ATX.test(line) || HR.test(line) || QUOTE.test(line)) return true;
  const list = LIST.exec(line);
  // An ordered list may only interrupt a paragraph when it starts at 1, and empty items never do.
  return !!list && list[3] !== '' && (!/\d/.test(list[2]) || parseInt(list[2], 10) === 1);
}

const normaliseLabel = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase();

const splitRow = (line) => {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
};

/** Expands tabs to the next multiple of four so indentation maths stays simple. */
const expandTabs = (line) => {
  let out = '';
  for (const ch of line) out += ch === '\t' ? ' '.repeat(4 - (out.length % 4)) : ch;
  return out;
};

class Renderer {
  constructor(options) {
    this.options = options;
    this.refs = new Map();
    this.slugs = new Map();
  }

  render(src) {
    const lines = src.replace(/\r\n?/g, '\n').split('\n').map(expandTabs);
    return this.blocks(this.collectRefs(lines.slice(frontMatterLength(lines))), false);
  }

  /** Pulls out link reference definitions (outside fenced code) so links can resolve them. */
  collectRefs(lines) {
    const kept = [];
    let fence = null;
    for (const line of lines) {
      const f = FENCE.exec(line);
      if (fence) {
        if (f && f[2][0] === fence[0] && f[2].length >= fence.length && !f[3]) fence = null;
      } else if (f) {
        fence = f[2];
      } else {
        const def = REF_DEF.exec(line);
        if (def) {
          const label = normaliseLabel(def[1]);
          if (!this.refs.has(label)) this.refs.set(label, { url: def[2], title: def[3] ?? def[4] ?? def[5] });
          continue;
        }
      }
      kept.push(line);
    }
    return kept;
  }

  /** Renders a run of lines as blocks. `tight` renders paragraphs without <p> (tight list items). */
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
          const close = FENCE.exec(lines[i]);
          if (close && close[2][0] === marker[0] && close[2].length >= marker.length && !close[3]) {
            i++;
            break;
          }
          body.push(lines[i].replace(new RegExp(`^ {0,${indent.length}}`), ''));
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
          else if (!interruptsParagraph(lines[i])) body.push(lines[i]); // lazy continuation
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

      if (line.includes('|') && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]) && lines[i + 1].includes('|')) {
        i = this.table(lines, i, out);
        continue;
      }

      // Paragraph, possibly turned into a setext heading by an underline.
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
    const base = slugify(plainText(text)) || 'section';
    const seen = this.slugs.get(base) ?? 0;
    this.slugs.set(base, seen + 1);
    const id = seen ? `${base}-${seen}` : base;
    return `<h${level} id="${escapeHtml(id)}">${this.inline(text)}</h${level}>`;
  }

  /** Parses a list starting at lines[start]; pushes its HTML and returns the next line index. */
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
          body.push(line); // lazy paragraph continuation
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
    const aligns = splitRow(lines[start + 1]).map((cell) =>
      cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : null,
    );
    const cell = (tag, text, col) => {
      const align = aligns[col] ? ` style="text-align:${aligns[col]}"` : '';
      return `<${tag}${align}>${this.inline(text ?? '')}</${tag}>`;
    };
    let i = start + 2;
    const rows = [];
    while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|') && !interruptsParagraph(lines[i])) {
      const cells = splitRow(lines[i]);
      rows.push(`<tr>${header.map((_, c) => cell('td', cells[c], c)).join('')}</tr>`);
      i++;
    }
    const head = `<thead>\n<tr>${header.map((h, c) => cell('th', h, c)).join('')}</tr>\n</thead>`;
    const bodyHtml = rows.length ? `\n<tbody>\n${rows.join('\n')}\n</tbody>` : '';
    out.push(`<table>\n${head}${bodyHtml}\n</table>`);
    return i;
  }

  // ---- Inline ----

  inline(text) {
    const slots = [];
    const hold = (html) => `\u0000${slots.push(html) - 1}\u0000`;
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
        const run = /^`+/.exec(text.slice(i))[0];
        const close = text.indexOf(run, i + run.length);
        // The closing run must be exactly as long as the opening one.
        let end = close;
        while (end !== -1 && text[end + run.length] === '`') end = text.indexOf(run, end + run.length + 1);
        if (end !== -1) {
          let code = text.slice(i + run.length, end).replace(/\n/g, ' ');
          if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
          out += hold(`<code>${escapeHtml(code)}</code>`);
          i = end + run.length;
          continue;
        }
        out += run;
        i += run.length;
        continue;
      }

      if (ch === '<') {
        const auto = /^<((?:https?|ftp|mailto):[^\s<>]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)>/i.exec(text.slice(i));
        if (auto) {
          const href = auto[1].includes(':') ? auto[1] : `mailto:${auto[1]}`;
          out += hold(`<a href="${escapeHtml(href)}">${escapeHtml(auto[1])}</a>`);
          i += auto[0].length;
          continue;
        }
      }

      if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
        const link = this.link(text, i);
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
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<![\w_])__(?=\S)([\s\S]*?\S)__(?![\w_])/g, '<strong>$1</strong>')
      .replace(/(?<![\w*])\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/g, '<em>$1</em>')
      .replace(/(?<![\w_])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\w_])/g, '<em>$1</em>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
      .replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<\u0000]*[^\s<\u0000.,:;"')\]!?])/g, (m, lead, url) => {
        const href = url.startsWith('www.') ? `http://${url}` : url;
        return `${lead}<a href="${href}">${url}</a>`;
      })
      .replace(/ {2,}\n/g, '<br>\n');

    // Slots can nest (a link's text holds its own slots), so restore until none remain.
    while (/\u0000\d+\u0000/.test(out)) out = out.replace(/\u0000(\d+)\u0000/g, (_, n) => slots[Number(n)]);
    return out;
  }

  /** Parses an inline link or image starting at text[start]. Returns { html, end } or null. */
  link(text, start) {
    const image = text[start] === '!';
    const open = image ? start + 1 : start;
    const close = matchBracket(text, open);
    if (close === -1) return null;
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
      const resolved = this.options.image?.(dest.url) ?? safeUrl(dest.url);
      const alt = escapeHtml(plainText(label));
      return { html: resolved ? `<img src="${escapeHtml(resolved)}" alt="${alt}"${title}>` : alt, end: i };
    }
    const href = safeUrl(dest.url);
    const inner = this.inline(label);
    return { html: href === null ? inner : `<a href="${escapeHtml(href)}"${title}>${inner}</a>`, end: i };
  }
}

function matchBracket(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') i++;
    else if (ch === '`') {
      const run = /^`+/.exec(text.slice(i))[0];
      const end = text.indexOf(run, i + run.length);
      if (end !== -1) i = end + run.length - 1;
    } else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return i;
  }
  return -1;
}

/** Parses `url "title")` starting just after the "(". */
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

/**
 * Renders Markdown to HTML.
 * @param {string} src
 * @param {{ image?: (url: string) => string | null }} [options] `image` may rewrite image URLs (e.g. to data URIs).
 */
export function renderMarkdown(src, options = {}) {
  return new Renderer(options).render(src);
}

/** Headings in a document, skipping fenced code: [{ level, text, line }] with 1-based lines. */
export function headings(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const found = [];
  const skip = frontMatterLength(lines);
  let fence = null;
  let prev = null;
  lines.forEach((line, idx) => {
    if (idx < skip) return;
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[2][0] === fence[0] && f[2].length >= fence.length && !f[3]) fence = null;
      prev = null;
      return;
    }
    if (f) {
      fence = f[2];
      prev = null;
      return;
    }
    const atx = ATX.exec(line);
    if (atx) {
      found.push({ level: atx[1].length, text: plainText(atx[2] ?? ''), line: idx + 1 });
      prev = null;
      return;
    }
    const setext = SETEXT.exec(line);
    if (setext && prev !== null) {
      found.push({ level: setext[1][0] === '=' ? 1 : 2, text: plainText(prev), line: idx });
      prev = null;
      return;
    }
    prev = isBlank(line) || LIST.test(line) || QUOTE.test(line) || HR.test(line) ? null : line;
  });
  return found;
}
