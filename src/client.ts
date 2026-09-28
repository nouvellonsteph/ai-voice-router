import { VoiceClient, type TranscriptMessage } from "agents/voice/client";
import "./styles.css";

type RouterMode = "auto" | "flux" | "nova";
type RouterModel = "flux" | "nova";

interface RouterStateMessage {
  type: "router_state";
  mode: RouterMode;
  activeModel: RouterModel;
  detectedLanguage: "en" | "fr";
  reason: "startup" | "language" | "manual" | "fallback";
  event: "state" | "switch";
  observerAvailable: boolean;
  timestamp: number;
}

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

const transcriptEl = $("#transcript");
const interimEl = $("#interim");
const micButton = $("#mic-button");
const micLabel = $("#mic-label");
const connectionDot = $("#connection-dot");
const connectionLabel = $("#connection-label");
const listeningStatus = $("#listening-status");
const eventLog = $("#event-log");
const toast = $("#toast");
const meterBars = [...document.querySelectorAll<HTMLElement>("#level-meter i")];
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>(".mode-button")];

const sessionName = sessionStorage.getItem("voice-router-session") ?? crypto.randomUUID();
sessionStorage.setItem("voice-router-session", sessionName);

const voice = new VoiceClient({
  agent: "VoiceRouterAgent",
  name: sessionName,
  host: window.location.host,
  silenceThreshold: 0.025,
  silenceDurationMs: 650,
});

let currentMode: RouterMode = "auto";
let activeModel: RouterModel = "flux";
let listening = false;
let connected = false;
let transcriptMessages: TranscriptMessage[] = [];
let toastTimer: number | undefined;

function setConnection(isConnected: boolean): void {
  connected = isConnected;
  connectionDot.classList.toggle("connected", isConnected);
  connectionLabel.textContent = isConnected ? "Connected to edge" : "Reconnecting to edge";
  micButton.toggleAttribute("disabled", !isConnected);
}

function setListening(isListening: boolean): void {
  listening = isListening;
  micButton.classList.toggle("active", isListening);
  micButton.setAttribute("aria-label", isListening ? "Stop listening" : "Start listening");
  micLabel.textContent = isListening ? "Stop listening" : "Start speaking";
  listeningStatus.textContent = isListening ? "LISTENING" : "READY";
  listeningStatus.classList.toggle("active", isListening);
  if (!isListening) updateMeter(0);
}

function renderTranscript(messages: TranscriptMessage[]): void {
  transcriptMessages = messages.filter((message) => message.role === "user");
  if (transcriptMessages.length === 0) {
    transcriptEl.innerHTML = `
      <div id="empty-state" class="empty-state">
        <span class="quote-mark">“</span>
        <p>Your words will appear here.</p>
        <small>Try “Hello, how are you?” then “Bonjour, comment allez-vous ?”</small>
      </div>`;
    return;
  }

  transcriptEl.innerHTML = transcriptMessages
    .map(
      (message, index) => `
        <article class="transcript-line">
          <span>${String(index + 1).padStart(2, "0")}</span>
          <p>${escapeHtml(message.text)}</p>
        </article>`,
    )
    .join("");
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function updateMeter(level: number): void {
  meterBars.forEach((bar, index) => {
    const centerDistance = Math.abs(index - (meterBars.length - 1) / 2);
    const shape = 1 - centerDistance / meterBars.length;
    const random = 0.55 + Math.random() * 0.65;
    const height = listening ? Math.max(4, Math.min(42, level * 82 * shape * random)) : 4;
    bar.style.height = `${height}px`;
    bar.classList.toggle("lit", listening && level * meterBars.length > centerDistance * 0.7);
  });
}

function setMode(mode: RouterMode, notifyServer = true): void {
  currentMode = mode;
  modeButtons.forEach((button) => {
    const selected = button.dataset.mode === mode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-checked", String(selected));
  });
  $("#mode-value").textContent = mode.toUpperCase();
  if (notifyServer && connected) voice.sendJSON({ type: "set_router_mode", mode });
}

function applyRouterState(state: RouterStateMessage): void {
  const previousModel = activeModel;
  activeModel = state.activeModel;
  currentMode = state.mode;
  setMode(state.mode, false);

  const language = state.detectedLanguage.toUpperCase();
  $("#language-code").textContent = language;
  $("#language-stat").textContent = language;
  $("#hero-model").textContent = state.activeModel === "flux" ? "FLUX" : "NOVA-3";
  $("#active-model-stat").textContent = state.activeModel === "flux" ? "FLUX" : "NOVA-3";
  $("#active-model-sub").textContent = state.activeModel === "flux" ? "English optimized" : "Multilingual accuracy";
  $("#flux-node").classList.toggle("active", state.activeModel === "flux");
  $("#nova-node").classList.toggle("active", state.activeModel === "nova");

  const modeText = state.mode === "auto" ? "Auto mode" : "Manual mode";
  const languageText = state.detectedLanguage === "fr" ? "French detected" : "English detected";
  $("#route-explanation").textContent = `${modeText} · ${languageText}`;

  if (state.event === "switch" || previousModel !== state.activeModel) {
    const modelName = state.activeModel === "flux" ? "Flux" : "Nova-3";
    const reason = state.reason === "language" ? `${language} detected` : state.reason;
    addEvent(`${reason} → ${modelName}`);
    showToast(`Routed to ${modelName}`);
    document.body.classList.add("route-flash");
    window.setTimeout(() => document.body.classList.remove("route-flash"), 500);
  }
}

function addEvent(text: string): void {
  const time = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  eventLog.insertAdjacentHTML(
    "afterbegin",
    `<li><time>${time}</time><span>${escapeHtml(text)}</span></li>`,
  );
  while (eventLog.children.length > 4) eventLog.lastElementChild?.remove();
}

function showToast(message: string): void {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 2200);
}

voice.addEventListener("connectionchange", setConnection);
voice.addEventListener("statuschange", (status) => {
  setListening(status === "listening");
});
voice.addEventListener("transcriptchange", renderTranscript);
voice.addEventListener("interimtranscript", (text) => {
  interimEl.textContent = text ?? "";
  interimEl.classList.toggle("visible", Boolean(text));
});
voice.addEventListener("audiolevelchange", updateMeter);
voice.addEventListener("turnmetrics", (metrics) => {
  const latency = metrics.speechStartToFinalMs;
  if (typeof latency === "number") $("#latency-stat").textContent = `${Math.round(latency)} ms`;
});
voice.addEventListener("custommessage", (message) => {
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "router_state"
  ) {
    applyRouterState(message as unknown as RouterStateMessage);
  }
});
voice.addEventListener("error", (error) => {
  if (!error) return;
  if (error.toLocaleLowerCase().includes("microphone")) {
    voice.endCall();
    setListening(false);
  }
  showToast(error);
  addEvent(`Error · ${error}`);
});

micButton.addEventListener("click", async () => {
  if (!connected) return;
  if (listening) {
    voice.endCall();
    setListening(false);
    return;
  }

  try {
    await voice.startCall();
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Microphone access failed");
  }
});

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.dataset.mode as RouterMode;
    setMode(mode);
    addEvent(`Manual policy set to ${mode === "auto" ? "Auto" : mode === "flux" ? "Flux" : "Nova-3"}`);
  });
});

$("#clear-button").addEventListener("click", () => {
  transcriptMessages = [];
  renderTranscript([]);
  interimEl.textContent = "";
});

window.addEventListener("beforeunload", () => voice.disconnect());

setConnection(false);
setListening(false);
voice.connect();
