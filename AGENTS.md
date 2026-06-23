# AGENTS.md

## Project Overview

This project is the MyLibriBooks EPUB Reader.

Production:
- https://reada.mylibribooks.com

Parent Application:
- https://mylibribooks.com

The reader is embedded inside MyLibriBooks using an iframe.

The reader is responsible for:

- Opening EPUB books
- Navigation
- Search
- Themes
- Reading position tracking
- Text-to-Speech
- Reader preferences


---

## Core Technologies

- epub.js
- EasySpeech.js
- HTML
- CSS
- Vanilla JavaScript

Do not introduce:

- React
- Angular
- Vue
- TypeScript
- Vite
- Webpack

unless explicitly requested.

---

## Architectural Rules

index.html
- UI structure only

style.css
- Reader styling only

script.js
- Reader application logic
- EPUB rendering
- Navigation
- Search
- Settings

speech.js
- Speech synthesis only
- Voice selection
- Pause / Resume
- Stop

---

## Protected Files

These files are considered vendor files.

Do not modify unless absolutely necessary.

libs/epub.js
libs/jszip.min.js
libs/sanitize-html.min.js

If a bug exists in epub.js:

1. Explain the issue.
2. Explain why a wrapper cannot solve it.
3. Then propose a minimal patch.

---

## Existing epub.js Patch

The project contains:

libs/epub.js
libs/epub.orig.js

The modified version contains fixes required for some EPUB files.

Before changing epub.js:

- Compare against epub.orig.js
- Preserve existing custom fixes

---

## iframe Integration

The reader runs inside an iframe in the parent application

Never remove iframe compatibility.

Any communication with the parent application must use:

window.parent.postMessage()

Do not directly assume access to parent application state.

---

## Feature Development Rules

Before implementing a feature:

1. Explain proposed approach.
2. List files affected.
3. Identify risks.
4. Make smallest possible change.

Avoid large refactors.

Prefer extending existing code.

---

## Testing Checklist

After every change verify:

□ EPUB opens
□ Search works
□ Next page works
□ Previous page works
□ Location restore works
□ Theme switching works
□ Speech works
□ Speech pause works
□ Speech resume works
□ Mobile layout works
□ iframe embedding still works

---

## Goal

Maintain a stable EPUB reading experience while minimizing architectural changes.

The project contains a customized epub.js build. Before editing libs/epub.js, read docs/KNOWN_EPUBJS_CUSTOMIZATIONS.md.