import { beforeEach, describe, expect, it, vi } from "vitest";

import { agentService } from "@/services";
import { useAgentStore } from "@/stores/agentStore";
import type { AgentSession } from "@/types";

vi.mock("@/services", () => ({
  agentService: {
    listProfiles: vi.fn(),
    listSessions: vi.fn(),
    listEvents: vi.fn(),
    createProfile: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    respond: vi.fn(),
    interrupt: vi.fn(),
  },
}));

const service = vi.mocked(agentService);

function session(status: AgentSession["status"]): AgentSession {
  return {
    id: "agent-session-1",
    agentProfileId: "agent-profile-1",
    projectId: "project-1",
    terminalSessionId: "terminal-1",
    status,
    tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    startedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAgentStore.setState({
    profiles: [],
    sessions: [],
    eventsBySessionId: {},
    error: null,
  });
});

describe("agentStore", () => {
  it("loads profiles and long-running sessions together", async () => {
    service.listProfiles.mockResolvedValueOnce([]);
    service.listSessions.mockResolvedValueOnce([session("waiting")]);
    await useAgentStore.getState().load();
    expect(useAgentStore.getState().sessions[0].status).toBe("waiting");
  });

  it("replaces session state after a reply", async () => {
    useAgentStore.setState({ sessions: [session("approval")] });
    service.respond.mockResolvedValueOnce(session("running"));
    await useAgentStore.getState().respond("agent-session-1", "yes");
    expect(useAgentStore.getState().sessions[0].status).toBe("running");
  });
});
