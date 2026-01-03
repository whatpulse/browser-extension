// Popup script for WhatPulse web insights extension

/**
 * Extract domain from URL (same logic as background.js)
 */
function extractDomain(url) {
  try {
    const urlObj = new URL(url);

    // Only track http/https URLs
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      return null;
    }

    const hostname = urlObj.hostname;
    let domain = hostname.replace(/^www\./, '');

    // Skip IP addresses
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(domain) || domain.includes(':')) {
      return null;
    }

    // Must contain at least one dot
    if (!domain.includes('.')) {
      return null;
    }

    // Basic TLD validation
    const parts = domain.split('.');
    const tld = parts[parts.length - 1];
    if (tld.length < 2) {
      return null;
    }

    return domain;
  } catch (e) {
    return null;
  }
}

/**
 * Get connection status from background script
 */
async function getConnectionStatus() {
  try {
    // Check if we have stored connection info
    const stored = await chrome.storage.local.get(['authToken', 'clientId']);

    // Try to get status from background via runtime message
    // If background is connected, it will respond
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        resolve({ connected: false, reason: 'timeout' });
      }, 500);

      chrome.runtime.sendMessage({ type: 'getStatus' }, (response) => {
        clearTimeout(timeoutId);
        if (chrome.runtime.lastError) {
          resolve({ connected: false, reason: 'no_response' });
        } else if (response) {
          resolve(response);
        } else {
          resolve({ connected: false, reason: 'no_response' });
        }
      });
    });
  } catch (e) {
    return { connected: false, reason: 'error' };
  }
}

async function updateStatus() {
  const statusIndicator = document.getElementById('statusIndicator');
  const statusTitle = document.getElementById('statusTitle');
  const statusSubtitle = document.getElementById('statusSubtitle');
  const currentDomainEl = document.getElementById('currentDomain');

  try {
    // Get current tab domain
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let currentDomain = null;

    if (tab && tab.url && !tab.incognito) {
      currentDomain = extractDomain(tab.url);
    }

    if (tab && tab.incognito) {
      currentDomainEl.textContent = 'Private browsing';
      currentDomainEl.className = 'domain-value inactive';
    } else if (currentDomain) {
      currentDomainEl.textContent = currentDomain;
      currentDomainEl.className = 'domain-value';
    } else {
      currentDomainEl.textContent = 'Not a trackable page';
      currentDomainEl.className = 'domain-value inactive';
    }

    // Get connection status
    const status = await getConnectionStatus();

    if (status.connected) {
      statusIndicator.className = 'status-indicator connected';
      statusTitle.textContent = 'Connected';
      statusSubtitle.textContent = 'to WhatPulse app';
    } else if (status.connecting) {
      statusIndicator.className = 'status-indicator connecting';
      statusTitle.textContent = 'Connecting...';
      statusSubtitle.textContent = 'Waiting for WhatPulse';
    } else if (status.pendingPairing) {
      statusIndicator.className = 'status-indicator connecting';
      statusTitle.textContent = 'Pairing required';
      statusSubtitle.textContent = 'Approve in WhatPulse app';
    } else {
      statusIndicator.className = 'status-indicator disconnected';
      statusTitle.textContent = 'Disconnected';

      if (status.reason === 'app_not_running') {
        statusSubtitle.textContent = 'WhatPulse is not running';
      } else {
        statusSubtitle.textContent = 'Will retry automatically';
      }
    }
  } catch (e) {
    console.log('[WhatPulse Popup] Error updating status:', e.message);
  }
}

document.getElementById('optionsBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// Update status when popup opens
updateStatus();

// Refresh every second
setInterval(updateStatus, 1000);
