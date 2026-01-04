/**
 * WhatsApp Domain - Content Script
 *
 * Connects WhatsApp Web to mesh-bridge.
 * Handles self-chat AI interactions and message scraping.
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

const DOMAIN_ID = "whatsapp";
const BRIDGE_URL = "ws://localhost:9999";
const AI_PREFIX = "🤖 ";
const DEBUG = true;

// =============================================================================
// STATE
// =============================================================================

let bridgeSocket = null;
let bridgeConnected = false;
let sessionId = null;
let reconnectInterval = null;
let selfChatEnabled = true;
let aiResponsePending = false;
let sendingMessage = false; // True while we're injecting an AI response
let observerStarted = false;
let lastSeenMessageText = ""; // The LAST message we've seen - only this matters

// Mode toggles
let speakerMode = false; // When ON, AI speaks responses out loud

// Processing state (true when Pilot is working on a task)
let isProcessing = false;

// Global enable/disable toggle (persisted)
let extensionEnabled = true;

// =============================================================================
// LOGGING
// =============================================================================

function debug(...args) {
  if (DEBUG) {
    console.log(`[mesh-bridge:${DOMAIN_ID}]`, ...args);
  }
}

/**
 * Message Queue - batches fast messages together and flushes on interval
 */
const messageQueue = {
  progressMessages: [],
  responseMessage: null,
  flushTimeout: null,
  FLUSH_INTERVAL: 800, // ms - wait this long to batch messages
  
  // Add a progress message to the queue
  addProgress(msg) {
    if (!msg) return;
    this.progressMessages.push(msg);
    this.scheduleFlush();
  },
  
  // Set the response (high priority - flushes immediately after a short delay)
  setResponse(text) {
    this.responseMessage = text;
    // Give a tiny delay to let any pending progress messages arrive
    setTimeout(() => this.flush(), 100);
  },
  
  // Schedule a flush
  scheduleFlush() {
    if (this.flushTimeout) return; // Already scheduled
    this.flushTimeout = setTimeout(() => this.flush(), this.FLUSH_INTERVAL);
  },
  
  // Flush all queued messages to WhatsApp
  async flush() {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }
    
    // Combine progress messages
    if (this.progressMessages.length > 0) {
      const combined = this.progressMessages.map(m => `_${m}_`).join('\n');
      const progressText = `🤖 ${combined}`;
      debug("Flushing progress:", this.progressMessages.length, "messages");
      await sendWhatsAppMessage(progressText);
      this.progressMessages = [];
    }
    
    // Send response (separate message, always last)
    if (this.responseMessage) {
      debug("Flushing response:", this.responseMessage.slice(0, 50));
      await sendWhatsAppMessage(this.responseMessage);
      this.responseMessage = null;
    }
  }
};

// =============================================================================
// BRIDGE CONNECTION
// =============================================================================

function connectToBridge() {
  if (bridgeSocket?.readyState === WebSocket.OPEN) return;

  try {
    bridgeSocket = new WebSocket(BRIDGE_URL);

    bridgeSocket.onopen = () => {
      debug("WebSocket opened, sending connect frame...");
      sendFrame({
        type: "connect",
        client: "chrome-extension",
        version: "1.0.0",
        domain: DOMAIN_ID,
        url: window.location.href,
        capabilities: ["chat", "scrape"],
      });
    };

    bridgeSocket.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data);
        handleBridgeFrame(frame);
      } catch (err) {
        debug("Failed to parse frame:", err);
      }
    };

    bridgeSocket.onclose = () => {
      debug("WebSocket closed");
      bridgeConnected = false;
      sessionId = null;
      updateStatusUI("reconnecting");

      // Auto-reconnect IMMEDIATELY first, then every 2 seconds
      // This handles hot reload scenarios where bridge restarts quickly
      if (!reconnectInterval) {
        // Try to reconnect immediately
        setTimeout(() => {
          debug("Attempting immediate reconnect...");
          connectToBridge();
        }, 500);
        
        // Then set up retry interval (faster: every 2 seconds)
        reconnectInterval = setInterval(connectToBridge, 2000);
      }
    };

    bridgeSocket.onerror = (err) => {
      debug("WebSocket error:", err);
    };
  } catch (err) {
    debug("Failed to connect:", err);
  }
}

