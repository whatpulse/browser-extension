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
  }, { passive: true });

  // Track mouse clicks (all buttons combined)
  document.addEventListener('mousedown', () => {
    inputStats.clicks++;
  }, { passive: true });

  // Track scroll actions (each wheel event = 1 action, i.e., one "tick" of the scroll wheel)
  document.addEventListener('wheel', () => {
    inputStats.scrolls++;
  }, { passive: true });

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
  }, { passive: true });

  // Report to background every 5 seconds
  setInterval(() => {
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
        // Extension context may be invalidated, ignore
      }

      // Reset accumulators
      inputStats = { keys: 0, clicks: 0, scrolls: 0, mouseDistanceIn: 0 };
    }
  }, 5000);
})();
