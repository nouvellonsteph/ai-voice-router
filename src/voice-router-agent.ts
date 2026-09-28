import { Agent, type Connection, type WSMessage } from "agents";
import { withVoiceInput, type Transcriber } from "agents/voice";
import {
  RouterTranscriber,
  type RouterMode,
  type RouterState,
} from "./router-transcriber";

const VoiceInputAgent = withVoiceInput(Agent, {
  diagnostics: { browserConsole: false },
});

function isRouterMode(value: unknown): value is RouterMode {
  return value === "auto" || value === "flux" || value === "nova";
}

export class VoiceRouterAgent extends VoiceInputAgent<Env> {
  private readonly routers = new Map<string, RouterTranscriber>();
  private readonly desiredModes = new Map<string, RouterMode>();

  createTranscriber(connection: Connection): Transcriber {
    const mode = this.desiredModes.get(connection.id) ?? "auto";
    const router = new RouterTranscriber(this.env.AI, mode, (state) => {
      this.sendRouterState(connection, state);
    });
    this.routers.set(connection.id, router);
    return router;
  }

  onTranscript(): void {
    // The voice mixin sends finalized transcripts to the client.
  }

  onCallEnd(connection: Connection): void {
    this.routers.delete(connection.id);
  }

  onClose(connection: Connection): void {
    this.routers.delete(connection.id);
    this.desiredModes.delete(connection.id);
  }

  onMessage(connection: Connection, message: WSMessage): void {
    if (typeof message !== "string") return;

    let data: unknown;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    if (
      !data ||
      typeof data !== "object" ||
      !("type" in data) ||
      data.type !== "set_router_mode" ||
      !("mode" in data) ||
      !isRouterMode(data.mode)
    ) {
      return;
    }

    this.desiredModes.set(connection.id, data.mode);
    const router = this.routers.get(connection.id);
    if (router) {
      router.setMode(data.mode);
      return;
    }

    this.sendRouterState(connection, {
      mode: data.mode,
      activeModel: data.mode === "nova" ? "nova" : "flux",
      detectedLanguage: "en",
      reason: "manual",
      event: "state",
      observerAvailable: true,
      timestamp: Date.now(),
    });
  }

  private sendRouterState(connection: Connection, state: RouterState): void {
    connection.send(JSON.stringify({ type: "router_state", ...state }));
  }
}