function sendFrame(frame) {
  if (bridgeSocket?.readyState === WebSocket.OPEN) {
    bridgeSocket.send(JSON.stringify(frame));
    return true;
  }
  debug("Cannot send frame - not connected. Frame type:", frame.type);
  return false;
}

function handleBridgeFrame(frame) {
  debug("Received frame:", frame.type);

  switch (frame.type) {
    case "connected":
      // Set connection state first - this is critical
      sessionId = frame.sessionId;
      bridgeConnected = true;
      
      // Clear reconnect interval
      if (reconnectInterval) {
        clearInterval(reconnectInterval);
        reconnectInterval = null;
      }
      
      debug("Connected! Session:", sessionId, "Domain:", frame.domain);
      
      // Update UI (non-critical, might fail if badge not created yet)
      try {
        updateStatusUI("connected");
      } catch (e) {
        debug("Failed to update status UI:", e.message);
      }
      
      // Sync speaker mode with server
      sendFrame({
        type: "command",
        command: "set_speaker_mode",
        domain: DOMAIN_ID,
        args: { enabled: speakerMode },
      });
      break;

    case "send":
      // AI response - queue it with high priority
      debug("📨 SEND frame received! Text:", frame.text?.slice(0, 50));
      sendingMessage = true;
      aiResponsePending = false;
      
      // Queue the response - it will flush after pending progress messages
      messageQueue.setResponse(frame.text);
      
      // CRITICAL: Update lastSeenMessageText after the queue flushes
      setTimeout(() => {
        const newLastMsg = getLastMessage();
        if (newLastMsg) {
          lastSeenMessageText = newLastMsg;
          debug("Updated cache after AI response:", newLastMsg.slice(0, 30));
        }
        sendingMessage = false; // Resume polling
      }, 1500); // Longer delay to account for queue flush
      break;

    case "send_image":
      // Send an image to the chat
      sendingMessage = true;
      sendWhatsAppImage(frame.imageUrl, frame.caption).then(() => {
        setTimeout(() => {
          const newLastMsg = getLastMessage();
          if (newLastMsg) {
            lastSeenMessageText = newLastMsg;
          }
          sendingMessage = false;
        }, 1000);
      });
      aiResponsePending = false;
      break;

    case "response":
      // Command response
      if (frame.text) {
        // Check if it's a speaker mode confirmation (don't inject into chat)
        if (frame.text.includes("Speaker mode")) {
          debug("Speaker mode response:", frame.text);
          // Flash the badge to confirm
          const badge = document.getElementById("mesh-bridge-badge");
          if (badge) {
            badge.style.transform = "translateX(-50%) scale(1.1)";
            setTimeout(() => {
              badge.style.transform = "translateX(-50%) scale(1)";
            }, 200);
          }
        } else {
          sendWhatsAppMessage(frame.text);
        }
      }
      aiResponsePending = false;
      break;

    case "error":
      // Error from bridge
      debug("Bridge error:", frame.code, frame.message);
      if (frame.code === "credentials_stale") {
        // Bridge is restarting due to stale credentials
        // Force disconnect and wait for new bridge
        updateStatusUI("reconnecting");
        bridgeConnected = false;
        sessionId = null;
        if (bridgeSocket) {
          bridgeSocket.close();
        }
      }
      break;

    case "pong":
      // Heartbeat response
      break;

    case "error":
      debug("Bridge error:", frame.code, frame.message);
      aiResponsePending = false;
      break;

    case "event":
      handleBridgeEvent(frame.event, frame.data);
      break;

    case "speaking_started":
      debug("Speaking started:", frame.text?.slice(0, 30));
      showStopSpeakingButton();
      break;

    case "speaking_ended":
      debug("Speaking ended (cancelled:", frame.cancelled, ")");
      hideStopSpeakingButton();
      break;

    case "processing_started":
      debug("Processing started");
      messageQueue.addProgress("thinking...");
      setProcessing(true);
      break;

    case "processing_ended":
      debug("Processing ended");
      setProcessing(false);
      // Flush any pending progress before the response comes
      messageQueue.flush();
      break;

    case "agent_progress":
      // Queue progress messages - they'll be batched together
      debug("Agent progress:", frame.message);
      messageQueue.addProgress(frame.message);
      break;
  }
}

