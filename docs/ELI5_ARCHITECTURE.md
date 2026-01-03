# Mesh Bridge Architecture: ELI5 (Explain Like I'm 5)

> A simple explanation of how mesh-bridge works, written for humans who want to understand the system.

---

## 🎯 What Is This?

**Mesh Bridge is a translator between your browser and AI tools.**

Imagine you're using WhatsApp Web. Normally, AI can't see or interact with it. Mesh Bridge:
1. **Watches** your browser tab (via a Chrome extension)
2. **Sends** what you type to AI
3. **Gets** AI's response
4. **Types** it back into WhatsApp for you

It's like having a helpful friend sitting next to you who can read WhatsApp, ask ChatGPT questions, and type the answers back.

---

## 🏗️ The Three Pieces

### 1. Chrome Extension (The Eyes & Hands)

**Location:** `extension/`

The extension is injected into WhatsApp Web (or any supported site). It:
- 👀 **Watches** for new messages you send (starting with `!` or `/`)
- 📤 **Sends** those messages to the Bridge server via WebSocket
- ✍️ **Types** AI responses back into the website

```
extension/
├── manifest.json           # What sites to inject into
├── background.js           # Extension lifecycle
└── domains/whatsapp/
    └── content.js          # The actual code that runs in WhatsApp
```

**Key insight:** The content script knows the DOM. It knows where the message input is, how to click send, where messages appear. This knowledge is site-specific.

---

### 2. Bridge Server (The Brain Router)

**Location:** `server/`

The Bridge server is the orchestration layer. It:
- 🔌 **Connects** to Chrome extensions via WebSocket (port 9999)
- 🧠 **Routes** messages to the right "domain" handler
- 🔗 **Talks** to MCP Mesh for AI capabilities
- 📊 **Manages** sessions, conversations, and state

```
server/
├── stdio.ts                # Entry point (runs as MCP connection to Mesh)
├── main.ts                 # Entry point (standalone mode)
├── websocket.ts            # WebSocket server for extensions
├── config.ts               # Configuration
├── terminal.ts             # Safe shell execution
└── core/
    ├── agent.ts            # Two-phase AI agent (FAST router → SMART executor)
    ├── domain.ts           # Domain interface & registry
    ├── mesh-client.ts      # Talks to MCP Mesh
    ├── protocol.ts         # WebSocket frame types
    └── task-manager.ts     # Task tracking & history
```

---

### 3. Domains (The Site-Specific Knowledge)

**Location:** `server/domains/`

A Domain is a plugin that knows how to interact with one specific website. Currently:

```
domains/
└── whatsapp/
    └── index.ts            # WhatsApp-specific logic
```

A Domain provides:
- **URL patterns** - Which sites it handles (`whatsapp.com`)
- **System prompt** - How AI should behave in this context
- **Tools** - Actions specific to this site (`SEND_MESSAGE`, `GET_CHATS`)
- **Message handler** - How to process incoming messages

---

## 🔄 The Data Flow (Step by Step)

```
You type "!hello" in WhatsApp
         ↓
[Extension] Sees the message, sends to Bridge
         ↓
         { type: "message", text: "!hello", chatId: "self" }
         ↓
[Bridge] Receives via WebSocket
         ↓
[Bridge] Finds matching Domain (WhatsApp)
         ↓
[Domain] handleMessage() is called
         ↓
[Agent] Two-phase processing:
         ├─ FAST phase: Gemini Flash decides what to do
         └─ SMART phase: If complex, hands off to Claude
         ↓
[Mesh Client] Calls LLM_DO_GENERATE on MCP Mesh
         ↓
[Mesh] Returns AI response
         ↓
[Bridge] Sends back to extension
         ↓
         { type: "send", text: "🤖 Hello!", chatId: "self" }
         ↓
[Extension] Types the response into WhatsApp
         ↓
You see "🤖 Hello!" in your chat
```

---

## 🧠 The Agent Architecture (FAST + SMART)

The `Agent` class (`server/core/agent.ts`) implements a **two-phase architecture**:

### Phase 1: FAST (Router)
- Uses a **cheap, fast model** (Gemini Flash)
- Has 6 meta-tools:
  - `list_local_tools` - What can we do locally?
  - `list_mesh_tools` - What can we do via Mesh?
  - `explore_files` - Browse file system
  - `peek_file` - Read a file
  - `get_tool_schemas` - Get full schema for specific tools
  - `execute_task` - Hand off to SMART phase

### Phase 2: SMART (Executor)
- Uses a **capable, smart model** (Claude, GPT-4, etc.)
- Gets only the tools it needs (pre-selected by FAST)
- Executes the actual task

