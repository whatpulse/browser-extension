/**
 * WhatPulse Web Insights - Background Service Worker
 *
 * Connects to WhatPulse desktop client via WebSocket and sends accumulated
 * website time data. Also receives input stats from content scripts.
 */

// Configuration
const WS_PORT = 3488;  // Fixed port - must match WhatPulse app
const USAGE_REPORT_INTERVAL_MS = 30000; // 30 seconds
const RECONNECT_DELAY_MS = 5000; // 5 seconds
const IDLE_THRESHOLD_SECONDS = 60; // User is idle after 60 seconds
const METADATA_MAX_AGE_DAYS = 7; // Update metadata after 7 days

// State
let config = {
  authToken: '',
  enabled: true  // Enabled by default - pairing handles auth
};

let clientId = null;
let websocket = null;
let usageReportTimer = null;
let reconnectTimer = null;

// Current tracking state
let currentState = {
  activeTabId: null,
  activeWindowId: null,
  activeDomain: null,
  isFocused: false,
  isVisible: true,
  isIdle: false
};

// Time tracking state
let timeTracking = {
  currentDomain: null,
  domainStartTime: null,
  accumulatedTime: {},  // { "github.com": 45, "google.com": 12 }
  lastReportTime: Date.now()
};

// Input tracking state (from content script)
let accumulatedInput = {};  // { "github.com": { keys: 10, clicks: 5, scrolls: 12, mouseDistanceIn: 2.5 } }

// Metadata tracking: { domain: lastSentTimestamp }
let metadataSentTimes = {};

// Generate stable client ID on first run
async function initializeClientId() {
  const stored = await chrome.storage.local.get(['clientId']);
  if (stored.clientId) {
    clientId = stored.clientId;
  } else {
    clientId = 'chromium-' + generateUUID();
    await chrome.storage.local.set({ clientId });
  }
  console.log('[WhatPulse] Client ID:', clientId);
}

function generateUUID() {
  // Use cryptographically secure UUID generation
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older browsers (unlikely in modern extensions)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Load configuration from storage
async function loadConfig() {
  const stored = await chrome.storage.local.get(['authToken', 'enabled']);
  config.authToken = stored.authToken || '';
  config.enabled = stored.enabled ?? true;

  console.log('[WhatPulse] Config loaded:', {
    hasToken: !!config.authToken,
    enabled: config.enabled
  });
}

// Extract domain from URL (keeps full subdomain, strips www.)
function extractDomain(url) {
  try {
    const urlObj = new URL(url);

    // Only track http/https URLs - skip browser internal pages
    // This filters out: chrome://, chrome-extension://, about:, edge://, brave://, file://, etc.
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      return null;
    }

    const hostname = urlObj.hostname;

    // Remove www. prefix
    let domain = hostname.replace(/^www\./, '');

    // Skip IP addresses entirely (privacy)
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(domain) ||
      domain.includes(':')) {  // Also skip IPv6
      return null;
    }

    // Validate domain format: must contain at least one dot and valid TLD
    // This catches any edge cases like single-word hostnames
    if (!domain.includes('.')) {
      return null;
    }

    // Basic TLD validation: last segment should be 2+ chars
    const parts = domain.split('.');
    const tld = parts[parts.length - 1];
    if (tld.length < 2) {
      return null;
    }

    return domain;
  } catch (e) {
    console.log('[WhatPulse] Error extracting domain:', e.message);
    return null;
  }
}