function handleBridgeEvent(event, data) {
  debug("Bridge event:", event, data);

  switch (event) {
    case "request_chats":
      // Scrape and send chat list
      const chats = scrapeChats();
      sendFrame({
        type: "event",
        event: "chats",
        domain: DOMAIN_ID,
        data: { chats },
      });
      break;

    case "request_messages":
      // Scrape and send messages
      const messages = scrapeMessages(data?.limit || 20);
      sendFrame({
        type: "event",
        event: "messages",
        domain: DOMAIN_ID,
        data: { messages, chatId: getChatName() },
      });
      break;
  }
}

// =============================================================================
// UI
// =============================================================================

function createStatusBadge() {
  if (document.getElementById("mesh-bridge-status")) return;

  const badge = document.createElement("div");
  badge.id = "mesh-bridge-status";
  badge.innerHTML = `
    <style>
      /* Minimal bridge indicator - just a tiny dot */
      #mesh-bridge-badge {
        position: fixed;
        top: 12px;
        right: 12px;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #666;
        z-index: 10000;
        cursor: pointer;
        transition: all 0.2s ease;
        box-shadow: 0 1px 3px rgba(0,0,0,0.3);
      }
      #mesh-bridge-badge:hover {
        transform: scale(1.5);
      }
      #mesh-bridge-badge.connected {
        background: #00cc66;
        box-shadow: 0 0 6px #00cc66;
      }
      #mesh-bridge-badge.reconnecting {
        background: #ffaa00;
        animation: blink-reconnect 0.5s infinite;
      }
      #mesh-bridge-badge.disabled {
        background: #cc3333;
      }
      @keyframes blink-reconnect {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.3; }
      }
      /* Hidden elements for backwards compat */
      #mesh-bridge-badge .status-dot,
      #mesh-bridge-badge .status-text,
      #mesh-bridge-badge .processing-dot,
      #mesh-bridge-badge .progress-indicator,
      #mesh-bridge-badge .enable-toggle,
      #mesh-bridge-badge .speaker-toggle,
      #mesh-bridge-badge .stop-speaking {
        display: none;
      }
    </style>
    <div id="mesh-bridge-badge" title="Mesh Bridge"></div>
  `;
  document.body.appendChild(badge);
  
  // Click to toggle extension on/off
  const badgeEl = badge.querySelector("#mesh-bridge-badge");
  badgeEl.addEventListener("click", (e) => {
    e.stopPropagation();
    extensionEnabled = !extensionEnabled;
    debug("Extension toggled:", extensionEnabled ? "ON" : "OFF");
    
    // Update visual state
    if (extensionEnabled) {
      badgeEl.classList.remove("disabled");
      badgeEl.title = "Mesh Bridge (click to disable)";
    } else {
      badgeEl.classList.add("disabled");
      badgeEl.title = "Mesh Bridge DISABLED (click to enable)";
    }
    
    // Persist state
    if (typeof chrome !== "undefined" && chrome.storage) {
      chrome.storage.local.set({ meshBridgeEnabled: extensionEnabled });
    }
    
    // Connect/disconnect and toggle observer
    if (!extensionEnabled) {
      stopMessageObserver();
      // Disconnect WebSocket when disabled
      if (bridgeSocket) {
        bridgeSocket.close();
        bridgeSocket = null;
        bridgeConnected = false;
        sessionId = null;
      }
      // Clear reconnect interval
      if (reconnectInterval) {
        clearInterval(reconnectInterval);
        reconnectInterval = null;
      }
    } else {
      // Connect to bridge when enabled
      connectToBridge();
      startWhatsAppSetup();
    }
  });

  // Load persisted state and connect if enabled
  if (typeof chrome !== "undefined" && chrome.storage) {
    chrome.storage.local.get(["meshBridgeEnabled"], (result) => {
      if (result.meshBridgeEnabled === false) {
        extensionEnabled = false;
        badgeEl.classList.add("disabled");
        badgeEl.title = "Mesh Bridge DISABLED (click to enable)";
        debug("Extension disabled from storage - not connecting");
      } else {
        // Extension is enabled, connect to bridge
        debug("Extension enabled, connecting to bridge...");
        connectToBridge();
        startWhatsAppSetup();
      }
    });
  } else {
    // No chrome.storage (dev mode), connect immediately
    connectToBridge();
    startWhatsAppSetup();
  }
}

