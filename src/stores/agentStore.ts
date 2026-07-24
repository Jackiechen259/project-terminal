import { create } from "zustand";

import {
  agentService,
  type AgentProfileInput,
  type FrontendError,
} from "@/services";
import type { AgentEvent, AgentProfile, AgentSession } from "@/types";

interface AgentStoreState {
  profiles: AgentProfile[];
  sessions: AgentSession[];
  eventsBySessionId: Record<string, AgentEvent[]>;
  error: FrontendError | null;
  load: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  createProfile: (input: AgentProfileInput) => Promise<AgentProfile>;
  start: (profileId: string) => Promise<AgentSession>;
  stop: (sessionId: string) => Promise<void>;
  restart: (sessionId: string) => Promise<void>;
  respond: (sessionId: string, input: string) => Promise<void>;
  interrupt: (sessionId: string) => Promise<void>;
  loadEvents: (sessionId: string) => Promise<void>;
}

function replaceSession(sessions: AgentSession[], updated: AgentSession) {
  const exists = sessions.some((session) => session.id === updated.id);
  return exists
    ? sessions.map((session) => (session.id === updated.id ? updated : session))
    : [...sessions, updated];
}

export const useAgentStore = create<AgentStoreState>((set, get) => ({
  profiles: [],
  sessions: [],
  eventsBySessionId: {},
  error: null,

  load: async () => {
    try {
      const [profiles, sessions] = await Promise.all([
        agentService.listProfiles(),
        agentService.listSessions(),
      ]);
      set({ profiles, sessions, error: null });
    } catch (error) {
      set({ error: error as FrontendError });
    }
  },

  refreshSessions: async () => {
    try {
      set({ sessions: await agentService.listSessions(), error: null });
    } catch (error) {
      set({ error: error as FrontendError });
    }
  },

  createProfile: async (input) => {
    const profile = await agentService.createProfile(input);
    set({ profiles: [...get().profiles, profile], error: null });
    return profile;
  },

  start: async (profileId) => {
    const session = await agentService.start(profileId);
    set({ sessions: replaceSession(get().sessions, session), error: null });
    return session;
  },

  stop: async (sessionId) => {
    const session = await agentService.stop(sessionId);
    set({ sessions: replaceSession(get().sessions, session), error: null });
  },

  restart: async (sessionId) => {
    const session = await agentService.restart(sessionId);
    set({ sessions: replaceSession(get().sessions, session), error: null });
  },

  respond: async (sessionId, input) => {
    const session = await agentService.respond(sessionId, input);
    set({ sessions: replaceSession(get().sessions, session), error: null });
  },

  interrupt: async (sessionId) => {
    await agentService.interrupt(sessionId);
    await get().refreshSessions();
  },

  loadEvents: async (sessionId) => {
    const events = await agentService.listEvents(sessionId);
    set({
      eventsBySessionId: {
        ...get().eventsBySessionId,
        [sessionId]: events,
      },
    });
  },
}));
