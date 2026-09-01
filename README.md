# Incident Copilot

An AI-powered agent, built on the Cloudflare Agents SDK, that helps an engineer
triage a production incident: opens an incident, coordinates a lightweight
triage workflow, keeps a durable timeline, and checks in if it's still open
after 15 minutes.

Built for the Cloudflare "AI-powered application" assignment. Maps to the four
required components:

| Requirement                | Implementation |
|-----------------------------|----------------|
| LLM                         | Workers AI (`@cf/moonshotai/kimi-k2.7-code`) via `workers-ai-provider` |
| Workflow / coordination     | Multi-step tool-calling loop (open -> log -> resolve) + `this.schedule()` for a durable 15-minute check-in, independent of whether the chat is open |
| User input via chat         | WebSocket chat UI (`agents` SDK `useAgent`/`useAgentChat` hooks), same channel the starter template ships with |
| Memory / state               | `IncidentCopilotState` persisted via the Agent's built-in SQLite-backed Durable Object storage (`this.state` / `this.setState()`) — survives reconnects and page reloads, independent of chat history |

## Why this project

This isn't a generic demo. The scenario — triaging an incident, logging what's
been ruled out, checking in if it's still open — maps directly to observability
and incident-response work I've done in production (Datadog/Grafana dashboards,
cutting incident detection and resolution time), and to what a Developer
Productivity team does with things like an Engineering Codex: turning a process
that normally lives in someone's head into something automated and consistently
enforced.

## Project structure

```
src/
  server.ts     Agent class: tools, state shape, scheduled check-in
  app.tsx       React chat UI (from the Cloudflare Agents starter)
  client.tsx    Client entry point
  styles.css    Styling
wrangler.jsonc  Worker + Durable Object + Workers AI binding config
```

## Run locally

```bash
npm install
npx wrangler login        # one-time: authenticates the Workers AI binding
npm run dev
```

Then open the local URL Vite prints and try:

- "We're seeing 500s on the checkout service, looks SEV1"
- "Checked the deploy log, nothing shipped in the last hour"
- "Found it — a expired cert on the payments upstream, rotating it now"
- "What's the status?" (answered from durable state, not chat memory)

## Deploy

```bash
npm run deploy
```

This runs `wrangler deploy`, which needs you to be logged in
(`wrangler login`) or have `CLOUDFLARE_API_TOKEN` set.

## Type-check / lint

```bash
npm run check
```

Verified clean (`tsc --noEmit`, `oxlint`) before this was handed off.

## Prompt history

Per the assignment's note that AI-assisted coding is encouraged and prompt
history should be submitted: this project was built collaboratively in an AI
coding session. See `PROMPT_HISTORY.md` for guidance on compiling the actual
prompt log to submit — it should reflect the real conversation, not a
reconstructed one.