// These are no-ops now - UI is minimal, progress shown in chat messages
function showStopSpeakingButton() {}
function hideStopSpeakingButton() {}
function setProcessing(active) {
  isProcessing = active;
}

// No-op - progress now shown in chat messages
function updateAgentProgress(message) {
  debug("Agent progress:", message);
}

// No-op - speaker toggle removed from UI
function updateSpeakerToggle() {}

// Update the minimal badge for enable/disable state
function updateEnableToggle() {
  const badge = document.querySelector("#mesh-bridge-badge");
  if (!badge) return;
  
  if (extensionEnabled) {
    badge.classList.remove("disabled");
    badge.title = "Mesh Bridge (click to disable)";
  } else {
    badge.classList.add("disabled");
    badge.title = "Mesh Bridge DISABLED (click to enable)";
  }
}

function updateStatusUI(status) {
  const badgeContainer = document.getElementById("mesh-bridge-badge");
  if (!badgeContainer) {
    // Badge not created yet, will be updated when it's created
    return;
  }

  // Update badge classes for status (this controls the color)
  if (status === "connected") {
    badgeContainer.classList.add("connected");
    badgeContainer.classList.remove("reconnecting");
  } else if (status === "reconnecting") {
    badgeContainer.classList.remove("connected");
    badgeContainer.classList.add("reconnecting");
  } else {
    badgeContainer.classList.remove("connected");
    badgeContainer.classList.remove("reconnecting");
  }

  // Update text if element exists (optional, badge is now just a dot)
  const text = badgeContainer.querySelector(".status-text");
  if (text) {
    if (status === "connected") {
      text.textContent = "Bridge";
    } else if (status === "reconnecting") {
      text.textContent = "Reconnecting...";
    } else {
      text.textContent = "Bridge ⚠️";
    }
  }
}

// =============================================================================
// WHATSAPP DOM HELPERS
// =============================================================================

function getChatName() {
  const header = document.querySelector("#main header");
  if (header) {
    const span = header.querySelector("span[dir='auto']");
    if (span) return span.innerText;
  }
  return "unknown";
}

function isSelfChat() {
  const chatName = getChatName().toLowerCase();

  // Check for "(você)" which is the explicit self-chat marker in Portuguese
  if (chatName.includes("(você)")) {
    debug("Self-chat detected: (você) in chat name");
    return true;
  }

  // Common self-chat patterns in different languages
  const selfPatterns = [
    "message yourself",
    "mensagem para você mesmo",
    "você mesmo",
    "(you)",
    "myself",
    "eu mesmo",
    "meu número",
    "my number",
  ];

  for (const pattern of selfPatterns) {
    if (chatName.includes(pattern)) {
      debug("Self-chat detected via pattern:", pattern);
      return true;
    }
  }

  // Check for self-chat badge (WhatsApp marks self-chats)
  if (document.querySelector('[data-testid="self"]')) {
    debug("Self-chat detected via [data-testid='self']");
    return true;
  }

  // Check header for (você) span - from user's HTML structure
  const vocalSpan = document.querySelector('#main header span.xjuopq5');
  if (vocalSpan?.innerText?.toLowerCase().includes("você")) {
    debug("Self-chat detected via header (você) span");
    return true;
  }

  return false;
}

function getVisibleMessages() {
  const messages = [];
  const rows = document.querySelectorAll('div[data-id]');

  for (const row of rows) {
    const id = row.getAttribute("data-id");
    if (!id) continue;

    const isOutgoing = row.classList.contains("message-out");
    const textEl = row.querySelector('span.selectable-text');
    const text = textEl?.innerText || "";

    if (text) {
      messages.push({
        id,
        text,
        isOutgoing,
        element: row,
      });
    }
  }

  return messages;
}

function scrapeMessages(limit = 20) {
  const visible = getVisibleMessages();
  return visible.slice(-limit).map((m) => ({
    id: m.id,
    text: m.text,
    isOutgoing: m.isOutgoing,
  }));
}

