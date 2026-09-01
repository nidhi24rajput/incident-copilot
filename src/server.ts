import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";

/**
 * Incident Copilot
 * -----------------
 * A chat-based agent that helps an engineer triage a production incident:
 *   - Opens an incident and tracks it in durable, structured state
 *     (not just chat history) so severity, affected services, and a
 *     timeline survive reconnects and page reloads.
 *   - Coordinates a lightweight triage workflow: schedules a check-in
 *     reminder for any incident still open after 15 minutes, and nudges
 *     the channel if it's still unresolved.
 *   - Keeps a running timeline of triage notes, so "what did we already
 *     rule out?" has an answer instead of living in someone's head.
 *
 * This mirrors the two things Developer Productivity teams actually care
 * about: fast incident response, and turning tribal process into
 * something automated and consistently enforced (the "Engineering Codex"
 * idea, applied to incident triage instead of code review).
 */

type Severity = "SEV1" | "SEV2" | "SEV3";

type TimelineEntry = {
  timestamp: string;
  note: string;
};

type Incident = {
  id: string;
  title: string;
  severity: Severity;
  affectedServices: string[];
  status: "open" | "resolved";
  timeline: TimelineEntry[];
  openedAt: string;
  resolvedAt?: string;
};

type IncidentCopilotState = {
  incidents: Incident[];
  activeIncidentId?: string;
};

const INITIAL_STATE: IncidentCopilotState = {
  incidents: [],
  activeIncidentId: undefined
};

function getIncident(
  state: IncidentCopilotState,
  incidentId: string
): Incident | undefined {
  return state.incidents.find((i) => i.id === incidentId);
}

export class IncidentCopilotAgent extends AIChatAgent<
  Env,
  IncidentCopilotState
> {
  maxPersistedMessages = 100;
  chatRecovery = true;

  initialState = INITIAL_STATE;

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.7-code", {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are Incident Copilot, an assistant that helps a backend engineer
triage a production incident calmly and consistently.

When an engineer describes a problem, help them:
1. Open an incident (title, severity SEV1/SEV2/SEV3, affected services) using
   the openIncident tool, if one isn't already open.
2. Log each triage step as they investigate (what they checked, what they
   ruled out, what they found) using the logTriageStep tool. Do this
   proactively as the conversation progresses -- don't wait to be asked.
3. When the root cause is found and the fix is in place, resolve the
   incident with resolveIncident, including a short summary.

Use getIncidentStatus whenever the engineer asks "what's the status" or
"what have we tried" -- always answer from the tracked state, not from
memory of the conversation, since that's the durable source of truth.

Be terse and operational. This is incident response, not a chat about
incident response.`,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        openIncident: tool({
          description:
            "Open a new incident and make it the active incident being triaged.",
          inputSchema: z.object({
            title: z.string().describe("Short description of the incident"),
            severity: z
              .enum(["SEV1", "SEV2", "SEV3"])
              .describe(
                "SEV1 = full outage, SEV2 = degraded/partial, SEV3 = minor/low impact"
              ),
            affectedServices: z
              .array(z.string())
              .describe("Names of the services or systems affected")
          }),
          execute: async ({ title, severity, affectedServices }) => {
            const id = crypto.randomUUID();
            const now = new Date().toISOString();
            const incident: Incident = {
              id,
              title,
              severity,
              affectedServices,
              status: "open",
              timeline: [{ timestamp: now, note: "Incident opened." }],
              openedAt: now
            };

            this.setState({
              incidents: [...this.state.incidents, incident],
              activeIncidentId: id
            });

            // Coordinate follow-up: if this incident is still open in 15
            // minutes, nudge the channel. This is the "workflow" piece --
            // durable, scheduled execution independent of whether anyone
            // is actively chatting.
            await this.schedule(15 * 60, "incidentCheckIn", id);

            return `Opened ${severity} incident "${title}" (id: ${id}). Affected: ${affectedServices.join(", ")}. A check-in is scheduled for 15 minutes from now if it's still open.`;
          }
        }),

        logTriageStep: tool({
          description:
            "Log a triage step or finding against the active incident's timeline.",
          inputSchema: z.object({
            note: z
              .string()
              .describe("What was checked, ruled out, or found")
          }),
          execute: async ({ note }) => {
            const activeId = this.state.activeIncidentId;
            if (!activeId) return "No active incident to log against.";

            const incident = getIncident(this.state, activeId);
            if (!incident) return "Active incident not found in state.";

            const updated: Incident = {
              ...incident,
              timeline: [
                ...incident.timeline,
                { timestamp: new Date().toISOString(), note }
              ]
            };

            this.setState({
              ...this.state,
              incidents: this.state.incidents.map((i) =>
                i.id === activeId ? updated : i
              )
            });

            return `Logged: "${note}"`;
          }
        }),

        resolveIncident: tool({
          description: "Mark the active incident as resolved.",
          inputSchema: z.object({
            summary: z.string().describe("Root cause and fix, in one line")
          }),
          execute: async ({ summary }) => {
            const activeId = this.state.activeIncidentId;
            if (!activeId) return "No active incident to resolve.";

            const incident = getIncident(this.state, activeId);
            if (!incident) return "Active incident not found in state.";

            const now = new Date().toISOString();
            const updated: Incident = {
              ...incident,
              status: "resolved",
              resolvedAt: now,
              timeline: [
                ...incident.timeline,
                { timestamp: now, note: `Resolved: ${summary}` }
              ]
            };

            this.setState({
              incidents: this.state.incidents.map((i) =>
                i.id === activeId ? updated : i
              ),
              activeIncidentId: undefined
            });

            return `Incident "${incident.title}" resolved. Summary: ${summary}`;
          }
        }),

        getIncidentStatus: tool({
          description:
            "Get the full status and timeline of the active incident, from durable state.",
          inputSchema: z.object({}),
          execute: async () => {
            const activeId = this.state.activeIncidentId;
            if (!activeId) return "No active incident.";

            const incident = getIncident(this.state, activeId);
            if (!incident) return "Active incident not found in state.";

            return incident;
          }
        }),

        listIncidents: tool({
          description:
            "List all incidents tracked in this session, open and resolved.",
          inputSchema: z.object({}),
          execute: async () => {
            if (this.state.incidents.length === 0) {
              return "No incidents tracked yet.";
            }
            return this.state.incidents.map((i) => ({
              id: i.id,
              title: i.title,
              severity: i.severity,
              status: i.status,
              affectedServices: i.affectedServices
            }));
          }
        })
      },
      stopWhen: stepCountIs(20),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  /** Scheduled follow-up: fires 15 minutes after an incident opens. */
  async incidentCheckIn(incidentId: string, _task: Schedule<string>) {
    const incident = getIncident(this.state, incidentId);
    if (!incident || incident.status === "resolved") return;

    this.broadcast(
      JSON.stringify({
        type: "incident-check-in",
        incidentId,
        title: incident.title,
        severity: incident.severity,
        timestamp: new Date().toISOString(),
        message: `"${incident.title}" (${incident.severity}) has been open for 15+ minutes. Status check needed.`
      })
    );
  }

  @callable()
  async getIncidentHistory() {
    return this.state.incidents;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
