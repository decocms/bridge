/**
 * Bridge Events Tests
 */

import { describe, it, expect } from "bun:test";
import { EVENT_TYPES, getResponseEventType } from "./events.ts";

describe("Event Types", () => {
  describe("EVENT_TYPES", () => {
    it("has correct user event types", () => {
      expect(EVENT_TYPES.USER_MESSAGE).toBe("user.message.received");
      expect(EVENT_TYPES.USER_COMMAND).toBe("user.command.issued");
    });

    it("has correct task event types", () => {
      expect(EVENT_TYPES.TASK_CREATED).toBe("agent.task.created");
      expect(EVENT_TYPES.TASK_STARTED).toBe("agent.task.started");
      expect(EVENT_TYPES.TASK_PROGRESS).toBe("agent.task.progress");
      expect(EVENT_TYPES.TASK_COMPLETED).toBe("agent.task.completed");
      expect(EVENT_TYPES.TASK_FAILED).toBe("agent.task.failed");
    });

    it("has response event types for interfaces", () => {
      expect(EVENT_TYPES.RESPONSE_WHATSAPP).toBe("agent.response.whatsapp");
      expect(EVENT_TYPES.RESPONSE_CLI).toBe("agent.response.cli");
    });
  });

  describe("getResponseEventType", () => {
    it("builds correct event type for whatsapp", () => {
      expect(getResponseEventType("whatsapp")).toBe("agent.response.whatsapp");
    });

    it("builds correct event type for cli", () => {
      expect(getResponseEventType("cli")).toBe("agent.response.cli");
    });

    it("handles custom sources", () => {
      expect(getResponseEventType("raycast")).toBe("agent.response.raycast");
      expect(getResponseEventType("telegram")).toBe("agent.response.telegram");
    });
  });
});