function scrapeChats() {
  const chats = [];
  const chatItems = document.querySelectorAll('[data-testid="cell-frame-container"]');

  for (const item of chatItems) {
    const nameEl = item.querySelector('span[dir="auto"]');
    const lastMsgEl = item.querySelector('[data-testid="last-msg-status"]');

    if (nameEl) {
      chats.push({
        name: nameEl.innerText,
        lastMessage: lastMsgEl?.innerText || "",
      });
    }
  }

  return chats;
}

async function sendWhatsAppMessage(text) {
  // Find the message input
  const inputSelectors = [
    '[data-testid="conversation-compose-box-input"]',
    'div[contenteditable="true"][data-tab="10"]',
    'footer div[contenteditable="true"]',
    "#main footer div[contenteditable]",
  ];

  let input = null;
  for (const sel of inputSelectors) {
    input = document.querySelector(sel);
    if (input) break;
  }

  if (!input) {
    debug("Could not find message input");
    return false;
  }

  // Focus and type - handle newlines for WhatsApp's contenteditable
  input.focus();
  input.innerHTML = "";
  
  // WhatsApp uses contenteditable, we need to insert text line by line
  // with Shift+Enter for newlines (or insert <br> elements)
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // Insert the line text
    if (lines[i]) {
      document.execCommand("insertText", false, lines[i]);
    }
    
    // Add newline (except after last line)
    if (i < lines.length - 1) {
      // Simulate Shift+Enter for newline in WhatsApp
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        shiftKey: true,
        bubbles: true,
      }));
      // Also insert a line break directly
      document.execCommand("insertLineBreak");
    }
  }

  // Trigger events
  input.dispatchEvent(new Event("input", { bubbles: true }));

  await new Promise((resolve) => setTimeout(resolve, 150));

  // Click send or press Enter
  const sendBtn = document.querySelector('[data-testid="send"]');
  if (sendBtn) {
    sendBtn.click();
  } else {
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        bubbles: true,
      })
    );
  }

  debug("Message sent");
  return true;
}

/**
 * Send an image to WhatsApp by fetching the URL and pasting it
 */