// Get browser info - comprehensive detection for all major browsers
async function getBrowserInfo() {
  // Firefox: use the dedicated WebExtensions API
  if (typeof browser !== 'undefined' && browser.runtime?.getBrowserInfo) {
    try {
      const info = await browser.runtime.getBrowserInfo();
      return { name: info.name.toLowerCase(), version: info.version };
    } catch (e) {
      console.log('[WhatPulse] Firefox getBrowserInfo failed:', e.message);
    }
  }

  // Brave: must check before other Chromium browsers (hides from userAgentData.brands)
  if (navigator.brave) {
    try {
      const isBrave = await navigator.brave.isBrave();
      if (isBrave) {
        const version = await getChromiumFullVersion();
        return { name: 'brave', version };
      }
    } catch (e) {
      console.log('[WhatPulse] Brave detection failed:', e.message);
    }
  }

  // Chromium browsers: use User-Agent Client Hints API (Chrome 90+, Edge 90+)
  if (navigator.userAgentData?.brands) {
    // Browser brands in order of specificity (most specific first)
    const browserBrands = [
      { brand: 'Microsoft Edge', name: 'edge' },
      { brand: 'Opera', name: 'opera' },
      { brand: 'Google Chrome', name: 'chrome' },
      { brand: 'Chromium', name: 'chromium' },  // Generic Chromium fallback
    ];

    for (const { brand, name } of browserBrands) {
      const match = navigator.userAgentData.brands.find(b => b.brand === brand);
      if (match) {
        // Try to get full version for more detail
        try {
          const highEntropy = await navigator.userAgentData.getHighEntropyValues(['fullVersionList']);
          const fullVersion = highEntropy.fullVersionList?.find(b => b.brand === brand);
          return { name, version: fullVersion?.version || match.version };
        } catch {
          return { name, version: match.version };
        }
      }
    }
  }

  // Fallback: User-Agent string parsing for older browsers or unsupported APIs
  return getBrowserInfoFromUserAgent();
}

// Get full Chromium version using Client Hints API
async function getChromiumFullVersion() {
  if (navigator.userAgentData) {
    try {
      const data = await navigator.userAgentData.getHighEntropyValues(['fullVersionList']);
      const chromium = data.fullVersionList?.find(b => b.brand === 'Chromium');
      if (chromium) return chromium.version;
    } catch (e) {
      // Fall through to UA parsing
    }
  }
  // Fallback to UA string
  const match = navigator.userAgent.match(/Chrome\/([\d.]+)/);
  return match ? match[1] : 'unknown';
}

// Fallback browser detection using User-Agent string
function getBrowserInfoFromUserAgent() {
  const ua = navigator.userAgent;

  // Order matters: check more specific browsers first

  // Firefox (including variants)
  let match = ua.match(/Firefox\/([\d.]+)/);
  if (match) {
    return { name: 'firefox', version: match[1] };
  }

  // Edge (Chromium-based, has "Edg/" not "Edge/")
  match = ua.match(/Edg\/([\d.]+)/);
  if (match) {
    return { name: 'edge', version: match[1] };
  }

  // Edge Legacy (EdgeHTML engine, rare now)
  match = ua.match(/Edge\/([\d.]+)/);
  if (match) {
    return { name: 'edge-legacy', version: match[1] };
  }

  // Opera (Chromium-based)
  match = ua.match(/OPR\/([\d.]+)/);
  if (match) {
    return { name: 'opera', version: match[1] };
  }

  // Vivaldi
  match = ua.match(/Vivaldi\/([\d.]+)/);
  if (match) {
    return { name: 'vivaldi', version: match[1] };
  }

  // Samsung Internet
  match = ua.match(/SamsungBrowser\/([\d.]+)/);
  if (match) {
    return { name: 'samsung', version: match[1] };
  }

  // Arc (identifies as Chrome but has Arc in UA on some platforms)
  if (ua.includes('Arc/')) {
    match = ua.match(/Arc\/([\d.]+)/);
    if (match) {
      return { name: 'arc', version: match[1] };
    }
  }

  // Yandex Browser
  match = ua.match(/YaBrowser\/([\d.]+)/);
  if (match) {
    return { name: 'yandex', version: match[1] };
  }

  // Generic Chrome (must be after other Chromium browsers)
  match = ua.match(/Chrome\/([\d.]+)/);
  if (match) {
    return { name: 'chrome', version: match[1] };
  }

  // Safari (must be after Chrome since Chrome also has Safari in UA)
  match = ua.match(/Version\/([\d.]+).*Safari/);
  if (match) {
    return { name: 'safari', version: match[1] };
  }

  // Unknown browser
  return { name: 'unknown', version: 'unknown' };
}

// ============ Metadata / Favicon ============

/**
 * Load metadata sent times from storage
 */
async function loadMetadataSentTimes() {
  const stored = await chrome.storage.local.get(['metadataSentTimes']);
  metadataSentTimes = stored.metadataSentTimes || {};
}

/**
 * Save metadata sent times to storage
 */
async function saveMetadataSentTimes() {
  await chrome.storage.local.set({ metadataSentTimes });
}

/**
 * Check if domain needs metadata update
 */
