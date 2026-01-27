// WhatPulse Website Tracking - Content Script
// Captures input events (keystrokes, clicks, scroll, mouse movement) and reports to background script

(function () {
  'use strict';

  // Accumulate input events, send to background every 5 seconds
  let inputStats = { keys: 0, clicks: 0, scrolls: 0, mouseDistanceIn: 0 };
  let lastMousePos = null;

  // Get device DPI for pixel-to-inch conversion (default 96 DPI)
  const dpi = window.devicePixelRatio * 96;

  // Track keystrokes (count only, not content)
  document.addEventListener('keydown', () => {
    inputStats.keys++;
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

      doc.addEventListener('keydown', () => {
        inputStats.keys++;
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

    // Only send if there's data
    if (inputStats.keys || inputStats.clicks || inputStats.scrolls || inputStats.mouseDistanceIn) {
      try {
        chrome.runtime.sendMessage({
          type: 'inputStats',
          keys: inputStats.keys,
          clicks: inputStats.clicks,
          scrolls: inputStats.scrolls,
          mouseDistanceIn: inputStats.mouseDistanceIn
        });
      } catch (e) {
        // Extension context may be invalidated, stop reporting
        clearInterval(reportInterval);
        return;
      }

      // Reset accumulators
      inputStats = { keys: 0, clicks: 0, scrolls: 0, mouseDistanceIn: 0 };
    }
  }, 5000);
})();
