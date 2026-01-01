// WhatPulse Website Tracking - Content Script
// Captures input events (keystrokes, clicks, scroll, mouse movement) and reports to background script

(function() {
  'use strict';

  // Accumulate input events, send to background every 5 seconds
  let inputStats = { keys: 0, clicks: 0, scrollPixels: 0, mouseDistanceIn: 0 };
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

  // Track scroll distance normalized to pixels
  document.addEventListener('wheel', (e) => {
    let pixels = Math.abs(e.deltaY);

    // Normalize based on deltaMode
    if (e.deltaMode === 1) {
      // deltaMode 1 = lines, ~16px per line
      pixels *= 16;
    } else if (e.deltaMode === 2) {
      // deltaMode 2 = pages
      pixels *= window.innerHeight;
    }
    // deltaMode 0 = pixels (no conversion needed)

    inputStats.scrollPixels += pixels;
  }, { passive: true });

  // Track mouse movement distance in inches
  document.addEventListener('mousemove', (e) => {
    if (lastMousePos) {
      const dx = e.clientX - lastMousePos.x;
      const dy = e.clientY - lastMousePos.y;
      const distancePx = Math.sqrt(dx * dx + dy * dy);

      // Convert pixels to inches
      inputStats.mouseDistanceIn += distancePx / dpi;
    }
    lastMousePos = { x: e.clientX, y: e.clientY };
  }, { passive: true });

  // Report to background every 5 seconds
  setInterval(() => {
    // Only send if there's data
    if (inputStats.keys || inputStats.clicks || inputStats.scrollPixels || inputStats.mouseDistanceIn) {
      try {
        chrome.runtime.sendMessage({
          type: 'inputStats',
          keys: inputStats.keys,
          clicks: inputStats.clicks,
          scrollPixels: inputStats.scrollPixels,
          mouseDistanceIn: inputStats.mouseDistanceIn
        });
      } catch (e) {
        // Extension context may be invalidated, ignore
      }

      // Reset accumulators
      inputStats = { keys: 0, clicks: 0, scrollPixels: 0, mouseDistanceIn: 0 };
    }
  }, 5000);
})();
