/**
 * Speech Tools
 *
 * macOS text-to-speech tools:
 * - SAY_TEXT - Speak text aloud
 * - STOP_SPEAKING - Stop current speech
 *
 * These are reusable across all domains.
 */

import { spawn } from "bun";
import type { LocalTool } from "../core/agent.ts";

// ============================================================================
// Voice Configuration
// ============================================================================

// Default voices - Luciana (PT-BR) and Samantha (EN) are always available
const PT_VOICE = "Luciana";
const EN_VOICE = "Samantha";

// Track active say process for stop functionality
let activeSayProcess: ReturnType<typeof spawn> | null = null;

// ============================================================================
// Language Detection
// ============================================================================

/**
 * Detect the language of text (Portuguese vs English)
 * Uses simple heuristics based on common words and characters
 */
export function detectLanguage(text: string): "pt" | "en" {
  const lowerText = text.toLowerCase();

  // Portuguese-specific patterns
  const ptPatterns = [
    /\b(você|voce|está|estou|estão|não|nao|sim|olá|ola|obrigado|obrigada)\b/,
    /\b(para|como|isso|esse|essa|aqui|ali|muito|pouco|agora)\b/,
    /\b(tenho|temos|fazer|posso|pode|quero|preciso|gostaria)\b/,
    /\b(bom|boa|dia|noite|tarde|bem|mal|legal|bacana)\b/,
    /\b(arquivo|pasta|aplicativo|projeto|código|lista)\b/,
    /\b(executando|rodando|funcionando|pronto|feito)\b/,
    /[ãõáéíóúâêîôûàèìòùç]/,
    /\b\w+(ção|ções|mente|ando|endo|indo)\b/,
  ];

  // English-specific patterns
  const enPatterns = [
    /\b(the|and|you|your|this|that|what|which|where|when)\b/,
    /\b(is|are|was|were|have|has|had|will|would|could)\b/,
    /\b(running|working|doing|looking|getting|making)\b/,
    /\b(file|folder|app|application|project|code|list)\b/,
  ];

  let ptScore = 0;
  let enScore = 0;

  for (const pattern of ptPatterns) {
    if (pattern.test(lowerText)) ptScore++;
  }

  for (const pattern of enPatterns) {
    if (pattern.test(lowerText)) enScore++;
  }

  // Default to Portuguese if scores are equal
  return ptScore >= enScore ? "pt" : "en";
}

/**
 * Get the appropriate voice for the detected language
 */
export function getVoiceForLanguage(lang: "pt" | "en"): string {
  return lang === "pt" ? PT_VOICE : EN_VOICE;
}

// ============================================================================
// Speech Control
// ============================================================================

/**
 * Kill any active say process
 */
export function stopSpeaking(): boolean {
  if (activeSayProcess) {
    console.error("[speech] Killing active say process");
    try {
      activeSayProcess.kill();
      activeSayProcess = null;
      return true;
    } catch (error) {
      console.error("[speech] Failed to kill process:", error);
      return false;
    }
  }
  return false;
}

/**
 * Speak text using macOS say command
 */
export async function speakText(
  text: string,
  voice?: string,
): Promise<{ success: boolean; error?: string; cancelled?: boolean }> {
  try {
    const detectedLang = detectLanguage(text);
    const selectedVoice = voice || getVoiceForLanguage(detectedLang);

    console.error(`[speech] Speaking with voice: ${selectedVoice} (detected: ${detectedLang})`);

    const proc = spawn(["say", "-v", selectedVoice, text], {
      stdout: "pipe",
      stderr: "pipe",
    });

    // Track for stop functionality
    activeSayProcess = proc;

    const exitCode = await proc.exited;

    // Clear tracking
    activeSayProcess = null;

    if (exitCode === 0) {
      return { success: true };
    } else {
      return { success: false, cancelled: true };
    }
  } catch (error) {
    activeSayProcess = null;
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to speak",
    };
  }
}

// ============================================================================
// Speech Tools
// ============================================================================

export const SAY_TEXT: LocalTool = {
  name: "SAY_TEXT",
  description: "Make the Mac speak text out loud. Auto-detects language (PT/EN).",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to speak" },
      voice: { type: "string", description: "Voice name (optional, auto-detects language)" },
    },
    required: ["text"],
  },
  execute: async (input) => {
    const { text, voice } = input as { text: string; voice?: string };

    const result = await speakText(text, voice);

    if (result.success) {
      return {
        success: true,
        message: `Spoke: "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"`,
      };
    } else {
      return result;
    }
  },
};

export const STOP_SPEAKING: LocalTool = {
  name: "STOP_SPEAKING",
  description: "Stop any currently playing text-to-speech",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
  execute: async () => {
    const stopped = stopSpeaking();
    return {
      success: true,
      wasSpeaking: stopped,
      message: stopped ? "Stopped speaking" : "Nothing was playing",
    };
  },
};

// ============================================================================
// Export All Speech Tools
// ============================================================================

export const speechTools: LocalTool[] = [SAY_TEXT, STOP_SPEAKING];