async function sendWhatsAppImage(imageUrl, caption) {
  debug("Sending image:", imageUrl?.slice(0, 80));
  
  try {
    // Fetch the image
    const response = await fetch(imageUrl);
    if (!response.ok) {
      debug("Failed to fetch image:", response.status, response.statusText);
      return false;
    }
    
    const blob = await response.blob();
    debug("Image fetched, size:", blob.size, "type:", blob.type);
    
    // Ensure we have a valid image type
    const mimeType = blob.type || "image/png";
    const extension = mimeType.split("/")[1] || "png";
    const file = new File([blob], `image.${extension}`, { type: mimeType });
    
    // Find the attachment button (+ button) and click it
    const attachBtn = document.querySelector('[data-testid="attach-menu-plus"]') || 
                      document.querySelector('[data-testid="clip"]') ||
                      document.querySelector('span[data-icon="attach-menu-plus"]')?.closest('button') ||
                      document.querySelector('span[data-icon="clip"]')?.closest('div[role="button"]');
    
    if (attachBtn) {
      debug("Found attach button, clicking...");
      attachBtn.click();
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Look for the image/photo option in the menu
      const photoOption = document.querySelector('[data-testid="attach-photo"]') ||
                          document.querySelector('li[data-testid="mi-attach-media"]') ||
                          document.querySelector('input[accept*="image"]');
      
      if (photoOption && photoOption.tagName === 'INPUT') {
        debug("Found file input, setting files...");
        // Create a DataTransfer to set files on the input
        const dt = new DataTransfer();
        dt.items.add(file);
        photoOption.files = dt.files;
        photoOption.dispatchEvent(new Event('change', { bubbles: true }));
        
        // Wait for preview to load
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Find and click send - try multiple selectors
        const sendBtn = document.querySelector('[data-testid="send"]') ||
                        document.querySelector('[aria-label="Enviar"]') ||
                        document.querySelector('[aria-label="Send"]') ||
                        document.querySelector('span[data-icon="wds-ic-send-filled"]')?.closest('[role="button"]');
        if (sendBtn) {
          debug("Clicking send button...");
          sendBtn.click();
          return true;
        } else {
          debug("No send button found after attach flow");
        }
      }
    }
    
    // Fallback: Try paste approach
    debug("Trying paste approach...");
    const inputSelectors = [
      '[data-testid="conversation-compose-box-input"]',
      'div[contenteditable="true"][data-tab="10"]',
      'footer div[contenteditable="true"]',
    ];
    
    let input = null;
    for (const sel of inputSelectors) {
      input = document.querySelector(sel);
      if (input) break;
    }
    
    if (!input) {
      debug("Could not find input for image paste");
      return false;
    }
    
    input.focus();
    
    // Try using Clipboard API if available
    if (navigator.clipboard && navigator.clipboard.write) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ [mimeType]: blob })
        ]);
        debug("Wrote to clipboard, simulating paste...");
        document.execCommand('paste');
        await new Promise(resolve => setTimeout(resolve, 1500));
      } catch (clipErr) {
        debug("Clipboard API failed:", clipErr);
      }
    }
    
    // Create a paste event with the image
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    
    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    });
    
    input.dispatchEvent(pasteEvent);
    debug("Paste event dispatched");
    
    // Also try on document
    document.dispatchEvent(pasteEvent);
    
    // Wait for WhatsApp to process the image and show the preview dialog
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Add caption if provided
    if (caption) {
      const captionInput = document.querySelector('[data-testid="media-caption-input-container"] div[contenteditable="true"]');
      if (captionInput) {
        captionInput.focus();
        document.execCommand("insertText", false, caption);
        captionInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Click the send button in the image preview dialog
    // Try multiple selectors - WhatsApp changes them periodically
    const sendBtn = document.querySelector('[data-testid="send"]') ||
                    document.querySelector('[aria-label="Enviar"]') ||
                    document.querySelector('[aria-label="Send"]') ||
                    document.querySelector('span[data-icon="wds-ic-send-filled"]')?.closest('[role="button"]') ||
                    document.querySelector('span[data-icon="send"]')?.closest('[role="button"]');
    
    if (sendBtn) {
      debug("Found send button, clicking...");
      sendBtn.click();
      debug("Image send button clicked");
      return true;
    } else {
      debug("Could not find send button for image. Available buttons:", 
            Array.from(document.querySelectorAll('[role="button"]')).map(b => b.getAttribute('aria-label')).filter(Boolean).join(', '));
      return false;
    }
  } catch (error) {
    debug("Error sending image:", error);
    return false;
  }
}

// =============================================================================
// SELF-CHAT AI
// =============================================================================

/**
 * Get the text of the LAST visible message in the chat.
 * This is the ONLY message we ever consider for processing.
 */
function getLastMessage() {
  // Find the message container (the scrollable area)
  const container = document.querySelector('div[data-testid="conversation-panel-messages"]') ||
                    document.querySelector('#main div[role="application"]');
  
  if (!container) {
    // Fallback to old method
    const rows = document.querySelectorAll('div[data-id]');
    if (rows.length === 0) return null;
    const lastRow = rows[rows.length - 1];
    return extractMessageText(lastRow);
  }
  
  // Get all message rows within the container
  const rows = container.querySelectorAll('div[data-id]');
  if (rows.length === 0) return null;
  
  // Get the LAST row (bottom-most message)
  const lastRow = rows[rows.length - 1];
  
  // Check if we're scrolled to the bottom (important!)
  // If user scrolled up, we should NOT process old messages
  const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 200;
  
  if (!isNearBottom) {
    // User scrolled up - don't process anything
    return lastSeenMessageText; // Return cached value to prevent processing
  }
  
  return extractMessageText(lastRow);
}

/**
 * Extract text content from a message row element
 */
function extractMessageText(row) {
  if (!row) return null;
  
  const textSelectors = [
    'span[data-testid="selectable-text"]',
    'span.selectable-text',
    '.copyable-text span',
    "span[dir='ltr']",
  ];
  
  for (const sel of textSelectors) {
    const textEl = row.querySelector(sel);
    if (textEl?.innerText?.trim()) {
      return textEl.innerText.trim();
    }
  }
  
  return null;
}

/**
 * Reset state for new chat - just capture the current last message
 */