function needsMetadataUpdate(domain) {
  if (!domain) return false;

  const lastSent = metadataSentTimes[domain];
  if (!lastSent) return true;

  const maxAgeMs = METADATA_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return (Date.now() - lastSent) > maxAgeMs;
}

/**
 * Send favicon URL for a domain to the app (app will fetch it)
 */
function sendFaviconUrl(domain, tab) {
  if (!domain || !websocket || websocket.readyState !== WebSocket.OPEN) {
    return;
  }

  // Build list of favicon URLs to try (in order of preference)
  const faviconUrls = [];

  try {
    const origin = new URL(tab.url).origin;

    // 1. Apple touch icon (usually highest quality, 180x180)
    faviconUrls.push(`${origin}/apple-touch-icon.png`);

    // 2. Common high-res favicon locations
    faviconUrls.push(`${origin}/favicon-192x192.png`);
    faviconUrls.push(`${origin}/favicon-96x96.png`);

    // 3. Tab's favicon URL (Chrome's detected favicon)
    if (tab.favIconUrl && !tab.favIconUrl.startsWith('chrome://')) {
      faviconUrls.push(tab.favIconUrl);
    }

    // 4. Default favicon.ico
    faviconUrls.push(`${origin}/favicon.ico`);
  } catch (e) {
    console.error('[WhatPulse] Error building favicon URLs:', e);
    return;
  }

  const sent = sendMessage({
    type: 'metadata_update',
    domain: domain,
    favicon_urls: faviconUrls
  });

  if (sent) {
    console.log('[WhatPulse] Sent favicon URLs for', domain);
    metadataSentTimes[domain] = Date.now();
    saveMetadataSentTimes();
  }
}

// ============ Time Tracking ============

/**
 * Record elapsed time for current domain and switch to new domain
 */
function recordTimeAndSwitchDomain(newDomain) {
  const now = Date.now();

  // Record time for previous domain if we were tracking
  if (timeTracking.currentDomain && timeTracking.domainStartTime) {
    // Only record if browser was focused and not idle
    if (currentState.isFocused && !currentState.isIdle) {
      const elapsedMs = now - timeTracking.domainStartTime;
      const elapsedSeconds = Math.floor(elapsedMs / 1000);

      if (elapsedSeconds > 0) {
        const domain = timeTracking.currentDomain;
        timeTracking.accumulatedTime[domain] =
          (timeTracking.accumulatedTime[domain] || 0) + elapsedSeconds;

        console.log('[WhatPulse] Recorded', elapsedSeconds, 's for', domain);
      }
    }
  }

  // Start tracking new domain
  timeTracking.currentDomain = newDomain;
  timeTracking.domainStartTime = newDomain ? now : null;
}

/**
 * Pause time tracking (when focus lost or idle)
 */
function pauseTimeTracking() {
  if (timeTracking.currentDomain && timeTracking.domainStartTime) {
    // Record elapsed time before pausing
    const now = Date.now();
    const elapsedMs = now - timeTracking.domainStartTime;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);

    if (elapsedSeconds > 0) {
      const domain = timeTracking.currentDomain;
      timeTracking.accumulatedTime[domain] =
        (timeTracking.accumulatedTime[domain] || 0) + elapsedSeconds;

      console.log('[WhatPulse] Paused, recorded', elapsedSeconds, 's for', domain);
    }

    // Clear start time but keep current domain
    timeTracking.domainStartTime = null;
  }
}

/**
 * Resume time tracking (when focus regained)
 */
function resumeTimeTracking() {
  if (timeTracking.currentDomain && !timeTracking.domainStartTime) {
    timeTracking.domainStartTime = Date.now();
    console.log('[WhatPulse] Resumed tracking', timeTracking.currentDomain);
  }
}

/**
 * Send usage report to server
 */
