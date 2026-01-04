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

// Grace period after chat changes - prevents processing stale messages
let chatChangeGracePeriod = false;

// =============================================================================
// LOGGING
// =============================================================================

function debug(...args) {
  if (DEBUG) {
    console.log(`[bridge]`, ...args);
  }
}

/**
 * Message Queue - Sends important milestones + final response
 * 
 * Uses a proper queue to prevent race conditions with concurrent sends.
 * Messages are sent one at a time, in order.
 */
const messageQueue = {
  queue: [],
  isProcessing: false,
  thinkingSent: false,
  
  // Add message to queue and start processing
  enqueue(text, isResponse = false) {
    this.queue.push({ text, isResponse });
    this.processQueue();
  },
  
  // Process queue one message at a time
  async processQueue() {
    if (this.isProcessing) return;
    if (this.queue.length === 0) return;
    
    this.isProcessing = true;
    sendingMessage = true;
    
    while (this.queue.length > 0) {
      const { text, isResponse } = this.queue.shift();
      
      try {
        debug(isResponse ? "📨" : "📢", text.slice(0, 60));
        await sendWhatsAppMessage(text);
        
        // Wait for DOM to update
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // Update cache
        const newLastMsg = getLastMessage();
        if (newLastMsg) lastSeenMessageText = newLastMsg;
        
        // Reset thinking flag after response
        if (isResponse) this.thinkingSent = false;
      } catch (err) {
        debug("❌ Send failed:", err);
      }
    }
    
    this.isProcessing = false;
    setTimeout(() => { sendingMessage = false; }, 300);
  },
  
  // Show that we're thinking (only once per task)
  showThinking() {
    if (this.thinkingSent) return;
    this.thinkingSent = true;
    this.enqueue("🤖 _thinking..._");
  },
  
  // Check if this is an IMPORTANT progress message (step-level)
  isImportantProgress(msg) {
    if (!msg) return false;
    const m = msg.toLowerCase();
    
    // Phase changes (FAST: Thinking/Done, SMART: Thinking/Done/Skipped)
    if (m.includes("fast:") && (m.includes("thinking") || m.includes("done"))) return true;
    if (m.includes("smart:") && (m.includes("thinking") || m.includes("done") || m.includes("skipped"))) return true;
    
    // Workflow milestones
    if (m.includes("starting workflow:")) return true;
    if (m.includes("workflow completed")) return true;
    if (msg.startsWith("▶️")) return true;
    if (m.includes("skipped")) return true;
    
    return false;
  },
  
  // Handle progress - send important ones to chat, log rest to console
  addProgress(msg) {
    if (!msg) return;
    
    if (this.isImportantProgress(msg)) {
      this.enqueue(`🤖 ${msg}`);
    } else {
      debug(msg);
    }
  },
  
  // Set the response - queue it (high priority via flag)
  setResponse(text) {
    this.enqueue(text, true);
  },
  
  // Reset state
  reset() {
    this.thinkingSent = false;
    this.queue = [];
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
  // Only log important frames, skip noisy ones
  if (!["pong", "agent_progress"].includes(frame.type)) {
    debug("←", frame.type);
  }

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
      
      debug("✓ Connected");
      
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
      // AI response - send immediately
      aiResponsePending = false;
      messageQueue.setResponse(frame.text);
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
      // Error from bridge - show in badge, DON'T send to chat (becomes stale)
      debug("⚠️", frame.code, frame.message);
      aiResponsePending = false;
      setProcessing(false);
      
      // Flash badge to indicate error
      const badge = document.getElementById("mesh-bridge-badge");
      if (badge) {
        badge.style.background = "#ff6600";
        badge.title = frame.message || "Error";
        setTimeout(() => {
          badge.style.background = "";
          badge.title = "Mesh Bridge";
        }, 3000);
      }
      
      if (frame.code === "credentials_stale") {
        updateStatusUI("reconnecting");
        bridgeConnected = false;
        sessionId = null;
        if (bridgeSocket) bridgeSocket.close();
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
      // Note: "thinking" message now comes from workflow progress (FAST: Thinking...)
      setProcessing(true);
      break;

    case "processing_ended":
      setProcessing(false);
      break;

    case "agent_progress":
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

// Cache self-chat detection to avoid logging on every poll
let lastSelfChatState = null;
let lastSelfChatName = null;

function isSelfChat() {
  const chatName = getChatName().toLowerCase();
  
  // If chat name changed, reset cache
  if (chatName !== lastSelfChatName) {
    lastSelfChatName = chatName;
    lastSelfChatState = null;
  }
  
  // Return cached result if available (don't re-log)
  if (lastSelfChatState !== null) {
    return lastSelfChatState;
  }

  // Check for "(você)" which is the explicit self-chat marker in Portuguese
  if (chatName.includes("(você)")) {
    debug("Self-chat detected: (você) in chat name");
    lastSelfChatState = true;
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
      lastSelfChatState = true;
      return true;
    }
  }

  // Check for self-chat badge (WhatsApp marks self-chats)
  if (document.querySelector('[data-testid="self"]')) {
    debug("Self-chat detected via [data-testid='self']");
    lastSelfChatState = true;
    return true;
  }

  // Check header for (você) span - from user's HTML structure
  const vocalSpan = document.querySelector('#main header span.xjuopq5');
  if (vocalSpan?.innerText?.toLowerCase().includes("você")) {
    debug("Self-chat detected via header (você) span");
    lastSelfChatState = true;
    return true;
  }

  lastSelfChatState = false;
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
 * 
 * WhatsApp structure:
 * - .copyable-text contains the message + timestamp metadata in data-* attrs
 * - Inside copyable-text, there's a span.selectable-text with JUST the message
 * - The timestamp is in a separate element (not in selectable-text)
 * 
 * IMPORTANT: We target selectable-text to avoid capturing timestamps!
 */
function extractMessageText(row) {
  if (!row) return null;
  
  // Best selector: selectable-text contains ONLY the message, no timestamp
  const selectableText = row.querySelector('span.selectable-text.copyable-text');
  if (selectableText) {
    // Get innerText to get rendered text with emojis
    const text = selectableText.innerText?.trim();
    if (text) return text;
  }
  
  // Try the span inside selectable-text (WhatsApp nests them)
  const innerSpan = row.querySelector('span.selectable-text span');
  if (innerSpan) {
    const text = innerSpan.innerText?.trim();
    if (text) return text;
  }
  
  // Fallback selectors - try to avoid timestamp elements
  const textSelectors = [
    'span[data-testid="selectable-text"]',
    'span.selectable-text',
    // Avoid .copyable-text directly as it may include timestamp
  ];
  
  for (const sel of textSelectors) {
    const textEl = row.querySelector(sel);
    if (textEl) {
      const text = textEl.innerText?.trim();
      if (text) return text;
    }
  }
  
  // Last resort: try copyable-text but extract only the first span
  const copyableText = row.querySelector('.copyable-text');
  if (copyableText) {
    const firstSpan = copyableText.querySelector('span');
    if (firstSpan) {
      const text = firstSpan.innerText?.trim();
      if (text) return text;
    }
  }
  
  return null;
}

/**
 * Reset state for new chat - just capture the current last message
 * Uses a grace period to let the DOM fully update after chat changes
 */
function resetObserverState() {
  aiResponsePending = false;
  
  // Reset self-chat detection cache
  lastSelfChatState = null;
  lastSelfChatName = null;
  
  // Start grace period - don't process any messages for a bit
  chatChangeGracePeriod = true;
  
  // Wait for DOM to fully update, then capture last message
  setTimeout(() => {
    lastSeenMessageText = getLastMessage() || "";
    debug(`Observer reset. Last message: "${lastSeenMessageText.slice(0, 50)}..."`);
    
    // End grace period after capturing the state
    setTimeout(() => {
      chatChangeGracePeriod = false;
      debug("Grace period ended, ready to process messages");
    }, 500);
  }, 500);
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
    
    // Skip during grace period after chat changes
    if (chatChangeGracePeriod) return;
    
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
 * Check if a message is from the AI (has robot prefix or is a known AI pattern).
 * AI responses ALWAYS start with 🤖 - this is our reliable marker.
 * 
 * NOTE: WhatsApp sometimes renders emojis in separate DOM elements,
 * so we also check for known AI message patterns as a fallback.
 */
function isAIResponse(text) {
  const trimmed = text.trim();
  
  // Primary check: starts with robot emoji
  if (trimmed.startsWith("🤖")) return true;
  
  // Fallback: check for known AI message patterns
  // These are messages the AI/bridge sends that might lose their emoji prefix
  const aiPatterns = [
    "Waiting for Mesh credentials",
    "Could not reach Pilot agent",
    "thinking...",
    "_thinking..._",
    "Validating tools for:",
    "Starting workflow:",
    "FAST:",
    "SMART:",
    "Workflow completed",
  ];
  
  for (const pattern of aiPatterns) {
    if (trimmed.includes(pattern)) {
      debug("Detected AI message via pattern:", pattern);
      return true;
    }
  }
  
  return false;
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
 * Simulate a real click on an element (WhatsApp uses React, needs proper events)
 */
function simulateClick(element) {
  if (!element) return false;
  
  // Get element center coordinates
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  
  // Create and dispatch mouse events in sequence
  const events = ['mousedown', 'mouseup', 'click'];
  for (const eventType of events) {
    const event = new MouseEvent(eventType, {
      view: window,
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
    });
    element.dispatchEvent(event);
  }
  
  return true;
}

/**
 * Auto-click on self-chat to open it
 */
function clickSelfChat() {
  debug("Attempting to find and click self-chat...");
  
  // Get the chat list container
  const chatList = document.querySelector('#pane-side') || 
                   document.querySelector('[aria-label*="Chat list"]') ||
                   document.querySelector('[data-testid="chat-list"]');
  
  if (!chatList) {
    debug("Chat list not found, WhatsApp may still be loading...");
    return false;
  }

  // Method 1: Look for chat items with "(você)" text - most reliable
  const allChatItems = chatList.querySelectorAll('[data-testid="cell-frame-container"], [role="listitem"], [role="row"]');
  debug(`Found ${allChatItems.length} chat items to scan`);
  
  for (const item of allChatItems) {
    const text = item.innerText?.toLowerCase() || "";
    
    // Check for self-chat patterns
    if (text.includes("(você)") || 
        text.includes("message yourself") || 
        text.includes("mensagem para você mesmo") ||
        text.includes("(you)")) {
      
      debug("Found self-chat item:", text.slice(0, 50));
      
      // Collect all potential clickable elements
      const clickTargets = [];
      
      // The chat name/title span - usually the most reliable
      const nameSpan = item.querySelector('span[title]');
      if (nameSpan) clickTargets.push({ el: nameSpan, name: 'name-span' });
      
      // Avatar image
      const avatar = item.querySelector('img');
      if (avatar) clickTargets.push({ el: avatar, name: 'avatar' });
      
      // Any div with role="gridcell" 
      const gridCell = item.querySelector('[role="gridcell"]');
      if (gridCell) clickTargets.push({ el: gridCell, name: 'gridcell' });
      
      // The item's parent row if it has role
      const row = item.closest('[role="row"]');
      if (row && row !== item) clickTargets.push({ el: row, name: 'row' });
      
      // The item itself
      clickTargets.push({ el: item, name: 'item' });
      
      debug(`Trying ${clickTargets.length} click targets...`);
      
      // Try clicking each target with a small delay
      let targetIndex = 0;
      const tryNextTarget = () => {
        if (document.querySelector('#main')) {
          debug("Chat opened!");
          return;
        }
        
        if (targetIndex >= clickTargets.length) {
          debug("All targets tried");
          return;
        }
        
        const target = clickTargets[targetIndex];
        debug(`Trying target ${targetIndex + 1}/${clickTargets.length}: ${target.name}`);
        
        // Try both simulated and real click
        simulateClick(target.el);
        target.el.click();
        
        // Also try focusing and pressing Enter
        target.el.focus?.();
        target.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        
        targetIndex++;
        setTimeout(tryNextTarget, 200);
      };
      
      tryNextTarget();
      return true;
    }
  }

  // Method 2: Look for span with title containing self-chat patterns
  const titleSpans = chatList.querySelectorAll('span[title]');
  for (const span of titleSpans) {
    const title = span.getAttribute("title")?.toLowerCase() || "";
    if (title.includes("você") || title.includes("yourself") || title.includes("(you)")) {
      debug("Found self-chat via title:", title.slice(0, 30));
      
      // Navigate up to find the row/listitem
      const row = span.closest('[role="row"], [role="listitem"], [data-testid="cell-frame-container"]');
      if (row) {
        simulateClick(row);
        return true;
      }
    }
  }

  debug("Could not find self-chat in chat list");
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
        // Wait for chat to load, verify it opened, then start observer
        let retries = 0;
        const checkChatOpened = () => {
          if (document.querySelector('#main')) {
            debug("Chat opened successfully!");
            startMessageObserver();
          } else if (retries < 3) {
            retries++;
            debug(`Chat not open yet, retry ${retries}/3...`);
            // Try clicking again
            clickSelfChat();
            setTimeout(checkChatOpened, 1500);
          } else {
            debug("Failed to open self-chat after 3 retries");
          }
        };
        setTimeout(checkChatOpened, 1500);
      } else {
        debug("Could not find self-chat, waiting for manual selection...");
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


