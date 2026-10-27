# Markdown for Saturn

A Saturn language for Markdown files (`.md`, `.markdown`).

## Features

- **Syntax colouring** for headings, emphasis, links, code, quotes, lists and tables. Fenced code blocks
  (` ```js `, ` ```python `, …) use that language's colours when a module providing it is installed.
- **Live preview** rendered in your Saturn theme. Raw HTML in the source is shown as text and unsafe
  link schemes are dropped; local images are embedded so they display in the preview.
- **Completion** for link targets (project files and `#heading` anchors), reference link labels, and
  snippets for code blocks, tables and task items.
- **Open README** command, a Markdown file template, and a Markdown project type that can create a
  starter `README.md`.

## Installing

In Saturn, open **Marketplace → Languages → Install from folder…** and choose this folder.
No build or install step is needed; Saturn runs the completion server with its bundled runtime.

Requires Saturn module API `0.1`.

## Layout

| Path | Purpose |
| --- | --- |
| `saturn-language.json` | Manifest: what the language contributes |
| `module.js` | Registers the preview, command, template and project handlers |
| `lib/markdown.js` | Markdown → HTML renderer and heading outline, shared by the module and server |
| `preview.css` | Preview styling, using Saturn's theme variables |
| `grammars/markdown.tmLanguage.json` | TextMate grammar for syntax colouring |
| `server/server.js` | Language server (completion) over stdio |