function sendUsageReport() {
  // First, record any pending time for current domain
  if (timeTracking.currentDomain && timeTracking.domainStartTime &&
    currentState.isFocused && !currentState.isIdle) {
    const now = Date.now();
    const elapsedMs = now - timeTracking.domainStartTime;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);

    if (elapsedSeconds > 0) {
      const domain = timeTracking.currentDomain;
      timeTracking.accumulatedTime[domain] =
        (timeTracking.accumulatedTime[domain] || 0) + elapsedSeconds;

      // Reset start time for next period
      timeTracking.domainStartTime = now;
    }
  }

  // Build report from accumulated time and input
  const report = [];

  // First add domains with time data (most common case)
  for (const [domain, seconds] of Object.entries(timeTracking.accumulatedTime)) {
    if (seconds > 0) {
      const input = accumulatedInput[domain] || { keys: 0, clicks: 0, scrolls: 0, mouseDistanceIn: 0 };
      report.push({
        domain,
        seconds,
        keys: input.keys,
        clicks: input.clicks,
        scrolls: input.scrolls,
        mouse_distance_in: input.mouseDistanceIn
      });
    }
  }

  // Also include domains with input but no time (edge case: fast domain switch)
  for (const [domain, input] of Object.entries(accumulatedInput)) {
    if (!timeTracking.accumulatedTime[domain] && (input.keys || input.clicks || input.scrolls || input.mouseDistanceIn)) {
      report.push({
        domain,
        seconds: 0,
        keys: input.keys,
        clicks: input.clicks,
        scrolls: input.scrolls,
        mouse_distance_in: input.mouseDistanceIn
      });
    }
  }

  // Only send if we have data
  if (report.length > 0) {
    const now = Date.now();
    const sent = sendMessage({
      type: 'usage_report',
      report: report,
      period_start: timeTracking.lastReportTime,
      period_end: now
    });

    if (sent) {
      console.log('[WhatPulse] Sent usage report:', report);
      // Clear accumulated data after successful send
      timeTracking.accumulatedTime = {};
      accumulatedInput = {};
      timeTracking.lastReportTime = now;
    }
  }
}

// ============ Idle Detection ============

async function checkIdleState() {
  try {
    const state = await chrome.idle.queryState(IDLE_THRESHOLD_SECONDS);
    const wasIdle = currentState.isIdle;
    currentState.isIdle = (state !== 'active');

    if (currentState.isIdle && !wasIdle) {
      console.log('[WhatPulse] User became idle');
      pauseTimeTracking();
    } else if (!currentState.isIdle && wasIdle) {
      console.log('[WhatPulse] User became active');
      if (currentState.isFocused) {
        resumeTimeTracking();
      }
    }
  } catch (e) {
    // idle permission might not be granted, just continue
  }
}

// ============ WebSocket Connection ============

function connect() {
  if (!config.enabled) {
    console.log('[WhatPulse] Not connecting: disabled');
    return;
  }

  if (websocket && (websocket.readyState === WebSocket.CONNECTING ||
    websocket.readyState === WebSocket.OPEN)) {
    console.log('[WhatPulse] Already connected or connecting');
    return;
  }

  console.log('[WhatPulse] Connecting to ws://127.0.0.1:' + WS_PORT);

  try {
    websocket = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);

    websocket.onopen = async () => {
      try {
        console.log('[WhatPulse] WebSocket connected');
        await sendHello();
      } catch (e) {
        console.log('[WhatPulse] Error in onopen handler:', e.message);
      }
    };

    websocket.onmessage = (event) => {
      try {
        handleMessage(event.data);
      } catch (e) {
        console.log('[WhatPulse] Error handling message:', e.message);
      }
    };

    websocket.onclose = (event) => {
      try {
        console.log('[WhatPulse] WebSocket closed:', event.code, event.reason || 'No reason');
        stopUsageReportTimer();
        scheduleReconnect();
      } catch (e) {
        console.log('[WhatPulse] Error in onclose handler:', e.message);
      }
    };

    websocket.onerror = () => {
      // Errors are expected when WhatPulse is not running - log quietly
      console.log('[WhatPulse] Connection failed (WhatPulse app may not be running)');
    };
  } catch (e) {
    // WebSocket constructor failed - likely invalid URL or blocked by browser
    console.log('[WhatPulse] Failed to create WebSocket:', e.message);
    scheduleReconnect();
  }
}

function disconnect() {
  try {
    // Send final report before disconnecting
    sendUsageReport();

    if (websocket) {
      sendGoodbye('User disabled');
      websocket.close();
      websocket = null;
    }
    stopUsageReportTimer();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  } catch (e) {
    console.log('[WhatPulse] Error during disconnect:', e.message);
    websocket = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (!config.enabled) return;

  console.log('[WhatPulse] Reconnecting in', RECONNECT_DELAY_MS / 1000, 'seconds');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY_MS);
}

