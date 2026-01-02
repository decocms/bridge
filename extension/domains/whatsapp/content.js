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
let messageObserver = null;
let observerStarted = false;
let lastObserverTarget = null;
let processedMessageIds = new Set(); // Track messages we've already processed
let observerStartTime = 0; // Timestamp when we started observing - ignore older messages
let lastSeenMessageText = ""; // Last message text we saw - for deduplication

// Debug/Manual Approval Mode - when ON, shows a button to approve each message instead of auto-processing
let manualApprovalMode = true; // Start with manual mode ON for debugging
let pendingApprovals = new Map(); // Map of textKey -> { text, element }
let seenElements = new WeakSet(); // Track DOM elements we've already processed

// =============================================================================
// LOGGING
// =============================================================================

function debug(...args) {
  if (DEBUG) {
    console.log(`[mesh-bridge:${DOMAIN_ID}]`, ...args);
  }
}

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
      updateStatusUI("disconnected");

      // Auto-reconnect
      if (!reconnectInterval) {
        reconnectInterval = setInterval(connectToBridge, 5000);
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
  }
}

function handleBridgeFrame(frame) {
  debug("Received frame:", frame.type);

  switch (frame.type) {
    case "connected":
      sessionId = frame.sessionId;
      bridgeConnected = true;
      updateStatusUI("connected");
      if (reconnectInterval) {
        clearInterval(reconnectInterval);
        reconnectInterval = null;
      }
      debug("Connected! Session:", sessionId, "Domain:", frame.domain);
      break;

    case "send":
      // AI response - inject into WhatsApp
      sendWhatsAppMessage(frame.text);
      aiResponsePending = false;
      break;

    case "response":
      // Command response - inject into chat
      if (frame.text) {
        sendWhatsAppMessage(frame.text);
      }
      aiResponsePending = false;
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
      #mesh-bridge-badge {
        position: fixed;
        top: 8px;
        left: 50%;
        transform: translateX(-50%);
        padding: 6px 14px;
        background: #1a1a1a;
        color: white;
        border-radius: 16px;
        font-size: 11px;
        font-family: system-ui, -apple-system, sans-serif;
        z-index: 10000;
        display: flex;
        align-items: center;
        gap: 6px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        cursor: default;
        transition: all 0.2s ease;
        opacity: 0.7;
      }
      #mesh-bridge-badge:hover {
        opacity: 1;
        padding: 8px 16px;
      }
      #mesh-bridge-badge .details {
        display: none;
        margin-left: 8px;
        padding-left: 8px;
        border-left: 1px solid #444;
        font-size: 10px;
        color: #aaa;
      }
      #mesh-bridge-badge:hover .details {
        display: flex;
        gap: 12px;
      }
      #mesh-bridge-badge .status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #666;
        flex-shrink: 0;
      }
      #mesh-bridge-badge.connected .status-dot {
        background: #00cc66;
        box-shadow: 0 0 4px #00cc66;
      }
      #mesh-bridge-badge .mode-toggle {
        display: none;
        margin-left: 8px;
        padding: 3px 8px;
        background: #333;
        border-radius: 10px;
        cursor: pointer;
        font-size: 10px;
        transition: all 0.2s ease;
      }
      #mesh-bridge-badge:hover .mode-toggle {
        display: block;
      }
      #mesh-bridge-badge .mode-toggle:hover {
        background: #444;
      }
      #mesh-bridge-badge .mode-toggle.auto {
        background: #ff6b35;
        color: white;
      }
      #mesh-bridge-badge .mode-toggle.manual {
        background: #25d366;
        color: white;
      }
    </style>
    <div id="mesh-bridge-badge">
      <span class="status-dot"></span>
      <span class="status-text">Mesh Bridge</span>
      <span class="details">
        <span class="detail-session">—</span>
        <span class="detail-domain">—</span>
      </span>
      <span class="mode-toggle manual">🔒 Manual</span>
    </div>
  `;
  document.body.appendChild(badge);
  
  // Add click handler for mode toggle
  const toggle = badge.querySelector(".mode-toggle");
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    manualApprovalMode = !manualApprovalMode;
    updateModeToggle();
    
    if (!manualApprovalMode) {
      // Clear any pending approval buttons when switching to auto
      clearApprovalButtons();
    }
    
    debug("Manual approval mode:", manualApprovalMode ? "ON" : "OFF");
  });
}

function updateModeToggle() {
  const toggle = document.querySelector("#mesh-bridge-badge .mode-toggle");
  if (!toggle) return;
  
  if (manualApprovalMode) {
    toggle.textContent = "🔒 Manual";
    toggle.className = "mode-toggle manual";
  } else {
    toggle.textContent = "⚡ Auto";
    toggle.className = "mode-toggle auto";
  }
}

function updateStatusUI(status) {
  const badgeContainer = document.getElementById("mesh-bridge-badge");
  if (!badgeContainer) return;

  const text = badgeContainer.querySelector(".status-text");
  const detailSession = badgeContainer.querySelector(".detail-session");
  const detailDomain = badgeContainer.querySelector(".detail-domain");

  if (status === "connected") {
    badgeContainer.classList.add("connected");
    text.textContent = "Mesh Bridge";
    detailSession.textContent = sessionId ? `Session: ${sessionId.slice(-8)}` : "—";
    detailDomain.textContent = `Domain: ${DOMAIN_ID}`;
  } else {
    badgeContainer.classList.remove("connected");
    text.textContent = "Mesh Bridge";
    detailSession.textContent = "Disconnected";
    detailDomain.textContent = "—";
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

  // Focus and type
  input.focus();
  input.innerHTML = "";
  document.execCommand("insertText", false, text);

  // Trigger events
  input.dispatchEvent(new Event("input", { bubbles: true }));

  await new Promise((resolve) => setTimeout(resolve, 100));

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

// =============================================================================
// SELF-CHAT AI
// =============================================================================

/**
 * Reset state for new chat observation.
 * Instead of capturing message IDs (which are unreliable with WhatsApp's virtual scroll),
 * we use a timestamp-based approach: only process messages received AFTER we start watching.
 */
function resetObserverState() {
  processedMessageIds.clear();
  aiResponsePending = false;
  observerStartTime = Date.now();
  seenElements = new WeakSet(); // Reset seen elements
  
  // Mark ALL currently visible message rows as "seen" so we don't process them
  const existingRows = document.querySelectorAll('div[data-id], .message-in, .message-out, [role="row"]');
  for (const row of existingRows) {
    seenElements.add(row);
  }
  
  // Capture the last visible message text to avoid processing it as "new"
  const lastMsg = getLastVisibleMessageText();
  lastSeenMessageText = lastMsg || "";
  
  debug(`Observer state reset. Marked ${existingRows.length} existing rows as seen. Last text: "${lastSeenMessageText.slice(0, 30)}..."`);
}

/**
 * Get the text of the last visible message (for deduplication)
 */
function getLastVisibleMessageText() {
  const rows = document.querySelectorAll('.message-in, .message-out, [role="row"]');
  if (rows.length === 0) return null;
  
  const lastRow = rows[rows.length - 1];
  const textEl = lastRow.querySelector('span[data-testid="selectable-text"]') ||
                 lastRow.querySelector(".copyable-text span") ||
                 lastRow.querySelector("span[dir='ltr']");
  
  return textEl?.innerText?.trim() || null;
}

function startMessageObserver() {
  // Check if a chat is open (look for #main which appears when a chat is selected)
  const mainPanel = document.querySelector('#main');
  if (!mainPanel) {
    debug("No chat open (#main not found), will retry when chat opens...");
    observerStarted = false;
    lastObserverTarget = null;
    return;
  }

  // Don't restart if already observing the same target
  if (observerStarted && lastObserverTarget === mainPanel) {
    return;
  }

  // Disconnect old observer if exists
  if (messageObserver) {
    messageObserver.disconnect();
  }

  // Reset state for this new observation session
  // This sets observerStartTime and captures last message text for deduplication
  resetObserverState();

  // Use #main as the observation target
  const messagesContainer = mainPanel;
  lastObserverTarget = mainPanel;
  observerStarted = true;
  debug("Setting up message observer on #main");

  messageObserver = new MutationObserver((mutations) => {
    if (!selfChatEnabled || !bridgeConnected || aiResponsePending) return;

    const inSelfChat = isSelfChat();
    if (!inSelfChat) {
      // Log occasionally to help debug
      if (Math.random() < 0.01) debug("Not in self-chat, skipping");
      return;
    }

    // Wait 3 seconds after observer starts before processing any messages
    // This prevents processing messages that existed before we started watching
    // Also gives WhatsApp time to finish rendering all existing messages
    const timeSinceStart = Date.now() - observerStartTime;
    if (timeSinceStart < 3000) {
      return;
    }

    // Check for new messages
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        // Try to find the message row
        const msgRow = node.closest?.("div[data-id]") || 
                       node.querySelector?.("div[data-id]") ||
                       node.closest?.(".message-in, .message-out") ||
                       node.querySelector?.(".message-in, .message-out") ||
                       node.closest?.('[role="row"]') ||
                       node.querySelector?.('[role="row"]');

        if (!msgRow) continue;
        
        // Skip if we've already seen this DOM element (handles virtual scrolling)
        if (seenElements.has(msgRow)) continue;
        seenElements.add(msgRow);

        // Get message text
        const textSelectors = [
          'span[data-testid="selectable-text"]',
          "span.selectable-text",
          ".copyable-text span",
          "span[dir='ltr']",
        ];

        let text = "";
        for (const sel of textSelectors) {
          const textEl = msgRow.querySelector(sel);
          if (textEl?.innerText?.trim()) {
            text = textEl.innerText.trim();
            break;
          }
        }

        if (!text) continue;

        // ================================================================
        // AGGRESSIVE FILTERING - Skip anything that looks like AI output
        // ================================================================
        
        // Check for robot emoji ANYWHERE in the first 5 chars (handles whitespace/encoding)
        const firstChars = text.slice(0, 10);
        if (firstChars.includes("🤖") || firstChars.includes("🤖")) {
          // Already processed - skip silently
          continue;
        }
        
        // Skip long messages (AI responses tend to be longer)
        if (text.length > 200) {
          debug("Skipping - message too long (likely AI response)");
          continue;
        }
        
        // Skip messages with common AI response patterns
        const aiPatterns = [
          "No response generated",
          "I can see you've shared",
          "I apologize",
          "Could you tell me",
          "I'm not able to",
          "What would you like",
          "I can help you",
          "Posso te ajudar",
          "O que você precisa",
          "Tudo certo por aí",
          "Ler mais",  // "Read more" truncation
          "Copy/paste",
          "Tell me the main",
          "Ask specific questions",
          "steipete.me",  // URLs from previous responses
          "browser_cookie",  // Code snippets from previous responses
          "Oi! 👋",  // AI greeting pattern
          "Opa! 😅",  // AI greeting pattern
          "Em que posso",  // AI Portuguese patterns
        ];
        
        let isAiResponse = false;
        for (const pattern of aiPatterns) {
          if (text.includes(pattern)) {
            debug("Skipping AI response (matches pattern):", pattern);
            isAiResponse = true;
            break;
          }
        }
        if (isAiResponse) continue;
        
        // TEXT-BASED DEDUPLICATION
        const textKey = text.slice(0, 100);
        
        // Skip if we've already processed this exact text
        if (processedMessageIds.has(textKey)) continue;
        
        // Skip if this was the last message we saw when starting
        if (text === lastSeenMessageText) {
          debug("Skipping - matches last seen message");
          continue;
        }

        // Mark as processed BEFORE we do anything else
        processedMessageIds.add(textKey);

        debug("New user message:", text.slice(0, 50));
        
        if (manualApprovalMode) {
          // Show approval button instead of auto-processing
          showApprovalButton(msgRow, textKey, text);
        } else {
          processIncomingMessage(textKey, text);
        }
      }
    }
  });

  messageObserver.observe(messagesContainer, {
    childList: true,
    subtree: true,
  });

  observerStarted = true;
  debug("Message observer started (observing #main)");
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
function showApprovalButton(msgRow, textKey, text) {
  // Check if we already have a button for this message
  if (pendingApprovals.has(textKey)) return;
  
  // Create approval button
  const btn = document.createElement("button");
  btn.className = "mesh-bridge-approve-btn";
  btn.innerHTML = "🤖 Process with AI";
  btn.style.cssText = `
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    background: linear-gradient(135deg, #25d366 0%, #128c7e 100%);
    color: white;
    border: none;
    border-radius: 16px;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    z-index: 1000;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    transition: all 0.2s ease;
  `;
  
  btn.onmouseover = () => {
    btn.style.transform = "translateY(-50%) scale(1.05)";
    btn.style.boxShadow = "0 4px 12px rgba(0,0,0,0.4)";
  };
  btn.onmouseout = () => {
    btn.style.transform = "translateY(-50%) scale(1)";
    btn.style.boxShadow = "0 2px 8px rgba(0,0,0,0.3)";
  };
  
  btn.onclick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    
    // Remove button
    btn.remove();
    pendingApprovals.delete(textKey);
    
    // Process the message
    debug("Manual approval: processing message");
    processIncomingMessage(textKey, text);
  };
  
  // Make the message row position relative so we can position the button
  const originalPosition = msgRow.style.position;
  msgRow.style.position = "relative";
  
  msgRow.appendChild(btn);
  pendingApprovals.set(textKey, { text, element: btn, msgRow, originalPosition });
  
  debug("Showing approval button for:", text.slice(0, 30));
}

/**
 * Clear all pending approval buttons
 */
function clearApprovalButtons() {
  for (const [key, data] of pendingApprovals) {
    if (data.element?.parentNode) {
      data.element.remove();
    }
    if (data.msgRow && data.originalPosition !== undefined) {
      data.msgRow.style.position = data.originalPosition;
    }
  }
  pendingApprovals.clear();
}

function processIncomingMessage(messageId, text) {
  if (aiResponsePending) {
    debug("Skipping - AI response still pending");
    return;
  }

  aiResponsePending = true;

  debug("Sending to bridge:", text.slice(0, 50));

  // Send to bridge
  sendFrame({
    type: "message",
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    domain: DOMAIN_ID,
    text,
    chatId: getChatName(),
    isSelf: true,
    timestamp: Date.now(),
  });
}

// =============================================================================
// INIT
// =============================================================================

function init() {
  debug("Initializing WhatsApp domain...");

  // Create UI
  createStatusBadge();

  // Connect to bridge
  connectToBridge();

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

    // Watch for chat changes (when user clicks different chats)
    const sidePane = document.querySelector("#pane-side");
    if (sidePane) {
      let debounceTimer = null;
      new MutationObserver(() => {
        // Debounce - only restart after mutations stop for 500ms
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (document.querySelector('#main')) {
            startMessageObserver();
          }
        }, 500);
      }).observe(sidePane, { childList: true, subtree: true });
    }

    // Also watch for #main appearing (when any chat is opened)
    const appContainer = document.querySelector('#app');
    if (appContainer) {
      new MutationObserver(() => {
        if (document.querySelector('#main') && !observerStarted) {
          debug("Chat opened, starting observer...");
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


