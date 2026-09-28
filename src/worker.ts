import { routeAgentRequest } from "agents";

export { VoiceRouterAgent } from "./voice-router-agent";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return Response.json({ status: "ok", service: "voice-router" });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