**Why two phases?**
- 💰 Cheap routing (most queries don't need Claude)
- 🎯 Focused execution (SMART only sees relevant tools)
- ⚡ Faster response times

---

## 🔌 Connection to MCP Mesh

Mesh Bridge connects to MCP Mesh in two ways:

### Mode 1: STDIO (Recommended)
The Bridge runs as an MCP connection inside Mesh:
```
Mesh → spawns → mesh-bridge (STDIO) → WebSocket → Extension
```
- Mesh passes credentials via environment variables
- No API key needed
- Automatic token refresh

### Mode 2: Standalone
The Bridge runs separately:
```
Bridge (port 9999) → HTTP → Mesh (port 3000)
```
- Needs `MESH_API_KEY` configured
- Manual startup

---

## 🛠️ Local Tools (What the Bridge Can Do)

The WhatsApp domain provides these tools:

| Tool | Description |
|------|-------------|
| `SAY_TEXT` | Speak text aloud (macOS) |
| `STOP_SPEAKING` | Stop voice output |
| `SEND_MESSAGE` | Send WhatsApp message |
| `GET_CHATS` | List recent chats |
| `LIST_FILES` | Browse file system |
| `READ_FILE` | Read file contents |
| `RUN_SHELL` | Execute shell commands |
| `GET_CLIPBOARD` | Read clipboard |
| `SET_CLIPBOARD` | Write clipboard |
| `SEND_NOTIFICATION` | macOS notification |
| `LIST_CONNECTIONS` | List Mesh MCPs |
| `CALL_MESH_TOOL` | Call any Mesh tool |

---

## 📁 Key Files Explained

| File | Purpose |
|------|---------|
| `server/stdio.ts` | Main entry point for STDIO mode |
| `server/main.ts` | Entry point for standalone mode |
| `server/core/agent.ts` | The two-phase AI agent |
| `server/core/mesh-client.ts` | Talks to MCP Mesh API |
| `server/core/domain.ts` | Domain interface definition |
| `server/domains/whatsapp/index.ts` | WhatsApp implementation |
| `extension/domains/whatsapp/content.js` | Browser-side WhatsApp code |
| `extension/manifest.json` | Chrome extension config |

---

## 🎭 The Domain Pattern

Adding support for a new website means creating two files:

### 1. Server-side Domain Handler
```typescript
// server/domains/linkedin/index.ts
export const linkedinDomain: Domain = {
  id: "linkedin",
  name: "LinkedIn",
  urlPatterns: [/linkedin\.com/],
  
  handleMessage: async (message, ctx) => {
    // Process message, call LLM, respond
  },
  
  tools: [
    { name: "SEND_CONNECTION_REQUEST", ... }
  ]
};
```

### 2. Client-side Content Script
```javascript
// extension/domains/linkedin/content.js
// - Connect to Bridge via WebSocket
// - Watch for user actions
// - Inject AI responses into the page
```

---

## 🔐 Security Model

- **Path whitelisting:** File operations only in `~/Projects/`
- **Command blocking:** Dangerous commands (`rm -rf`, `sudo`) blocked
- **Session isolation:** Each browser tab = one session
- **Your credentials:** Uses YOUR logged-in browser session (no headless)

---

## 📊 Session & State

Each extension connection creates a Session:
```typescript
interface Session {
  id: string;              // "session-12345-abc123"
  domain: string;          // "whatsapp"
  conversations: Map<string, Message[]>;  // Chat history per chatId
  speakerMode?: boolean;   // Voice responses
  lastProcessedMessage?: string;  // Deduplication
}
```

---

## 🧩 The Big Picture

```
┌─────────────────────────────────────────────────────────────────┐
│                     MCP Mesh (port 3000)                        │
│  OpenRouter (LLM) · Perplexity · Writing MCP · Custom MCPs      │
└──────────────────────────────┬──────────────────────────────────┘
                               │ STDIO or HTTP
┌──────────────────────────────┴──────────────────────────────────┐
│                   MESH BRIDGE (port 9999)                        │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    Agent (FAST + SMART)                  │    │
│  │  • Route queries to right tools                         │    │
│  │  • Explore files, gather context                        │    │
│  │  • Execute tasks with selected tools                    │    │
│  └─────────────────────────────────────────────────────────┘    │
│  ┌─────────────┬─────────────┬─────────────┬─────────────┐      │
│  │  WhatsApp   │  LinkedIn   │      X      │    ...      │      │
│  │  (domain)   │  (planned)  │  (planned)  │  (any site) │      │
│  └─────────────┴─────────────┴─────────────┴─────────────┘      │
└──────────────────────────────┬──────────────────────────────────┘
                               │ WebSocket (port 9999)
┌──────────────────────────────┴──────────────────────────────────┐
│             Chrome Extension (your actual browser)               │
│  • Injects into WhatsApp, LinkedIn, etc.                        │
│  • Watches for !commands                                        │
│  • Types AI responses back                                      │
│  • Uses YOUR cookies, YOUR session, YOUR login                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 💡 Key Insights

1. **It's not scraping** - It's YOUR browser, YOUR session
2. **It's not RPA** - It's AI-powered, understands context
3. **It's composable** - Domains are plugins, add any site
4. **It's bidirectional** - MCPs can control DOM, DOM can trigger MCPs
5. **It's token-efficient** - DOM complexity → simple tools

---

*This document is the AS-IS architecture. For future direction, see POSITIONING_PLAN.md*

