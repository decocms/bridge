# Blog Post Draft: Introducing Mesh Bridge

> Technical blog post structure for announcing Mesh Bridge. Focus on Event Bus, DOM→Event mapping, and enabling MCPs to react to/generate website events.

---

## Title Options

1. "Mesh Bridge: Turning Any Website Into an MCP Event Stream"
2. "The DOM Is the Wrong Abstraction for AI—Here's What We Built Instead"
3. "Event-Driven Browser Automation: How We Connected WhatsApp to MCP Mesh"

---

## Hook (150 words)

I'm writing this blog post from WhatsApp.

Not metaphorically. I typed this entire article as messages to myself in WhatsApp Web. Each message became an event. The event triggered an AI agent. The agent called MCP tools—including the one that creates articles on my blog.

This is Mesh Bridge: a Chrome extension that translates DOM events into MCP Event Bus messages. Any website becomes an event stream. Any MCP can subscribe to those events. Any MCP can publish events that mutate the DOM.

Today I'm open-sourcing it.

---

## Section 1: The Problem (300 words)

### The DOM is the wrong abstraction for AI

When AI agents interact with websites, they typically do one of two things:

1. **Screenshot + Vision**: Take a picture, send to GPT-4V, hope it figures out where to click
2. **DOM Dump**: Serialize the entire DOM, send thousands of tokens, hope the model parses it correctly

Both approaches are expensive, fragile, and slow.

**The DOM is too granular.** A single WhatsApp message involves dozens of nested divs, spans, and data attributes. The semantic information—"this is a message from the user"—is buried in noise.

**The DOM is unstable.** WhatsApp (and every other site) changes their class names, restructures their HTML, tweaks their React components. Automations break constantly.

**The DOM is verbose.** Serializing page structure consumes context windows. You're spending tokens on `<div class="x1n2onr6 x1vjfegm">` instead of actual reasoning.

### What if we compiled the DOM into something simpler?

The insight behind Mesh Bridge: **pre-compile site-specific DOM knowledge into a thin event layer.**

Instead of sending the DOM to the AI, we send structured events:

```typescript
// Not this (DOM)
<div data-id="msg-123" class="message-out">
  <span class="selectable-text">Hello world</span>
</div>

// This (Event)
{ type: "user.message.received", text: "Hello world", source: "whatsapp" }
```

The compilation happens in a **domain script**—a content script that understands one specific website's DOM structure.

---

## Section 2: How It Works (400 words)

### The Event Bus

MCP Mesh includes an Event Bus—a pub/sub system for CloudEvents. Any MCP can:

- **PUBLISH** events with a type and data payload
- **SUBSCRIBE** to event types with filtering
- **Receive events** via the ON_EVENTS tool

Mesh Bridge uses this event bus as the bridge between browsers and MCPs.

```
┌─────────────────────────────────────────────────────────────────┐
│                        EVENT BUS                                 │
│                                                                  │
│   user.message.received ◄─── mesh-bridge publishes              │
│   agent.response.* ───────► mesh-bridge subscribes              │
│                                                                  │
│   Other MCPs can subscribe to user.message.* too!               │
└─────────────────────────────────────────────────────────────────┘
```

### Browser → Event Bus (Publishing)

A Chrome extension injects a **content script** into websites. The script:

1. Observes DOM changes via `MutationObserver`
2. Extracts semantic meaning (message text, sender, chat)
3. Sends to bridge server via WebSocket
4. Bridge publishes to Event Bus

```javascript
// Content script observes WhatsApp messages
new MutationObserver((mutations) => {
  const lastMessage = getLastMessage(); // DOM → structured data
  
  if (isNewUserMessage(lastMessage)) {
    socket.send(JSON.stringify({
      type: "message",
      text: lastMessage,
      chatId: getChatName()
    }));
  }
}).observe(messageContainer, { childList: true, subtree: true });
```

### Event Bus → Browser (Subscribing)

The bridge subscribes to `agent.response.*` events. When an event arrives:

1. Bridge receives via `ON_EVENTS` MCP tool
2. Routes to appropriate domain handler
3. Sends to extension via WebSocket
4. Content script mutates the DOM

```javascript
// Content script receives agent response
socket.onmessage = (event) => {
  const frame = JSON.parse(event.data);
  
  if (frame.type === "send") {
    // Inject into WhatsApp's input field
    const input = document.querySelector('[data-testid="conversation-compose-box-input"]');
    input.focus();
    document.execCommand("insertText", false, frame.text);
    document.querySelector('[data-testid="send"]').click();
  }
};
```

---

## Section 3: The WhatsApp Domain (500 words)

### How WhatsApp Web works with Mesh Bridge

The WhatsApp domain is our first production implementation. It enables a simple but powerful workflow: **message yourself to interact with AI.**

#### Self-Chat Detection

WhatsApp has a "Message Yourself" feature. The content script detects when you're in this chat by looking for `(você)` or `(you)` in the header. Only messages in self-chat trigger the AI—we never intercept your private conversations.

```javascript
function isSelfChat() {
  const chatName = getChatName().toLowerCase();
  return chatName.includes("(você)") || 
         chatName.includes("(you)") ||
         chatName.includes("message yourself");
}
```

#### Message Extraction

WhatsApp's DOM is... complex. Messages are nested in multiple layers of divs with generated class names. We carefully extract just the text:

```javascript
function extractMessageText(row) {
  // Target selectable-text to avoid timestamp noise
  const selectableText = row.querySelector('span.selectable-text.copyable-text');
  if (selectableText) {
    return selectableText.innerText?.trim();
  }
  // Fallback selectors for DOM changes...
}
```

