# Mesh Bridge: Positioning & Roadmap

> Strategic plan for simplifying, positioning, and growing mesh-bridge into a significant open source project.

---

## 🎯 The Core Insight

**The DOM is the wrong abstraction layer for AI agents.**

The DOM is:
- Too granular (thousands of nodes)
- Too unstable (changes with UI updates)
- Too verbose (massive token budgets)
- Too coupled to visual rendering

Agents that operate directly on the DOM must:
- Re-interpret structure on every interaction
- Spend tokens parsing irrelevant nodes
- Break when minor UI changes happen
- Behave like fragile RPA, not intelligent systems

### The Mesh Bridge Insight

**Instead of teaching agents to navigate the DOM, we pre-compile the DOM into tools.**

```
DOM → Domain Script → MCP Tools → Agent Reasoning
```

This is a **representation collapse**:
1. **Domain scripts** map a site's DOM to stable, named actions
2. **MCP tools** expose intent-level operations (`sendMessage`, `getConversations`)
3. **Agents** never see the DOM—they work with a clean, stable API

Once compiled, the website becomes a **cookbook of guaranteed-to-work actions**.

---

## 💡 Why This Matters

### Token Reduction Strategy

Instead of:
- Sending thousands of DOM tokens per interaction
- Re-explaining page structure every run
- Hoping the LLM infers intent from layout

You get:
- A small, stable, named toolset
- Predictable inputs & outputs
- Dramatically smaller prompts
- Faster reasoning loops
- Lower inference cost
- Higher success rate

**This is code generation to reduce the agent's problem space.**

### Bidirectional Control Plane

Mesh Bridge works in both directions:
- **MCPs → DOM**: AI agents control the website
- **DOM → MCPs**: Website events trigger MCP workflows

This enables live, agent-driven interaction with real websites—not just background automation.

### Your Browser, Your Session

Mesh Bridge runs in **your actual browser**:
- Your cookies
- Your credentials
- Your existing logins
- Your permissions

No headless Chrome. No credential duplication. No bot detection games. **It just works because you're already logged in.**

---

## 🏗️ Architecture Simplification Plan

The current architecture is functional but has accidental complexity. Here's how to simplify:

### Current Pain Points

1. **Too much in WhatsApp domain** - System tools (files, shell, clipboard) shouldn't be in a domain
2. **Agent class is complex** - 1200+ lines, handles routing + execution + caching
3. **Extension has too much logic** - Polling, state management, DOM manipulation all mixed
4. **Two entry points** - `stdio.ts` and `main.ts` share code awkwardly

### Proposed Simplification

#### 1. Extract Core Tools from Domains

```
server/
├── tools/
│   ├── system/           # LIST_FILES, READ_FILE, RUN_SHELL
│   ├── speech/           # SAY_TEXT, STOP_SPEAKING  
│   ├── clipboard/        # GET_CLIPBOARD, SET_CLIPBOARD
│   └── notifications/    # SEND_NOTIFICATION
├── domains/
│   └── whatsapp/         # Only WhatsApp-specific tools: SEND_MESSAGE, GET_CHATS
```

**Benefit:** Domains become thin. System tools reusable across domains.

#### 2. Simplify Agent to Pure Router

```typescript
// Current: Agent handles routing + execution + caching + logging
// Proposed: Agent just routes, execution is delegated

class Agent {
  route(message: string): Task
  execute(task: Task): Result
}

class Task {
  tools: ToolRef[]
  plan: string
  context?: string
}
```

**Benefit:** Clearer separation, easier testing, potential for parallel execution.

#### 3. Unify Entry Points

```typescript
// server/index.ts - Single entry point
// Detects mode automatically:
// - If running with MESH_TOKEN env vars → STDIO mode
// - Otherwise → Standalone mode

import { startBridge } from "./bridge";
startBridge();
```

**Benefit:** One mental model, less code duplication.

#### 4. Extension Protocol Analysis

The extension protocol is actually well-designed for extensibility. Here's a detailed analysis:

**Current Frame Types (Client → Bridge):**

| Frame Type | Purpose | Extensibility |
|------------|---------|---------------|
| `connect` | Establish session, declare domain | ✅ Essential |
| `message` | User message for AI processing | ✅ Core operation |
| `command` | Slash commands, mode toggles | ✅ Extensible |
| `ping` | Keep-alive heartbeat | ✅ Essential |
| `tool_call` | Direct tool invocation from extension | ✅ Power user feature |
| `event` | Domain-specific events (scraped data) | ✅ Extensible |

**Current Frame Types (Bridge → Client):**

