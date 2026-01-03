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
  
  // Handle enable state updates from content script
  if (message.action === "updateBadge") {
    updateBadge(message.enabled);
  }
});

// Toggle enable/disable when clicking the extension icon
chrome.action.onClicked.addListener(async (tab) => {
  console.log("[mesh-bridge] Extension icon clicked");
  
  // Get current state
  const result = await chrome.storage.local.get(["meshBridgeEnabled"]);
  const currentState = result.meshBridgeEnabled !== false; // Default to true
  const newState = !currentState;
  
  // Save new state
  await chrome.storage.local.set({ meshBridgeEnabled: newState });
  console.log("[mesh-bridge] Toggled to:", newState ? "ON" : "OFF");
  
  // Update badge
  updateBadge(newState);
  
  // Notify content script
  if (tab.url?.includes("whatsapp.com")) {
    try {
      await chrome.tabs.sendMessage(tab.id, { 
        action: "toggleEnabled", 
        enabled: newState 
      });
    } catch (err) {
      // Content script might not be ready
      console.log("[mesh-bridge] Could not notify content script:", err.message);
    }
  }
});

// Update extension badge to show state
function updateBadge(enabled) {
  if (enabled) {
    chrome.action.setBadgeText({ text: "" });
    chrome.action.setTitle({ title: "Mesh Bridge (ON) - Click to disable" });
  } else {
    chrome.action.setBadgeText({ text: "OFF" });
    chrome.action.setBadgeBackgroundColor({ color: "#cc3333" });
    chrome.action.setTitle({ title: "Mesh Bridge (OFF) - Click to enable" });
  }
}

// Initialize badge on startup
chrome.storage.local.get(["meshBridgeEnabled"], (result) => {
  const enabled = result.meshBridgeEnabled !== false;
  updateBadge(enabled);
});

// Dev mode: auto-reload on install/update
chrome.runtime.onInstalled.addListener((details) => {
  console.log("[mesh-bridge] Extension installed/updated:", details.reason);

  // Initialize badge
  chrome.storage.local.get(["meshBridgeEnabled"], (result) => {
    const enabled = result.meshBridgeEnabled !== false;
    updateBadge(enabled);
  });

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
  
  // Initialize badge
  chrome.storage.local.get(["meshBridgeEnabled"], (result) => {
    const enabled = result.meshBridgeEnabled !== false;
    updateBadge(enabled);
  });
});