// ============ Message Handlers ============

function sendMessage(msg) {
  if (!websocket || websocket.readyState !== WebSocket.OPEN) {
    return false;
  }

  msg.schema_version = 1;
  msg.ts = Date.now();
  msg.client_id = clientId;

  try {
    websocket.send(JSON.stringify(msg));
    return true;
  } catch (e) {
    console.error('[WhatPulse] Error sending message:', e);
    return false;
  }
}

async function sendHello() {
  const browserInfo = await getBrowserInfo();
  sendMessage({
    type: 'hello',
    auth_token: config.authToken,
    browser: browserInfo,
    capabilities: ['activeTab', 'visibility', 'url', 'usageReport'],
    ext_version: chrome.runtime.getManifest().version
  });
}

function sendGoodbye(reason) {
  sendMessage({
    type: 'goodbye',
    reason: reason || 'Extension unloading'
  });
}

function handleMessage(data) {
  try {
    const msg = JSON.parse(data);
    console.log('[WhatPulse] Received:', msg.type);

    switch (msg.type) {
      case 'hello_ack':
        console.log('[WhatPulse] Authenticated, session token:', msg.session_token);
        onAuthenticated();
        break;

      case 'pairing_approved':
        console.log('[WhatPulse] Pairing approved, received auth token');
        config.authToken = msg.auth_token;
        chrome.storage.local.set({ authToken: msg.auth_token });
        onAuthenticated();
        break;

      case 'error':
        console.error('[WhatPulse] Server error:', msg.error_code, msg.reason);
        if (msg.error_code === 'AUTH_FAILED') {
          config.authToken = '';
          chrome.storage.local.remove('authToken');
          disconnect();
          scheduleReconnect();
        } else if (msg.error_code === 'PAIRING_REJECTED') {
          console.log('[WhatPulse] Pairing was rejected by user');
          disconnect();
          scheduleReconnect();
        }
        break;
    }
  } catch (e) {
    console.error('[WhatPulse] Error parsing message:', e);
  }
}

function onAuthenticated() {
  // Initialize current tab state
  updateCurrentTab();
  // Start periodic usage reports
  startUsageReportTimer();
}

// ============ Usage Report Timer ============

function startUsageReportTimer() {
  stopUsageReportTimer();

  usageReportTimer = setInterval(() => {
    // Check idle state before sending report
    checkIdleState();
    // Send accumulated usage
    sendUsageReport();
  }, USAGE_REPORT_INTERVAL_MS);

  console.log('[WhatPulse] Started usage report timer (every',
    USAGE_REPORT_INTERVAL_MS / 1000, 's)');
}

function stopUsageReportTimer() {
  if (usageReportTimer) {
    clearInterval(usageReportTimer);
    usageReportTimer = null;
  }
}

// ============ Tab Monitoring ============

async function updateCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

    if (!tab) {
      recordTimeAndSwitchDomain(null);
      currentState.activeTabId = null;
      currentState.activeWindowId = null;
      currentState.activeDomain = null;
      return;
    }

    // Skip private/incognito tabs
    if (tab.incognito) {
      console.log('[WhatPulse] Skipping incognito tab');
      recordTimeAndSwitchDomain(null);
      currentState.activeTabId = null;
      currentState.activeDomain = null;
      return;
    }

    const newDomain = extractDomain(tab.url);

    // Update state
    currentState.activeTabId = tab.id;
    currentState.activeWindowId = tab.windowId;
    currentState.activeDomain = newDomain;

    // If domain changed, record time for old domain and start tracking new
    if (newDomain !== timeTracking.currentDomain) {
      console.log('[WhatPulse] Domain changed:',
        timeTracking.currentDomain, '->', newDomain);
      recordTimeAndSwitchDomain(newDomain);

      // Check if we need to send metadata for the new domain
      if (newDomain && needsMetadataUpdate(newDomain)) {
        sendFaviconUrl(newDomain, tab);
      }
    }
  } catch (e) {
    console.error('[WhatPulse] Error updating current tab:', e);
  }
}

