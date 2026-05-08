/* ============================================================
   Porter × Tumi — Editor Script
   Three ways to enable edit mode:
     1. Add #edit to URL (works on initial load AND when added later)
     2. Press Cmd/Ctrl + E to toggle
     3. Type the word "edit" anywhere on the page

   Save model:
     - Edits live-save to localStorage as you type. Per-page key with version + structural
       fingerprint so a later HTML rebuild doesn't get hijacked by stale cached state.
     - "Save to file" writes the current DOM (with edit artifacts stripped) back to the
       real .html file on disk via the File System Access API. First click prompts for the
       project folder; subsequent saves in the same tab reuse the directory handle.
     - On browsers without showDirectoryPicker (Safari, Firefox), Save to file falls back
       to a download — drop the file into the repo manually.
   ============================================================ */

(function () {
  // Bumping STORAGE_VERSION invalidates any cached state from older builds. Don't bump
  // casually — current users have edits saved under v1 and bumping wipes them.
  const STORAGE_VERSION = 'v1';
  const STORAGE_KEY = 'porter-mockup:' + STORAGE_VERSION + ':' + (location.pathname.split('/').pop() || 'index.html');
  let edited = false;
  let initialized = false;
  // Directory handle for File System Access API. Per-tab; not persisted across reloads
  // (the API doesn't expose handles across reloads without IndexedDB indirection).
  let dirHandle = null;

  function isEditUrl() {
    return location.hash === '#edit' || location.search.indexOf('edit=1') !== -1;
  }

  function structuralFingerprint(root) {
    // A minimal signature of the page's structural skeleton. If this differs between
    // a saved state and the current HTML, the saved state was made against a different
    // build of the page and applying it would silently overwrite new structural changes.
    // Note: vocabulary intentionally kept loose (img-swap, button, h*) plus a couple of
    // legacy zero-counts so existing v1 caches keep matching.
    if (!root) return '';
    return [
      root.querySelectorAll('.img-swap').length,
      root.querySelectorAll('.veh-card').length,    // legacy — always 0 on Tumi, kept to preserve v1 cache compatibility
      root.querySelectorAll('.thing-card').length,  // legacy — always 0 on Tumi
      root.querySelectorAll('.badge-card').length,  // legacy — always 0 on Tumi
      root.querySelectorAll('button').length,
      root.querySelectorAll('h1,h2,h3,h4').length
    ].join('-');
  }

  function saveState() {
    const stage = document.querySelector('.mockup-stage');
    if (!stage) return;
    try {
      const payload = JSON.stringify({
        fp: structuralFingerprint(stage),
        html: stage.innerHTML
      });
      localStorage.setItem(STORAGE_KEY, payload);
    } catch (e) {}
  }

  function restoreState() {
    const stage = document.querySelector('.mockup-stage');
    if (!stage) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      // Backwards-compat: old saves were raw HTML strings, not JSON. Treat those as stale.
      if (raw[0] !== '{') {
        localStorage.removeItem(STORAGE_KEY);
        return;
      }
      const data = JSON.parse(raw);
      const currentFp = structuralFingerprint(stage);
      if (data.fp !== currentFp) {
        console.warn('Porter editor: skipping restore — saved state predates a page update.');
        return;
      }
      stage.innerHTML = data.html;
    } catch (e) {}
  }

  function stripEditAttributes(root) {
    if (!root) return;
    // Only strip true edit artifacts. Do NOT remove the .img-swap class — that's part of
    // the page's source markup, and removing it makes recovery impossible if the user enters
    // edit mode without a full page reload (e.g. adds #edit to the URL on an already-open
    // page, where the browser fires hashchange but doesn't refetch the HTML).
    root.querySelectorAll('[contenteditable]').forEach(el => {
      el.removeAttribute('contenteditable');
      el.removeAttribute('spellcheck');
    });
  }

  function applyEditable() {
    // Selectors target .tumi-mock (matches the actual mock containers used across all 12
    // pages). The applyImageSwap step that runs after this sets contenteditable="false"
    // on .img-swap targets and their children, so image-swap clicks aren't hijacked by
    // parent text-edit handling.
    const sel = [
      '.tumi-mock h1, .tumi-mock h2, .tumi-mock h3, .tumi-mock h4, .tumi-mock h5, .tumi-mock h6',
      '.tumi-mock p',
      '.tumi-mock span:not(.dot):not(.pin):not(.icon-cart)',
      '.tumi-mock b', '.tumi-mock strong', '.tumi-mock small', '.tumi-mock em',
      '.tumi-mock a',
      '.tumi-mock label', '.tumi-mock td', '.tumi-mock li',
      // Tumi-specific text-bearing classes
      '.tumi-mock .ask-porter', '.tumi-mock .porter-tag', '.tumi-mock .porter-ahead',
      '.tumi-mock .chip',
      '.tumi-mock .btn, .tumi-mock .btn-outline, .tumi-mock .btn-ghost, .tumi-mock .add-btn',
      '.tumi-mock .badge', '.tumi-mock .pill',
      '.tumi-mock .product-line', '.tumi-mock .product-name', '.tumi-mock .product-specs', '.tumi-mock .product-price',
      '.tumi-mock .name', '.tumi-mock .price', '.tumi-mock .specs', '.tumi-mock .desc',
      '.tumi-mock .num', '.tumi-mock .label',
      '.tumi-mock .when', '.tumi-mock .ed', '.tumi-mock .countdown', '.tumi-mock .countdown-label',
      '.tumi-mock .yr',
      '.tumi-mock .qty', '.tumi-mock .save',
      '.tumi-mock .from', '.tumi-mock .body-text', '.tumi-mock .signature',
      '.tumi-mock .section-eyebrow', '.tumi-mock .lede',
      '.tumi-mock .miles', '.tumi-mock .where', '.tumi-mock .date',
      '.tumi-mock .amount', '.tumi-mock .savings',
      '.tumi-mock .tumi-account',
      '.tumi-mock .tumi-nav-items',
      '.tumi-mock .porter-input',
      '.mockup-caption'
    ];
    document.querySelectorAll(sel.join(',')).forEach(el => {
      el.setAttribute('contenteditable', 'true');
      el.setAttribute('spellcheck', 'false');
    });
  }

  function applyImageSwap() {
    // Step 1: mark every swap target as explicitly NOT contenteditable. Without this, Safari
    // (and some other browsers) swallow clicks because the parent .tumi-mock subtree may
    // have inherited contenteditable from a wider selector — children inherit edit behavior
    // and place a text cursor instead of firing the click handler.
    document.querySelectorAll('.tumi-mock img, .tumi-mock .img-swap').forEach(target => {
      target.classList.add('img-swap');
      target.setAttribute('contenteditable', 'false');
    });

    // Step 2: also mark children of .img-swap (like SVG paths, inline gradient labels)
    // non-editable, otherwise clicks on those children focus them for text-edit instead
    // of bubbling to the swap handler.
    document.querySelectorAll('.tumi-mock .img-swap *').forEach(child => {
      child.setAttribute('contenteditable', 'false');
    });

    // Step 3: ONE event-delegation handler at the stage level. Clicking anywhere inside
    // an .img-swap subtree resolves to its nearest .img-swap ancestor and triggers the
    // file picker. Robust across browsers, survives DOM changes from contenteditable typing.
    const stage = document.querySelector('.mockup-stage');
    if (!stage || stage.dataset.swapBound) return;
    stage.dataset.swapBound = '1';
    stage.addEventListener('click', function (e) {
      const target = e.target.closest('.img-swap');
      if (!target) return;
      if (!document.body.classList.contains('edit-mode')) return;
      e.preventDefault();
      e.stopPropagation();
      triggerImageUpload(target);
    }, true);  // capture phase — intercepts before any contenteditable focus handling
  }

  function triggerImageUpload(target) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = function () {
      const f = input.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = function (ev) {
        if (target.tagName === 'IMG') {
          target.src = ev.target.result;
        } else {
          // Replace the placeholder SVG/content with the chosen image as a background
          target.style.backgroundImage = 'url("' + ev.target.result + '")';
          target.style.backgroundSize = 'cover';
          target.style.backgroundPosition = 'center';
        }
        saveState();
      };
      r.readAsDataURL(f);
    };
    input.click();
  }

  /* ============================================================
     SAVE TO FILE — writes the current DOM back to the real .html file
     ============================================================ */

  function buildSaveableHtml() {
    // Clone the document and strip everything that's runtime-only (toolbar, edit attrs).
    // Crucially: KEEP the <link rel="stylesheet"> and <script src="editor.js"> intact so
    // the saved file remains part of the multi-file deck — DON'T inline anything.
    const clone = document.documentElement.cloneNode(true);

    const bar = clone.querySelector('.editor-bar');
    if (bar) bar.remove();

    clone.querySelectorAll('[contenteditable]').forEach(el => {
      el.removeAttribute('contenteditable');
      el.removeAttribute('spellcheck');
    });

    const cloneBody = clone.querySelector('body');
    if (cloneBody) cloneBody.classList.remove('edit-mode');

    // Note: we KEEP the .img-swap classes (they're structural markers in the source),
    // KEEP <script src="editor.js"></script> (the saved file still loads the editor),
    // KEEP <link rel="stylesheet" href="styles.css"> (don't inline — file is part of a deck).

    return '<!DOCTYPE html>\n' + clone.outerHTML;
  }

  async function saveToFile() {
    const filename = location.pathname.split('/').pop() || 'index.html';
    const html = buildSaveableHtml();

    if (window.showDirectoryPicker) {
      try {
        if (!dirHandle) {
          showStatus('select your porter-mockups folder…', 'info');
          dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        }
        const fileHandle = await dirHandle.getFileHandle(filename);
        const writable = await fileHandle.createWritable();
        await writable.write(html);
        await writable.close();
        showStatus('saved → ' + filename, 'success');
        return;
      } catch (e) {
        if (e.name === 'AbortError') {
          showStatus('save cancelled', 'warn');
          return;
        }
        if (e.name === 'NotFoundError') {
          // User picked a folder that doesn't contain this file — clear handle and re-prompt
          dirHandle = null;
          showStatus(filename + ' not in that folder — click Save again', 'warn');
          return;
        }
        if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
          dirHandle = null;
          showStatus('permission denied — click Save again to retry', 'warn');
          return;
        }
        console.error('Save to file failed:', e);
        showStatus('save failed — downloading instead', 'warn');
        // fall through to download
      }
    } else {
      showStatus('Chrome/Edge needed for direct save — downloading instead', 'warn');
    }

    // Fallback: trigger a download. User drops the file into the repo manually.
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function showStatus(msg, kind) {
    const status = document.querySelector('.editor-bar .status');
    if (!status) return;
    status.textContent = msg;
    status.dataset.kind = kind || 'info';
    clearTimeout(showStatus._t);
    showStatus._t = setTimeout(() => {
      status.textContent = '';
      delete status.dataset.kind;
    }, 4500);
  }

  /* ============================================================
     TOOLBAR
     ============================================================ */

  function injectToolbar() {
    if (document.querySelector('.editor-bar')) return;
    const bar = document.createElement('div');
    bar.className = 'editor-bar';
    bar.innerHTML =
      '<a class="back" href="index.html">← All mockups</a>' +
      '<span class="title">' + document.title.replace(/^Porter — /, '') + '</span>' +
      '<span class="status" aria-live="polite"></span>' +
      '<span class="spacer"></span>' +
      '<button id="toggle-edit" type="button">Edit: ON</button>' +
      '<button id="reset-edits" type="button">Reset</button>' +
      '<button class="primary" id="save-to-file" type="button">Save to file</button>' +
      '<span class="hint">Click any text or image to edit · ⌘E to toggle · Save writes to disk</span>';
    document.body.insertBefore(bar, document.body.firstChild);
    document.getElementById('toggle-edit').addEventListener('click', toggleEditMode);
    document.getElementById('reset-edits').addEventListener('click', resetEdits);
    document.getElementById('save-to-file').addEventListener('click', saveToFile);
  }

  function enableEditMode() {
    if (edited) return;
    edited = true;
    restoreState();
    document.body.classList.add('edit-mode');
    injectToolbar();
    applyEditable();
    applyImageSwap();
  }

  function toggleEditMode() {
    if (!edited) {
      enableEditMode();
      return;
    }
    document.body.classList.toggle('edit-mode');
    const btn = document.getElementById('toggle-edit');
    if (btn) btn.textContent = document.body.classList.contains('edit-mode')
      ? 'Edit: ON' : 'Edit: OFF';
  }

  function resetEdits() {
    if (!confirm('Reset this page to the version on disk? Unsaved edits in this browser will be lost.')) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    location.reload();
  }

  function init() {
    if (initialized) return;
    initialized = true;
    // Only restore saved edits when entering edit mode. Auto-restoring on every page load
    // is a footgun: stale cache silently replaces new content for view-only visitors.
    if (isEditUrl()) {
      restoreState();
      enableEditMode();
    } else {
      stripEditAttributes(document.querySelector('.mockup-stage'));
    }
    document.addEventListener('input', function (e) {
      if (e.target.closest && e.target.closest('.mockup-stage')) saveState();
    });
  }

  // Entry point 1: initial page load with #edit
  document.addEventListener('DOMContentLoaded', init);

  // Entry point 2: hash CHANGED after load
  window.addEventListener('hashchange', function () {
    if (isEditUrl()) enableEditMode();
  });

  // Entry point 3: Cmd/Ctrl + E
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'e' || e.key === 'E')) {
      const t = e.target;
      const isField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (isField && edited) return;
      e.preventDefault();
      toggleEditMode();
    }
  });

  // Entry point 4: type "edit" anywhere on the page
  let typed = '';
  document.addEventListener('keydown', function (e) {
    const t = e.target;
    const isField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (isField) return;
    if (e.key && e.key.length === 1) {
      typed = (typed + e.key.toLowerCase()).slice(-4);
      if (typed === 'edit') { typed = ''; if (!edited) enableEditMode(); }
    }
  });

  console.log('%cPorter editor', 'color:#1a1a1a;font-weight:700;background:#fff;padding:2px 6px',
    'enable with #edit in URL, ⌘E, or type "edit" · Save to file writes the .html on disk');
})();
