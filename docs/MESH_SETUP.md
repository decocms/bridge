# Setting up zap-mcp with MCP Mesh

This guide explains how to connect zap-mcp to your MCP Mesh so it can access tools like OpenRouter, Perplexity, and any other MCPs you've configured.

## Two Modes

zap-mcp can run in two modes:

### Mode 1: Mesh-Hosted (Recommended) ✨

zap-mcp runs as a **STDIO MCP** inside the mesh. The mesh passes tokens automatically via `ON_MCP_CONFIGURATION`. **No API key needed!**

```
┌─────────────────────────────────────────────────────────────────┐
│                     MCP Mesh (port 3000)                        │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  zap-mcp (STDIO)                                         │   │
│  │  Receives MESH_REQUEST_CONTEXT automatically             │   │
│  └────────────────────────┬─────────────────────────────────┘   │
│                           │ Internal calls                      │
│  OpenRouter · Perplexity · Custom MCPs · Your Tools             │
└─────────────────────────────────────────────────────────────────┘
                               │ HTTP (ws://localhost:9999)
                               ↓
                    Chrome Extension (WhatsApp Web)
```

### Mode 2: Standalone

zap-mcp runs separately and calls the mesh via HTTP. Requires `MESH_API_KEY`.

```
┌─────────────────────────────────────────────────────────────────┐
│                     MCP Mesh (port 3000)                        │
│  OpenRouter · Perplexity · Custom MCPs · Your Tools             │
└──────────────────────────────┬──────────────────────────────────┘
                               │ HTTP + Bearer Token (MESH_API_KEY)
                               ↓
┌──────────────────────────────────────────────────────────────────┐
│                   zap-mcp Bridge (port 9999)                     │
└──────────────────────────────┬───────────────────────────────────┘
                               │ WebSocket
                               ↓
                    Chrome Extension (WhatsApp Web)
```

---

## Mode 1: Mesh-Hosted Setup (No API Key!)

When zap-mcp runs inside the mesh, the mesh provides authentication automatically via `MESH_REQUEST_CONTEXT`. This is the same pattern used by OpenRouter and other MCPs.

### Step 1: Add zap-mcp to Your Mesh

In your mesh configuration, add zap-mcp as a STDIO connection:

```json
{
  "name": "whatsapp-bridge",
  "type": "STDIO",
  "command": "bun",
  "args": ["run", "/path/to/zap-mcp/server/main.ts"],
  "env": {
    "WS_PORT": "9999",
    "ALLOWED_PATHS": "/Users/yourname/Projects"
  }
}
```

Or add it via the mesh dashboard UI.

### Step 2: Configure Scopes

Grant zap-mcp permission to call LLM tools:
- `LLM_DO_GENERATE` (from OpenRouter)
- `perplexity_ask` (optional)

### Step 3: Start the Mesh

```bash
cd mesh
bun run dev
```

The mesh will start zap-mcp automatically and pass it the auth context.

---

## Mode 2: Standalone Setup (Requires API Key)

If you prefer to run zap-mcp outside the mesh:

### Step 1: Get a Mesh API Key

zap-mcp needs to authenticate with your mesh to call tools. You have two options:

### Option A: Use an API Key (Recommended)

1. Go to your mesh dashboard (e.g., `http://localhost:3000`)
2. Navigate to **Settings** → **API Keys**
3. Create a new API key with permissions for:
   - `LLM_DO_GENERATE` (required for AI responses)
   - `perplexity_ask` (optional, for web search)
   - Any other tools you want to access

### Option B: Use a Connection Token

If your mesh supports connection-level tokens, you can use those:

1. Create a new connection in your mesh for "zap-mcp"
2. Copy the connection token

## Step 2: Configure zap-mcp

Create a `.env` file in the zap-mcp directory:

```env
# MCP Mesh URL
MESH_URL=http://localhost:3000

# Your API key from step 1
MESH_API_KEY=your-api-key-here

# Default model for AI responses
DEFAULT_MODEL=anthropic/claude-sonnet-4

# WebSocket port for extension
WS_PORT=9999

# Terminal command safety
ALLOWED_PATHS=/Users/yourname/Projects,/Users/yourname/Documents
```

## Step 3: Verify Connection

Start zap-mcp and check if it can connect to the mesh:

```bash
# Start the bridge
bun run server

# You should see:
# ╔══════════════════════════════════════════════════════════════╗
# ║                      MESH BRIDGE v0.1.0                       ║
# ║  Status:    ✅ Connected                                      ║
# ║  Tools:     42                                                 ║
# ║  LLM:       ✅                                                 ║
# ╚══════════════════════════════════════════════════════════════╝
```

## Step 4: Run Tests

Verify the connection to OpenRouter works:

```bash
# Set your API key
export MESH_API_KEY=your-key

# Run mesh client tests
bun run test:mesh
```

Expected output:
```
✓ should check mesh availability
✓ should list available tools from mesh
✓ should call LLM_DO_GENERATE via mesh
```

## Step 5: Load the Extension

1. Open Chrome → `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `zap-mcp/extension/` folder
5. Open WhatsApp Web

## Verifying It Works

1. **Message yourself on WhatsApp** (the "Message yourself" chat)
2. **Send a test message**: "Hello, are you there?"
3. **Wait for the AI response** (prefixed with 🤖)
4. **Try commands**: `/status`, `/tools`, `/help`

## Troubleshooting

### "Mesh not available"

- Check that your mesh is running: `curl http://localhost:3000/health`
- Verify your API key is correct
- Check mesh logs for authentication errors

### "401 Unauthorized"

Your API key doesn't have the right permissions:

1. Check that the key has access to `LLM_DO_GENERATE`
2. Make sure the key hasn't expired
3. Try generating a new key with broader permissions

### "No LLM binding available"

The mesh doesn't have an LLM MCP connected:

1. Add the OpenRouter MCP to your mesh
2. Or add any MCP that provides `LLM_DO_GENERATE`
3. Verify with `/tools` command in WhatsApp

### Extension not connecting

- Make sure zap-mcp is running on port 9999
- Check browser console for WebSocket errors
- Try clicking the extension icon to open the panel

## Required Bindings

zap-mcp uses these bindings from your mesh:

| Binding | Tool | Required | Description |
|---------|------|----------|-------------|
| LLM | `LLM_DO_GENERATE` | Yes | Generates AI responses |
| LLM | `COLLECTION_LLM_LIST` | No | Lists available models |
| Perplexity | `perplexity_ask` | No | Web search + AI answers |

## Adding zap-mcp to Your Mesh (Optional)

If you want to expose zap-mcp's tools to other MCPs, you can add it as a connection:

```json
// In mesh dashboard, add new connection:
{
  "name": "WhatsApp Bridge",
  "type": "HTTP",
  "url": "http://localhost:9999",
  "description": "WhatsApp Web integration"
}
```

This allows other MCPs to send messages through WhatsApp!

## Security Notes

1. **Never commit your `.env` file** - it contains your API key
2. **Limit ALLOWED_PATHS** - only include directories you want the AI to access
3. **Use scoped API keys** - don't use admin keys for zap-mcp
4. **Review tool calls** - check logs to see what tools the AI is using