| Frame Type | Purpose | Extensibility |
|------------|---------|---------------|
| `connected` | Session confirmation, mesh status | ✅ Essential |
| `send` | AI response to inject into page | ✅ Core operation |
| `send_image` | Image to inject (base64/URL) | ✅ WhatsApp-specific, generalizable |
| `response` | Command response | ✅ Essential |
| `pong` | Heartbeat response | ✅ Essential |
| `error` | Error handling | ✅ Essential |
| `event` | Bridge → Extension events | ✅ Extensible |
| `tool_result` | Direct tool call result | ✅ Power user feature |
| `speaking_started/ended` | TTS state | ⚠️ WhatsApp-specific |
| `agent_mode_changed` | FAST/SMART mode | ⚠️ UI feedback |
| `agent_progress` | Progress updates | ⚠️ UI feedback |

**Assessment:** The protocol is robust and extensible. The "many frame types" actually serve different purposes:
- **Core operations:** `connect`, `message`, `send`, `error` - essential for any domain
- **Power features:** `tool_call`, `tool_result` - enable advanced use cases
- **UI feedback:** `agent_progress`, `agent_mode_changed` - enhance UX but optional
- **Domain-specific:** `speaking_started/ended`, `send_image` - should be events, not frame types

**Proposed Refinement (not simplification):**

Instead of reducing frame types, refine them:

1. **Consolidate domain-specific frames into generic events:**
```typescript
// Instead of: speaking_started, speaking_ended, send_image
// Use generic event frame:
{ type: "event", event: "speaking_started", data: { text: "..." } }
{ type: "event", event: "send_image", data: { imageUrl: "...", caption: "" } }
```

2. **Keep the robust type system** - it enables:
   - Type-safe handling in both extension and bridge
   - Clear separation of concerns
   - Easy addition of new operations per domain

3. **Standardize per-domain event conventions:**
```typescript
// Each domain declares what events it sends/receives
interface DomainEventSchema {
  // Events this domain sends to bridge
  sends: {
    scraped_chats: { chats: Chat[] }
    scraped_messages: { messages: Message[] }
  }
  // Events this domain receives from bridge  
  receives: {
    request_chats: {}
    request_messages: { chatId: string, limit?: number }
    send_image: { imageUrl: string, caption?: string }
  }
}
```

**Benefit:** Protocol stays robust and extensible. Domain-specific features use the event system. Core frame types remain stable across all domains.

---

## 📝 README Positioning

The current README is technical and explains "how." The new README should explain "why" and inspire adoption.

### Proposed README Structure

```markdown
# Mesh Bridge

> Compile any website into MCP tools for AI agents.

The DOM is the wrong abstraction for AI. Mesh Bridge pre-compiles websites 
into stable, intent-level tools that agents can use reliably.

## The Problem

AI agents struggle with the web because:
- The DOM is too granular and noisy
- Page structure changes break automations  
- Token budgets explode with raw HTML
- Every interaction requires re-interpretation

## The Solution

Mesh Bridge introduces a **domain script layer** that:
- Maps DOM elements to named actions
- Exposes intent-level MCP tools
- Runs in your real browser (your session, your cookies)
- Works bidirectionally (agents ↔ websites)

## Quick Example

```typescript
// Instead of: "Find the input, type, click send button..."
// You get:

