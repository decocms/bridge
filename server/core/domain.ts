/**
 * Domain Interface
 *
 * A domain represents a specific website or service that the mesh-bridge can control.
 * Each domain implements its own message handling, tools, and watchers.
 *
 * Examples: WhatsApp, LinkedIn, X (Twitter), etc. Works as RPA for any website.
 */

import type { Session, BridgeFrame } from "./protocol.ts";
import type { MeshClient } from "./mesh-client.ts";

// ============================================================================
// Domain Interface
// ============================================================================

export interface DomainContext {
  /** The mesh client for calling tools */
  meshClient: MeshClient;
  /** Current session */
  session: Session;
  /** Send a frame back to the client */
  send: (frame: BridgeFrame) => void;
  /** Configuration for this domain */
  config: DomainConfig;
}

export interface DomainConfig {
  /** Domain-specific settings */
  settings?: Record<string, unknown>;
  /** AI prefix for responses */
  aiPrefix?: string;
}

export interface DomainMessage {
  /** Unique message ID */
  id: string;
  /** Message text */
  text: string;
  /** Chat/conversation identifier */
  chatId: string;
  /** Whether this is a self-initiated message (e.g., messaging yourself) */
  isSelf?: boolean;
  /** Timestamp */
  timestamp: number;
  /** Domain-specific metadata */
  metadata?: Record<string, unknown>;
}

export interface DomainTool {
  /** Tool name (will be prefixed with domain, e.g., WHATSAPP_SEND_MESSAGE) */
  name: string;
  /** Tool description */
  description: string;
  /** Input schema (Zod) */
  inputSchema: unknown;
  /** Tool handler */
  execute: (input: unknown, ctx: DomainContext) => Promise<unknown>;
}

export interface DomainWatcher {
  /** Watcher name */
  name: string;
  /** Description */
  description: string;
  /** URL pattern to match (regex) */
  urlPattern: RegExp;
  /** Content script to inject */
  contentScript?: string;
  /** Styles to inject */
  styles?: string;
}

/**
 * Domain definition - implement this to add support for a new website/service
 */
export interface Domain {
  /** Unique domain identifier (e.g., "whatsapp", "linkedin", "x") */
  id: string;

  /** Display name */
  name: string;

  /** Description */
  description: string;

  /** Icon URL */
  icon?: string;

  /** URL patterns this domain handles */
  urlPatterns: RegExp[];

  /**
   * Handle an incoming message from the browser extension.
   * Transform it into mesh commands or AI interactions.
   */
  handleMessage: (message: DomainMessage, ctx: DomainContext) => Promise<void>;

  /**
   * Handle a command from the extension (e.g., /status, /help, set_speaker_mode)
   */
  handleCommand?: (
    command: { id: string; command: string; args?: Record<string, unknown> | string[] },
    ctx: DomainContext,
  ) => Promise<void>;

  /**
   * Domain-specific tools exposed to the mesh
   */
  tools?: DomainTool[];

  /**
   * Watchers for observing content on the page
   */
  watchers?: DomainWatcher[];

  /**
   * System prompt for AI interactions in this domain
   */
  systemPrompt?: string;

  /**
   * Called when domain is initialized
   */
  onInit?: (ctx: DomainContext) => Promise<void>;

  /**
   * Called when session ends
   */
  onDestroy?: (ctx: DomainContext) => Promise<void>;
}

// ============================================================================
// Domain Registry
// ============================================================================

const domains = new Map<string, Domain>();

/**
 * Register a domain
 */
export function registerDomain(domain: Domain): void {
  domains.set(domain.id, domain);
  console.log(`[mesh-bridge] Registered domain: ${domain.id} (${domain.name})`);
}

/**
 * Get a domain by ID
 */
export function getDomain(id: string): Domain | undefined {
  return domains.get(id);
}

/**
 * Get all registered domains
 */
export function getAllDomains(): Domain[] {
  return Array.from(domains.values());
}

/**
 * Find domain that matches a URL
 */
export function findDomainForUrl(url: string): Domain | undefined {
  for (const domain of domains.values()) {
    for (const pattern of domain.urlPatterns) {
      if (pattern.test(url)) {
        return domain;
      }
    }
  }
  return undefined;
}

/**
 * Get all tools from all domains (prefixed with domain ID)
 */
export function getAllDomainTools(): Array<DomainTool & { domainId: string; fullName: string }> {
  const allTools: Array<DomainTool & { domainId: string; fullName: string }> = [];

  for (const domain of domains.values()) {
    if (domain.tools) {
      for (const tool of domain.tools) {
        allTools.push({
          ...tool,
          domainId: domain.id,
          fullName: `${domain.id.toUpperCase()}_${tool.name}`,
        });
      }
    }
  }

  return allTools;
}