function resetObserverState() {
  aiResponsePending = false;
  
  // Capture the LAST message text - this is what we'll compare against
  lastSeenMessageText = getLastMessage() || "";
  
  debug(`Observer reset. Last message: "${lastSeenMessageText.slice(0, 50)}..."`);
}

let pollInterval = null;

function startMessageObserver() {
  // Check if a chat is open
  const mainPanel = document.querySelector('#main');
  if (!mainPanel) {
    debug("No chat open (#main not found), will retry when chat opens...");
    observerStarted = false;
    return;
  }

  // Already polling?
  if (pollInterval) {
    return;
  }

  // Reset state - capture current last message
  resetObserverState();
  observerStarted = true;
  debug("Starting message poll (checking every 500ms)");

  // Simple polling: check if last message changed
  pollInterval = setInterval(() => {
    // Skip if extension is disabled
    if (!extensionEnabled) return;
    
    // Skip if not ready or if we're in the middle of sending a response
    if (!selfChatEnabled || !bridgeConnected || aiResponsePending || sendingMessage) return;

    // STRICT: Only process messages in self-chat, never other chats
    if (!isSelfChat()) {
      // Silently ignore - we're not in self-chat
      return;
    }

    // Get the last message at the BOTTOM of the chat
    const currentLastMessage = getLastMessage();
    if (!currentLastMessage) return;

    // Same as before? Skip.
    if (currentLastMessage === lastSeenMessageText) return;

    // Update cache IMMEDIATELY to prevent loops
    lastSeenMessageText = currentLastMessage;

    // Check if this is a message we should process
    if (!shouldProcessMessage(currentLastMessage)) {
      // AI response or empty - ignore
      debug("Ignoring AI response or empty message");
      return;
    }

    // User message detected - send to bridge!
    debug("User message:", currentLastMessage.slice(0, 50));
    processIncomingMessage(currentLastMessage, currentLastMessage);
  }, 500);
}

/**
 * Check if a message is from the AI (has robot prefix).
 * AI responses ALWAYS start with 🤖 - this is our reliable marker.
 */
function isAIResponse(text) {
  const trimmed = text.trim();
  return trimmed.startsWith("🤖");
}

// No local shortcuts - all commands go through Pilot via events

/**
 * Check if a message should be processed by the bridge.
 * 
 * Logic:
 * - If starts with 🤖 → AI response → IGNORE
 * - If starts with / → Local shortcut → PROCESS
 * - Otherwise → User message for AI → PROCESS
 */
function shouldProcessMessage(text) {
  if (!text || text.trim().length === 0) return false;
  
  // AI responses are never processed (we sent them!)
  if (isAIResponse(text)) return false;
  
  // Everything else is a user message
  return true;
}

function stopMessageObserver() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  observerStarted = false;
  debug("Message poll stopped");
}

/**
 * Auto-click on self-chat to open it
 */
function clickSelfChat() {
  debug("Attempting to find and click self-chat...");

  // Method 1: Look for the "(você)" span in the chat list
  const voceSpan = document.querySelector('span.xjuopq5');
  if (voceSpan?.innerText?.includes("você")) {
    const clickTarget = voceSpan.closest('[role="row"], [role="listitem"], div[data-testid]');
    if (clickTarget) {
      debug("Found self-chat via (você) span, clicking...");
      clickTarget.click();
      return true;
    }
  }

  // Method 2: Look for cell-frame-container with "(você)" text
  const cellFrames = document.querySelectorAll('[data-testid="cell-frame-container"]');
  for (const frame of cellFrames) {
    if (frame.innerText?.includes("(você)") || frame.innerText?.includes("você")) {
      debug("Found self-chat via cell-frame text, clicking...");
      frame.click();
      return true;
    }
  }

  // Method 3: Look for chat row with self patterns
  const chatRows = document.querySelectorAll('[role="listitem"], [role="row"], ._ak72');
  for (const row of chatRows) {
    const text = row.innerText?.toLowerCase() || "";

    // Check for self-chat patterns
    if (text.includes("(você)") || 
        text.includes("message yourself") || 
        text.includes("mensagem para você")) {
      debug("Found self-chat row by text pattern, clicking...");
      row.click();
      return true;
    }
  }

  // Method 4: Look for span with title containing user's name + (você)
  const titleSpans = document.querySelectorAll('span[title]');
  for (const span of titleSpans) {
    const title = span.getAttribute("title")?.toLowerCase() || "";
    if (title.includes("você") || title.includes("yourself")) {
      const clickTarget = span.closest('[role="row"], [role="listitem"], ._ak72');
      if (clickTarget) {
        debug("Found self-chat via title span, clicking...");
        clickTarget.click();
        return true;
      }
    }
  }

  debug("Could not find self-chat to auto-click");
  return false;
}