await tools.whatsapp.sendMessage({
  chatId: "self",
  text: "Hello from AI!"
});
```

## How It Works

1. **Domain scripts** understand specific websites (WhatsApp, LinkedIn, etc.)
2. **Chrome extension** runs in your browser, watches for commands
3. **Bridge server** connects to your MCP Mesh
4. **AI agents** call tools, Bridge executes on the DOM

[Beautiful architecture diagram here]

## Getting Started

1. Add Mesh Bridge to your MCP Mesh as a Custom Command
2. Load the Chrome extension  
3. Open WhatsApp Web
4. Message yourself: `!hello`
5. AI responds in your chat

## Why This Matters

- **Token reduction**: Small toolset vs massive DOM
- **Reliability**: Stable tools vs fragile selectors
- **Speed**: Instant execution vs DOM interpretation
- **Trust**: Your browser, your session, your data

## Supported Sites

| Site | Status | Tools |
|------|--------|-------|
| WhatsApp Web | ✅ Ready | Messages, chats, voice |
| LinkedIn | 🚧 Coming | Connections, messages |
| X (Twitter) | 🚧 Coming | Tweets, DMs |
| Any site | 📖 Guide | Add your own! |

## Roadmap

- [ ] AI-generated domain scripts
- [ ] Visual domain builder
- [ ] More built-in domains
- [ ] Event-driven workflows

## License

MIT

## 🛣️ Roadmap: Next Examples to Build

### Tier 1: Core Domains (Next 30 days)

#### 1. LinkedIn Domain
**Why:** High-value, professional context, natural MCP use case
**Tools:**
- `SEND_CONNECTION_REQUEST(profileUrl, note?)`
- `SEND_MESSAGE(conversationId, text)`
- `GET_PROFILE(profileUrl)`
- `SEARCH_PEOPLE(query, filters)`
- `LIST_CONNECTIONS()`

**Extension complexity:** Medium (LinkedIn DOM is cleaner than WhatsApp)

#### 2. X (Twitter) Domain
**Why:** Public API alternative, content creation, engagement automation
**Tools:**
- `POST_TWEET(text, mediaUrls?)`
- `REPLY_TO_TWEET(tweetId, text)`
- `SEND_DM(userId, text)`
- `GET_TIMELINE(count)`
- `SEARCH_TWEETS(query)`

**Extension complexity:** Medium (X has a consistent DOM structure)

#### 3. Gmail Domain
**Why:** Universal use case, high value, complex enough to prove the model
**Tools:**
- `COMPOSE_EMAIL(to, subject, body)`
- `REPLY_TO_EMAIL(threadId, body)`
- `LIST_EMAILS(folder, query, limit)`
- `GET_EMAIL(emailId)`
- `ARCHIVE_EMAIL(emailId)`

**Extension complexity:** High (Gmail DOM is complex, may need React reconciliation)

### Tier 2: Developer Tools (60 days)

#### 4. GitHub Domain
**Why:** Developer workflow, PR reviews, issue management
**Tools:**
- `CREATE_ISSUE(repo, title, body)`
- `COMMENT_ON_PR(prUrl, comment)`
- `APPROVE_PR(prUrl)`
- `LIST_NOTIFICATIONS()`
- `GET_PR_DIFF(prUrl)`

#### 5. Linear Domain
**Why:** Project management, issue tracking, natural agentic workflow
**Tools:**
- `CREATE_ISSUE(title, description, projectId)`
- `UPDATE_ISSUE(issueId, status, assignee)`
- `LIST_ISSUES(projectId, filters)`
- `ADD_COMMENT(issueId, text)`

#### 6. Notion Domain
**Why:** Knowledge base, documentation, content management
**Tools:**
- `CREATE_PAGE(parentId, title, content)`
- `SEARCH_PAGES(query)`
- `UPDATE_PAGE(pageId, content)`
- `GET_DATABASE(databaseId)`

### Tier 3: AI-Generated Domains (90 days)

The ultimate goal: **Generate domain scripts on demand using AI.**

#### Flow:
1. User says: "I want to automate job applications on AngelList"
2. Bridge captures relevant DOM slices
3. LLM analyzes structure and affordances
4. LLM generates:
   - Domain script (server-side)
   - Content script (extension-side)
   - Tool definitions
5. Output: Ready-to-commit folder
6. From then on: Agents use stable tools

#### Components needed:
- **DOM analyzer** - Extracts semantic meaning from DOM
- **Tool generator** - Produces MCP tool definitions
- **Script generator** - Creates server + extension code
- **Test generator** - Validates the domain works

---

## 📊 Success Metrics

### Adoption
- GitHub stars (target: 1000 in 3 months)
- npm downloads
- Discord community size
- Number of community-contributed domains

### Quality
- Domain coverage (sites supported)
- Tool reliability (success rate per tool)
- Token efficiency (tokens per operation)
- User feedback (NPS, issues resolved)

### Technical
- Test coverage
- Documentation completeness
- Time to add new domain
- Generation success rate (for AI-generated domains)

---

## 🏷️ Naming & Positioning Options

The project needs a clear conceptual frame. Options:

### Option A: "Web Compiler for Agents"
- Emphasizes the compilation metaphor
- DOM → Tools is like Source → Binary
- Clear differentiation from RPA

### Option B: "Agent-Native Web"
- Positions websites as having a "native" agent interface
- Like "mobile-native" vs "responsive"
- Forward-looking, aspirational

### Option C: "DOM-to-MCP Bridge"
- Technical, accurate
- Clear value prop for MCP users
- Less inspiring, more descriptive

### Option D: "Browser Bindings"
- Plays on the MCP bindings concept
- Extends familiar terminology
- Connects to existing Mesh ecosystem

**Recommendation:** Lead with "Web Compiler for Agents" for positioning, use "Mesh Bridge" as product name.

---

## 📋 Immediate Next Steps

### ✅ Completed
1. ~~**Extract system tools** from WhatsApp domain~~ → Created `server/tools/` with system, speech, mesh, and task tools
2. ~~**Simplify Agent class**~~ → Extracted router logic to `router-tools.ts`, cleaner Agent class
3. ~~**Unify entry points**~~ → Created `server/index.ts` with auto-detection

### 🔜 Next
4. **Write new README** with the positioning above
5. **Build LinkedIn domain** as proof of pattern
6. **Create `examples/` folder** with standalone use cases
7. **Record demo video** showing the flow
8. **Refine extension protocol** - consolidate domain-specific frames into events
9. **Write blog post** explaining the insight
10. **Set up Discord** for community

---

## 🎤 The Elevator Pitch

> "AI agents can't use websites because the DOM is too complex. Mesh Bridge compiles websites into simple MCP tools—like turning a complex machine into a remote control. It runs in your real browser, uses your real session, and turns any website into a toolkit for AI. We're building the interface layer that makes the web agent-native."

---

*This document is the strategic plan. For current architecture, see ELI5_ARCHITECTURE.md*

