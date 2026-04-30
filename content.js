// WhatPulse Website Tracking - Content Script
// Captures input events (keystrokes, clicks, scroll, mouse movement, words) and reports to background script

(function () {
  'use strict';

  // Accumulate input events, send to background every 5 seconds
  let inputStats = { keys: 0, clicks: 0, scrolls: 0, mouseDistanceIn: 0, words: 0 };
  let lastMousePos = null;

  // Get device DPI for pixel-to-inch conversion (default 96 DPI)
  const dpi = window.devicePixelRatio * 96;

  // --- Word tokenizer (ported from WhatPulse desktop WordTokenizer) ---
  // Commits current in-progress token as one word on delimiter / focus loss /
  // IME finalize / idle timeout. Letters & digits (ASCII + common Unicode
  // ranges) are word-forming; whitespace/punctuation delimits; Backspace
  // shrinks the current token; modifiers and function keys are ignorable.
  const IDLE_COMMIT_MS = 1500;

  const IGNORABLE_KEYS = new Set([
    'Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock',
    'NumLock', 'ScrollLock', 'Escape', 'PrintScreen', 'Pause',
    'Home', 'End', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
    'PageUp', 'PageDown', 'Insert', 'ContextMenu', 'Process',
    'MediaPlayPause', 'MediaStop', 'MediaTrackNext', 'MediaTrackPrevious',
    'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute',
    'Dead', 'Unidentified'
  ]);

  const tokenizer = {
    currentTokenLength: 0,
    lastActivity: Date.now(),
  };

  function classifyKey(key) {
    if (key === 'Backspace' || key === 'Delete') return 'backspace';
    if (IGNORABLE_KEYS.has(key)) return 'ignorable';
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return 'ignorable';
    if (key === "'" || key === '\u2019') return 'apostrophe';
    if (key.length === 1) {
      if (/^[\p{L}\p{N}]$/u.test(key)) return 'wordforming';
      return 'delimiter';
    }
    // Multi-char named keys not matched above: conservative delimiter
    return 'unknown';
  }

  function commitToken() {
    if (tokenizer.currentTokenLength === 0) return;
    inputStats.words++;
    tokenizer.currentTokenLength = 0;
  }

  function checkIdleTimeout() {
    if (tokenizer.currentTokenLength === 0) return;
    if (Date.now() - tokenizer.lastActivity >= IDLE_COMMIT_MS) {
      commitToken();
    }
  }

  function touchActivity() {
    tokenizer.lastActivity = Date.now();
  }

  function processKey(event) {
    // Ignore IME-composing keydowns; compositionend handles IME text.
    if (event.isComposing || event.keyCode === 229) return;
    // Shortcut combos (Ctrl+A, Cmd+C, etc.) are not typing.
    if (event.ctrlKey || event.metaKey) return;

    checkIdleTimeout();

    let cls = classifyKey(event.key);
    if (cls === 'apostrophe') {
      cls = tokenizer.currentTokenLength > 0 ? 'wordforming' : 'delimiter';
    }

    switch (cls) {
      case 'wordforming':
        tokenizer.currentTokenLength++;
        touchActivity();
        break;
      case 'delimiter':
      case 'unknown':
        if (tokenizer.currentTokenLength > 0) commitToken();
        touchActivity();
        break;
      case 'backspace':
        if (tokenizer.currentTokenLength > 0) tokenizer.currentTokenLength--;
        touchActivity();
        break;
      case 'ignorable':
        // No-op
        break;
    }
  }

  // Process a finalized IME string as a sequence of tokenizer inputs so
  // multi-word composition (e.g. Japanese/Chinese phrases) counts correctly.
  function processImeText(text) {
    if (!text) {
      commitToken();
      return;
    }
    for (const ch of text) {
      let cls = classifyKey(ch);
      if (cls === 'apostrophe') {
        cls = tokenizer.currentTokenLength > 0 ? 'wordforming' : 'delimiter';
      }
      if (cls === 'wordforming') {
        tokenizer.currentTokenLength++;
      } else if (cls === 'delimiter' || cls === 'unknown') {
        if (tokenizer.currentTokenLength > 0) commitToken();
      }
    }
    // IME finalize boundary: commit whatever remains as one word.
    commitToken();
    touchActivity();
  }

  // --- Input listeners (main document) ---
  document.addEventListener('keydown', (e) => {
    inputStats.keys++;
    processKey(e);
  }, { capture: true, passive: true });

  document.addEventListener('compositionend', (e) => {
    processImeText(e.data || '');
  }, { capture: true, passive: true });

  // Focus loss commits in-progress token (mirrors onApplicationChanged).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) commitToken();
  }, { passive: true });
  window.addEventListener('blur', () => {
    commitToken();
  }, { capture: true, passive: true });

  // Track mouse clicks (all buttons combined)
  document.addEventListener('mousedown', () => {
    inputStats.clicks++;
  }, { capture: true, passive: true });

  // Track scroll actions (each wheel event = 1 action, i.e., one "tick" of the scroll wheel)
  document.addEventListener('wheel', () => {
    inputStats.scrolls++;
  }, { capture: true, passive: true });

  // Track mouse movement distance in inches
  // Throttled via requestAnimationFrame to reduce CPU usage (~60fps max)
  let rafPending = false;
  let pendingMouseEvent = null;

  document.addEventListener('mousemove', (e) => {
    pendingMouseEvent = e;

    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (pendingMouseEvent && lastMousePos) {
          const dx = pendingMouseEvent.clientX - lastMousePos.x;
          const dy = pendingMouseEvent.clientY - lastMousePos.y;
          const distancePx = Math.sqrt(dx * dx + dy * dy);

          // Convert pixels to inches
          inputStats.mouseDistanceIn += distancePx / dpi;
        }
        if (pendingMouseEvent) {
          lastMousePos = { x: pendingMouseEvent.clientX, y: pendingMouseEvent.clientY };
        }
      });
    }
  }, { capture: true, passive: true });

  // Attach listeners to an iframe's contentDocument if accessible (same-origin).
  // This handles cases like Google Docs where keystrokes go to an about:blank iframe
  // that content scripts don't get injected into.
  function attachIframeListeners(iframe) {
    try {
      const doc = iframe.contentDocument;
      if (!doc || iframe.dataset.wpTracked) return;
      iframe.dataset.wpTracked = 'true';

      doc.addEventListener('keydown', (e) => {
        inputStats.keys++;
        processKey(e);
      }, { capture: true, passive: true });

      doc.addEventListener('compositionend', (e) => {
        processImeText(e.data || '');
      }, { capture: true, passive: true });

      doc.addEventListener('mousedown', () => {
        inputStats.clicks++;
      }, { capture: true, passive: true });

      doc.addEventListener('wheel', () => {
        inputStats.scrolls++;
      }, { capture: true, passive: true });

      doc.addEventListener('mousemove', (e) => {
        pendingMouseEvent = e;
        if (!rafPending) {
          rafPending = true;
          requestAnimationFrame(() => {
            rafPending = false;
            if (pendingMouseEvent && lastMousePos) {
              const dx = pendingMouseEvent.clientX - lastMousePos.x;
              const dy = pendingMouseEvent.clientY - lastMousePos.y;
              const distancePx = Math.sqrt(dx * dx + dy * dy);
              inputStats.mouseDistanceIn += distancePx / dpi;
            }
            if (pendingMouseEvent) {
              lastMousePos = { x: pendingMouseEvent.clientX, y: pendingMouseEvent.clientY };
            }
          });
        }
      }, { capture: true, passive: true });
    } catch (e) {
      // Cross-origin iframe, ignore silently
    }
  }

  // Scan for existing about:blank iframes and observe for new ones
  function scanIframes() {
    document.querySelectorAll('iframe').forEach((iframe) => {
      try {
        if (iframe.contentDocument) {
          attachIframeListeners(iframe);
        }
      } catch (e) {
        // Cross-origin, ignore
      }
    });
  }

  // Initial scan
  scanIframes();

  // Watch for dynamically added iframes
  const iframeObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeName === 'IFRAME') {
          // Wait for the iframe to load before attaching
          node.addEventListener('load', () => attachIframeListeners(node), { once: true });
          // Also try immediately in case it's already loaded
          attachIframeListeners(node);
        }
        // Check children of added nodes
        if (node.querySelectorAll) {
          node.querySelectorAll('iframe').forEach((iframe) => {
            iframe.addEventListener('load', () => attachIframeListeners(iframe), { once: true });
            attachIframeListeners(iframe);
          });
        }
      }
    }
  });

  iframeObserver.observe(document.documentElement, { childList: true, subtree: true });

  // Report to background every 5 seconds
  const reportInterval = setInterval(() => {
    // Check if extension context is still valid
    if (!chrome.runtime?.id) {
      clearInterval(reportInterval);
      return;
    }

    // Flush a stalled token so words don't pile up in state across reports.
    checkIdleTimeout();

    // Only send if there's data
    if (inputStats.keys || inputStats.clicks || inputStats.scrolls || inputStats.mouseDistanceIn || inputStats.words) {
      try {
        chrome.runtime.sendMessage({
          type: 'inputStats',
          keys: inputStats.keys,
          clicks: inputStats.clicks,
          scrolls: inputStats.scrolls,
          mouseDistanceIn: inputStats.mouseDistanceIn,
          words: inputStats.words
        });
      } catch (e) {
        // Extension context may be invalidated, stop reporting
        clearInterval(reportInterval);
        return;
      }

      // Reset accumulators
      inputStats = { keys: 0, clicks: 0, scrolls: 0, mouseDistanceIn: 0, words: 0 };
    }
  }, 5000);
})();