/**
 * Show an approval button next to a message (for manual approval mode)
 */
function processIncomingMessage(messageId, text) {
  if (aiResponsePending) {
    debug("Skipping - AI response still pending");
    return;
  }

  aiResponsePending = true;

  debug("Sending to bridge:", text.slice(0, 50), "speakerMode:", speakerMode);

  // Send to bridge
  sendFrame({
    type: "message",
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    domain: DOMAIN_ID,
    text,
    chatId: getChatName(),
    isSelf: true,
    timestamp: Date.now(),
    speakerMode: speakerMode, // Include speaker mode flag
  });
}

// =============================================================================
// INIT
// =============================================================================

function init() {
  debug("Initializing WhatsApp domain...");

  // Create UI
  createStatusBadge();

  // Listen for toggle messages from background script (extension icon click)
  if (typeof chrome !== "undefined" && chrome.runtime) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === "toggleEnabled") {
        extensionEnabled = message.enabled;
        updateEnableToggle();
        debug("Extension toggled from icon:", extensionEnabled ? "ON" : "OFF");
        
        if (!extensionEnabled) {
          stopMessageObserver();
          // Disconnect WebSocket when disabled
          if (bridgeSocket) {
            bridgeSocket.close();
            bridgeSocket = null;
            bridgeConnected = false;
          }
        } else {
          // Connect to bridge when enabled
          connectToBridge();
          startWhatsAppSetup();
        }
      }
    });
  }

  // Connection and setup happens in createStatusBadge after checking enabled state

  debug("WhatsApp domain initialized");
}

/**
 * Start WhatsApp-specific setup (called after connecting when enabled)
 */
function startWhatsAppSetup() {
  // Wait for WhatsApp to fully load, then set up
  setTimeout(() => {
    // Try to auto-click self-chat if no chat is open
    if (!document.querySelector('#main')) {
      debug("No chat open, trying to auto-click self-chat...");
      const clicked = clickSelfChat();
      if (clicked) {
        // Wait for chat to load, then capture initial messages and start observer
        setTimeout(() => {
          debug("Chat should be loaded, capturing initial messages...");
          startMessageObserver();
        }, 2000);
      }
    } else {
      // Chat is already open - wait a bit for messages to fully render before capturing
      setTimeout(() => {
        debug("Chat already open, capturing initial messages...");
        startMessageObserver();
      }, 1000);
    }

    // Watch for chat changes - stop and restart observer with fresh state
    let currentChatName = getChatName();
    
    const sidePane = document.querySelector("#pane-side");
    if (sidePane) {
      let debounceTimer = null;
      new MutationObserver(() => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const newChatName = getChatName();
          if (newChatName !== currentChatName && newChatName !== "unknown") {
            debug("Chat changed from", currentChatName, "to", newChatName);
            currentChatName = newChatName;
            // Stop old observer, restart fresh
            stopMessageObserver();
            startMessageObserver();
          }
        }, 500);
      }).observe(sidePane, { childList: true, subtree: true });
    }

    // Watch for #main appearing (when any chat is opened)
    const appContainer = document.querySelector('#app');
    if (appContainer) {
      new MutationObserver(() => {
        if (document.querySelector('#main') && !observerStarted) {
          debug("Chat opened, starting observer...");
          currentChatName = getChatName();
          startMessageObserver();
        }
      }).observe(appContainer, { childList: true, subtree: true });
    }
  }, 3000);

  debug("WhatsApp domain initialized");
}

// Run on load
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// Expose for debugging
window.__meshBridge = {
  connect: connectToBridge,
  status: () => ({ connected: bridgeConnected, sessionId }),
  sendMessage: (text) => sendWhatsAppMessage(text),
};