// ============ Event Listeners ============

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  console.log('[WhatPulse] Tab activated:', activeInfo.tabId);
  await updateCurrentTab();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tabId === currentState.activeTabId && changeInfo.url) {
    console.log('[WhatPulse] Tab URL updated:', tabId);
    await updateCurrentTab();
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const wasFocused = currentState.isFocused;
  currentState.isFocused = windowId !== chrome.windows.WINDOW_ID_NONE;

  console.log('[WhatPulse] Window focus changed:', currentState.isFocused);

  if (!currentState.isFocused && wasFocused) {
    // Lost focus - pause tracking
    pauseTimeTracking();
  } else if (currentState.isFocused && !wasFocused) {
    // Regained focus - resume tracking
    await updateCurrentTab();
    if (!currentState.isIdle) {
      resumeTimeTracking();
    }
  }
});

// Listen for idle state changes
chrome.idle.onStateChanged.addListener((newState) => {
  const wasIdle = currentState.isIdle;
  currentState.isIdle = (newState !== 'active');

  console.log('[WhatPulse] Idle state changed:', newState);

  if (currentState.isIdle && !wasIdle) {
    pauseTimeTracking();
  } else if (!currentState.isIdle && wasIdle && currentState.isFocused) {
    resumeTimeTracking();
  }
});

// Listen for config changes
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local') {
    console.log('[WhatPulse] Storage changed:', Object.keys(changes));

    const wasEnabled = config.enabled;
    await loadConfig();

    if (config.enabled && !wasEnabled) {
      connect();
    } else if (!config.enabled && wasEnabled) {
      disconnect();
    }
  }
});

// Listen for messages from popup/options and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle input stats from content script
  if (message.type === 'inputStats' && sender.tab) {
    const domain = extractDomain(sender.tab.url);

    // Only accumulate input when browser is focused and not idle
    if (domain && currentState.isFocused && !currentState.isIdle) {
      if (!accumulatedInput[domain]) {
        accumulatedInput[domain] = { keys: 0, clicks: 0, scrolls: 0, mouseDistanceIn: 0 };
      }
      accumulatedInput[domain].keys += message.keys || 0;
      accumulatedInput[domain].clicks += message.clicks || 0;
      accumulatedInput[domain].scrolls += message.scrolls || 0;
      accumulatedInput[domain].mouseDistanceIn += message.mouseDistanceIn || 0;
    }
    return false; // No response needed
  }

  if (message.type === 'getStatus') {
    const isConnected = websocket && websocket.readyState === WebSocket.OPEN;
    const isConnecting = websocket && websocket.readyState === WebSocket.CONNECTING;

    sendResponse({
      connected: isConnected,
      connecting: isConnecting,
      pendingPairing: false, // Could track this state if needed
      currentDomain: currentState.activeDomain,
      reason: !isConnected && !isConnecting ? 'app_not_running' : null
    });
    return true;
  }

  if (message.type === 'testConnection') {
    // Test connection request from options page
    testConnectionForOptions(sendResponse);
    return true; // Will respond asynchronously
  }
});

/**
 * Test connection for options page
 */
function testConnectionForOptions(sendResponse) {
  try {
    const testWs = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    const timeoutId = setTimeout(() => {
      try { testWs.close(); } catch (e) { }
      sendResponse({ success: false, error: 'Connection timeout. Is WhatPulse running?' });
    }, 5000);

    testWs.onopen = () => {
      clearTimeout(timeoutId);
      // Just verify we can connect, don't need to authenticate
      sendResponse({ success: true, message: 'Successfully connected to WhatPulse' });
      try { testWs.close(); } catch (e) { }
    };

    testWs.onerror = () => {
      clearTimeout(timeoutId);
      sendResponse({ success: false, error: 'Connection failed. Is WhatPulse running?' });
    };
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }
}

// ============ Initialization ============

(async () => {
  try {
    await initializeClientId();
    await loadConfig();
    await loadMetadataSentTimes();

    if (config.enabled) {
      connect();
    }

    // Set initial focus state
    try {
      const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
      currentState.isFocused = windows.some(w => w.focused);
    } catch (e) {
      currentState.isFocused = true;
    }

    await updateCurrentTab();

    console.log('[WhatPulse] Background service worker initialized');
  } catch (e) {
    console.log('[WhatPulse] Error during initialization:', e.message);
  }
})();

// Cleanup on unload
self.addEventListener('beforeunload', () => {
  try {
    sendUsageReport();
    sendGoodbye('Service worker terminating');
    disconnect();
  } catch (e) {
    // Ignore errors during cleanup
  }
});
