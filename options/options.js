// Options page script for WhatPulse web insights extension

const successIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
  <polyline points="22 4 12 14.01 9 11.01"></polyline>
</svg>`;

const errorIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <circle cx="12" cy="12" r="10"></circle>
  <line x1="15" y1="9" x2="9" y2="15"></line>
  <line x1="9" y1="9" x2="15" y2="15"></line>
</svg>`;

/**
 * Get connection status from background script
 */
async function getConnectionStatus() {
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
}

/**
 * Update connection status display
 */
async function updateConnectionStatus() {
  const statusIndicator = document.getElementById('statusIndicator');
  const statusTitle = document.getElementById('statusTitle');
  const statusSubtitle = document.getElementById('statusSubtitle');

  const status = await getConnectionStatus();

  if (status.connected) {
    statusIndicator.className = 'status-indicator connected';
    statusTitle.textContent = 'Connected';
    statusSubtitle.textContent = 'Extension is connected to WhatPulse';
  } else {
    statusIndicator.className = 'status-indicator disconnected';
    statusTitle.textContent = 'Disconnected';
    statusSubtitle.textContent = 'Make sure WhatPulse is running';
  }
}

/**
 * Test connection to WhatPulse
 */
async function testConnection() {
  const testMessage = document.getElementById('testMessage');
  const testBtn = document.getElementById('testBtn');

  // Disable button while testing
  testBtn.disabled = true;
  testBtn.innerHTML = `
    <svg class="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="32"></circle>
    </svg>
    Testing...
  `;

  try {
    const response = await new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        resolve({ success: false, error: 'Request timed out' });
      }, 6000);

      chrome.runtime.sendMessage({ type: 'testConnection' }, (response) => {
        clearTimeout(timeoutId);
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: 'Could not communicate with extension' });
        } else {
          resolve(response || { success: false, error: 'No response from extension' });
        }
      });
    });

    if (response.success) {
      showMessage(testMessage, 'success', response.message);
    } else {
      showMessage(testMessage, 'error', response.error);
    }
  } catch (e) {
    showMessage(testMessage, 'error', e.message);
  }

  // Re-enable button
  testBtn.disabled = false;
  testBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path>
    </svg>
    Test connection
  `;

  // Update status after test
  await updateConnectionStatus();

  // Hide message after 5 seconds
  setTimeout(() => {
    testMessage.className = 'message';
    testMessage.style.display = 'none';
  }, 5000);
}

/**
 * Show a message in a message element
 */
function showMessage(element, type, text) {
  element.innerHTML = (type === 'success' ? successIcon : errorIcon) + `<span>${text}</span>`;
  element.className = `message ${type}`;
  element.style.display = 'flex';
}

// Event listeners
document.getElementById('testBtn').addEventListener('click', testConnection);

// Initialize
updateConnectionStatus();

// Update status periodically
setInterval(updateConnectionStatus, 2000);