#### Event Publishing

When a new message arrives, we publish to the Event Bus:

```typescript
await callMeshTool(eventBusId, "EVENT_PUBLISH", {
  type: "user.message.received",
  data: {
    text: userMessage,
    source: "whatsapp",
    chatId: message.chatId,
    sender: { name: message.metadata?.sender }
  }
});
```

#### Agent Processing

A Pilot agent (separate MCP) subscribes to `user.message.received`. It:

1. Receives the event
2. Processes with LLM (GPT-4, Claude, etc.)
3. Calls any necessary tools (web search, file access, article creation)
4. Publishes `agent.response.whatsapp` event

#### Response Injection

The bridge subscribes to `agent.response.whatsapp`. When a response arrives:

```javascript
// Convert markdown to WhatsApp formatting
let responseText = markdownToWhatsApp(event.text);

// Ensure robot prefix
if (!responseText.startsWith("🤖")) {
  responseText = "🤖 " + responseText;
}

// Send to extension
send({
  type: "send",
  chatId: event.chatId,
  text: responseText
});
```

The extension injects the response into WhatsApp's input and clicks send.

#### Speaker Mode

Optional: responses can be spoken aloud using macOS `say`:

```typescript
if (session.speakerMode && event.isFinal) {
  spawn(["say", textToSpeak]);
}
```

---

## Section 4: Why This Matters (300 words)

### MCPs Can React to Website Events

Any MCP can subscribe to `user.message.received`. Not just the Pilot agent—a logging MCP, an analytics MCP, a notification MCP. The browser becomes an event source for your entire mesh.

```typescript
// Some other MCP could subscribe too
await callTool("EVENT_SUBSCRIBE", {
  eventType: "user.message.received",
  publisherFilter: "mesh-bridge" // Only from bridge
});
```

### MCPs Can Generate Website Events

The response path works for any MCP. If your custom MCP publishes `agent.response.whatsapp`, the message appears in WhatsApp. Scheduled messages, alerts, automated responses—all possible.

```typescript
// Any MCP can send a WhatsApp message
await callTool("EVENT_PUBLISH", {
  type: "agent.response.whatsapp",
  data: {
    chatId: "some-chat",
    text: "Scheduled reminder: meeting in 10 minutes"
  }
});
```

### The Token Efficiency Win

Compared to screenshot/DOM approaches:

| Approach | Tokens per interaction |
|----------|----------------------|
| Screenshot + Vision | ~1000-3000 (image tokens) |
| DOM serialization | ~2000-10000 (HTML tokens) |
| Event-based | ~50-100 (structured data) |

A 20-100x reduction in context usage.

### Private, Local, Your Keys

Mesh Bridge runs on your machine:
- Your browser session (no credential sharing)
- Your local server (no cloud dependency)
- Your API keys (full control)
- Open source (audit the code)

---

## Section 5: Demo Walkthrough (200 words)

### What to Show

1. **Setup** (30 sec)
   - Show Mesh with bridge connection configured
   - Load Chrome extension
   - Open WhatsApp Web

2. **Basic Chat** (30 sec)
   - Send "Hello, are you there?" to self
   - Show agent response appearing
   - Highlight the 🤖 prefix

3. **Tool Usage** (60 sec)
   - Ask "What's the weather in São Paulo?"
   - Show agent calling Perplexity/web search
   - Response appears in WhatsApp

4. **Content Creation** (90 sec)
   - "Write a blog post about mesh-bridge and publish as draft"
   - Show progress messages in chat
   - Switch to blog dashboard, show new draft

5. **Event Flow** (30 sec)
   - Terminal showing event publish/subscribe
   - Highlight the decoupled architecture

### Key Talking Points

- "I never shared my WhatsApp credentials"
- "The AI only sees my self-chat messages"
- "Any MCP in my mesh can now subscribe to browser events"
- "Adding a new site means adding a domain script—that's it"

---

## Section 6: Adding New Domains (200 words)

### The Pattern

Every domain needs two files:

1. **Content script** (extension/domains/mysite/content.js)
   - DOM observation
   - Event extraction
   - Response injection

2. **Server handler** (server/domains/mysite/index.ts)
   - URL matching
   - Event publishing
   - Response handling

### Example: Hypothetical LinkedIn Domain

```javascript
// extension/domains/linkedin/content.js
new MutationObserver((mutations) => {
  const newMessage = extractLinkedInMessage(mutations);
  if (newMessage) {
    socket.send(JSON.stringify({
      type: "message",
      domain: "linkedin",
      text: newMessage.text,
      chatId: newMessage.conversationId
    }));
  }
}).observe(document.querySelector('.msg-overlay-list-bubble'), { 
  childList: true, 
  subtree: true 
});
```

The server handler is nearly identical—just change the `source` field in events.

---

## Closing (100 words)

The DOM was never meant to be an AI interface. It's a rendering format, not a semantic protocol.

Mesh Bridge doesn't fight the DOM—it compiles it. Each domain script is a translator, turning visual noise into structured events. Once translated, the entire MCP ecosystem can interact with any website.

We're starting with WhatsApp. LinkedIn, X, Gmail are next. Eventually, we want AI-generated domain scripts—point at a site, get a working integration.

The browser is now an event source. What will you build?

---

## Links

- **GitHub**: [decolabs/mesh-bridge](https://github.com/decolabs/mesh-bridge)
- **MCP Mesh**: [decolabs/mesh](https://github.com/decolabs/mesh)
- **Event Bus Docs**: [mesh.dev/docs/event-bus](https://mesh.dev/docs/event-bus)

