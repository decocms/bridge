/**
 * Mesh Bridge - Background Service Worker
 *
 * Handles extension lifecycle and provides dev utilities.
 */

// Dev mode: reload extension on keyboard shortcut (Alt+Shift+R)
chrome.commands.onCommand.addListener((command) => {
  if (command === "reload-extension") {
    console.log("[mesh-bridge] Reloading extension...");
    chrome.runtime.reload();
  }
});

// Dev mode: reload extension when receiving message
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "reloadExtension") {
    chrome.runtime.reload();
  }
});

// Dev mode: auto-reload on install/update
chrome.runtime.onInstalled.addListener((details) => {
  console.log("[mesh-bridge] Extension installed/updated:", details.reason);

  // Reload all WhatsApp tabs to inject updated content script
  if (details.reason === "update") {
    chrome.tabs.query({ url: "*://web.whatsapp.com/*" }, (tabs) => {
      tabs.forEach((tab) => {
        chrome.tabs.reload(tab.id);
      });
    });
  }
});

// Keep service worker alive
chrome.runtime.onStartup.addListener(() => {
  console.log("[mesh-bridge] Extension started");
});
