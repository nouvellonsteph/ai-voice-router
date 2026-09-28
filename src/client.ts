import { VoiceClient, type TranscriptMessage } from "agents/voice/client";
import "./styles.css";

type RouterMode = "auto" | "flux" | "nova";
type RouterModel = "flux" | "nova";
type PricingModel = "flux" | "nova" | "cluster";

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
const pricingForm = $<HTMLFormElement>("#pricing-form");
const MAX_SESSIONS = Number.MAX_SAFE_INTEGER;
const PRICING_NUMBER_FIELDS = ["#session-count", "#minutes-per-session", "#active-days"];
const THROUGHPUT_NUMBER_FIELDS = [
  "#throughput-gbps",
  "#stream-kbps",
  "#active-hours",
  "#throughput-utilization",
];

const PRICING = {
  neuronPrice: 0.011 / 1_000,
  dailyFreeNeurons: 10_000,
  fluxNeuronsPerMinute: 700,
  // Unrounded equivalent of the public $0.0092/min rate avoids drift at large volumes.
  novaNeuronsPerMinute: 836.3636363636364,
  workersPaidPlan: 5,
  workerIncludedRequests: 10_000_000,
  workerRequestPricePerMillion: 0.3,
  durableObjectIncludedRequests: 1_000_000,
  durableObjectRequestPricePerMillion: 0.15,
  durableObjectIncludedGbSeconds: 400_000,
  durableObjectDurationPricePerMillion: 12.5,
  durableObjectMemoryGb: 0.128,
  audioMessagesPerMinute: 600,
  websocketBillingRatio: 20,
} as const;

const PRICING_MODELS: Record<
  PricingModel,
  { label: string; neuronsPerMinute: number }
> = {
  flux: { label: "Flux", neuronsPerMinute: PRICING.fluxNeuronsPerMinute },
  nova: { label: "Nova-3", neuronsPerMinute: PRICING.novaNeuronsPerMinute },
  cluster: { label: "Own cluster via Gateway", neuronsPerMinute: 0 },
};

interface PricingInputs {
  sessions: number;
  minutesPerSession: number;
  frenchShare: number;
  activeDays: number;
  englishModel: PricingModel;
  frenchModel: PricingModel;
  clusterRate: number;
  applyAllowances: boolean;
  includePlan: boolean;
}

interface RouteUsage {
  neurons: number;
  clusterMinutes: number;
  modelMinutes: number;
}

interface CostEstimate {
  total: number;
  plan: number;
  ai: number;
  cluster: number;
  gateway: number;
  durableObjectRequests: number;
  durableObjectDuration: number;
  workerRequests: number;
  modelMinutes: number;
  neurons: number;
  clusterMinutes: number;
}

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
let pricingAnnouncementTimer: number | undefined;

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

function readPricingNumber(selector: string, minimum: number, maximum: number): number {
  const value = $<HTMLInputElement>(selector).valueAsNumber;
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

function validateNumberFields(selectors: string[], statusSelector: string): boolean {
  const fields = selectors.map((selector) => $<HTMLInputElement>(selector));
  let firstInvalid: HTMLInputElement | undefined;

  fields.forEach((field) => {
    const invalid = !field.validity.valid || !Number.isFinite(field.valueAsNumber);
    field.toggleAttribute("aria-invalid", invalid);
    if (invalid && !firstInvalid) firstInvalid = field;
  });

  const status = $<HTMLParagraphElement>(statusSelector);
  if (!firstInvalid) {
    status.textContent = "";
    status.hidden = true;
    return true;
  }

  const label = firstInvalid.closest("label")?.querySelector("span")?.textContent?.trim();
  status.textContent = `${label ?? "Value"}: ${firstInvalid.validationMessage || "Enter a valid number."}`;
  status.hidden = false;
  return false;
}

function readPricingModel(selector: string): PricingModel {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLSelectElement)) throw new Error(`Missing select: ${selector}`);
  const value = element.value;
  return value === "flux" || value === "nova" || value === "cluster" ? value : "cluster";
}

function roundedUsageCost(usage: number, included: number, pricePerMillion: number): number {
  const billable = Math.max(0, usage - included);
  return billable === 0 ? 0 : Math.ceil(billable / 1_000_000) * pricePerMillion;
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatUnitCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 1 ? 4 : 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

function formatUsage(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatNeuronRate(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatCompactUsage(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function calculateThroughputMinutes(): {
  concurrentStreams: number;
  wallMinutes: number;
  utilization: number;
  audioMinutes: number;
} | null {
  const applyButton = $<HTMLButtonElement>("#apply-throughput");
  if (!validateNumberFields(THROUGHPUT_NUMBER_FIELDS, "#throughput-validation")) {
    applyButton.disabled = true;
    return null;
  }

  const gigabitsPerSecond = readPricingNumber("#throughput-gbps", 0, 10_000);
  const kilobitsPerStream = readPricingNumber("#stream-kbps", 1, 100_000);
  const activeHours = readPricingNumber("#active-hours", 0, 744);
  const utilization = readPricingNumber("#throughput-utilization", 0, 100) / 100;
  const concurrentStreams = (gigabitsPerSecond * 1_000_000) / kilobitsPerStream;
  const wallMinutes = activeHours * 60;
  const audioMinutes = concurrentStreams * wallMinutes * utilization;
  applyButton.disabled = audioMinutes === 0;
  return {
    concurrentStreams,
    wallMinutes,
    utilization,
    audioMinutes,
  };
}

function renderPricing(): void {
  const englishModel = readPricingModel("#english-model");
  const frenchModel = readPricingModel("#french-model");
  const usesCluster = englishModel === "cluster" || frenchModel === "cluster";
  const clusterRateInput = $<HTMLInputElement>("#cluster-rate");
  $("#cluster-rate-field").toggleAttribute("hidden", !usesCluster);
  clusterRateInput.disabled = !usesCluster;

  const pricingNumberFields = usesCluster
    ? [...PRICING_NUMBER_FIELDS, "#cluster-rate"]
    : PRICING_NUMBER_FIELDS;
  if (!validateNumberFields(pricingNumberFields, "#pricing-validation")) {
    window.clearTimeout(pricingAnnouncementTimer);
    return;
  }

  const inputs: PricingInputs = {
    sessions: readPricingNumber("#session-count", 1, MAX_SESSIONS),
    minutesPerSession: readPricingNumber("#minutes-per-session", 0.1, 1_440),
    frenchShare: readPricingNumber("#french-share", 0, 100) / 100,
    activeDays: readPricingNumber("#active-days", 1, 31),
    englishModel,
    frenchModel,
    clusterRate: usesCluster ? readPricingNumber("#cluster-rate", 0, 100) : 0,
    applyAllowances: $<HTMLInputElement>("#apply-allowances").checked,
    includePlan: $<HTMLInputElement>("#include-plan").checked,
  };

  const capturedMinutes = inputs.sessions * inputs.minutesPerSession;
  const englishMinutes = capturedMinutes * (1 - inputs.frenchShare);
  const frenchMinutes = capturedMinutes * inputs.frenchShare;
  const freeNeurons = inputs.applyAllowances ? inputs.activeDays * PRICING.dailyFreeNeurons : 0;
  const includedDurableObjectRequests = inputs.applyAllowances
    ? PRICING.durableObjectIncludedRequests
    : 0;
  const includedDuration = inputs.applyAllowances ? PRICING.durableObjectIncludedGbSeconds : 0;
  const includedWorkerRequests = inputs.applyAllowances ? PRICING.workerIncludedRequests : 0;

  const durableObjectRequestUsage =
    inputs.sessions +
    (capturedMinutes * PRICING.audioMessagesPerMinute) / PRICING.websocketBillingRatio;
  const durableObjectRequestCost = roundedUsageCost(
    durableObjectRequestUsage,
    includedDurableObjectRequests,
    PRICING.durableObjectRequestPricePerMillion,
  );
  const durationGbSeconds = capturedMinutes * 60 * PRICING.durableObjectMemoryGb;
  const durableObjectDurationCost = roundedUsageCost(
    durationGbSeconds,
    includedDuration,
    PRICING.durableObjectDurationPricePerMillion,
  );
  const workerRequestCost = roundCurrency(
    (Math.max(0, inputs.sessions - includedWorkerRequests) / 1_000_000) *
      PRICING.workerRequestPricePerMillion,
  );
  const planCost = inputs.includePlan ? PRICING.workersPaidPlan : 0;

  const routeUsage = (
    englishRouteMinutes: number,
    frenchRouteMinutes: number,
  ): RouteUsage => {
    let neurons = 0;
    let clusterMinutes = 0;

    const addRoute = (model: PricingModel, minutes: number): void => {
      if (model === "cluster") clusterMinutes += minutes;
      else neurons += minutes * PRICING_MODELS[model].neuronsPerMinute;
    };

    addRoute(inputs.englishModel, englishRouteMinutes);
    addRoute(inputs.frenchModel, frenchRouteMinutes);
    return {
      neurons,
      clusterMinutes,
      modelMinutes: englishRouteMinutes + frenchRouteMinutes,
    };
  };

  const buildEstimate = (usage: RouteUsage): CostEstimate => {
    const ai = roundCurrency(Math.max(0, usage.neurons - freeNeurons) * PRICING.neuronPrice);
    const cluster = roundCurrency(usage.clusterMinutes * inputs.clusterRate);
    const gateway = 0;
    const total = roundCurrency(
      planCost +
        ai +
        cluster +
        gateway +
        durableObjectRequestCost +
        durableObjectDurationCost +
        workerRequestCost,
    );
    return {
      total,
      plan: planCost,
      ai,
      cluster,
      gateway,
      durableObjectRequests: durableObjectRequestCost,
      durableObjectDuration: durableObjectDurationCost,
      workerRequests: workerRequestCost,
      modelMinutes: usage.modelMinutes,
      neurons: usage.neurons,
      clusterMinutes: usage.clusterMinutes,
    };
  };

  const dual = buildEstimate(routeUsage(capturedMinutes, capturedMinutes));
  const single = buildEstimate(routeUsage(englishMinutes, frenchMinutes));

  const setCost = (prefix: "dual" | "single", estimate: CostEstimate): void => {
    $(`#${prefix}-total`).textContent = formatCurrency(estimate.total);
    $(`#${prefix}-per-session`).textContent = formatUnitCurrency(estimate.total / inputs.sessions);
    $(`#${prefix}-model-minutes`).textContent = formatUsage(estimate.modelMinutes);
    $(`#${prefix}-plan-cost`).textContent = formatCurrency(estimate.plan);
    $(`#${prefix}-ai-cost`).textContent = formatCurrency(estimate.ai);
    $(`#${prefix}-cluster-cost`).textContent = formatCurrency(estimate.cluster);
    $(`#${prefix}-gateway-cost`).textContent = formatCurrency(estimate.gateway);
    $(`#${prefix}-do-request-cost`).textContent = formatCurrency(estimate.durableObjectRequests);
    $(`#${prefix}-do-duration-cost`).textContent = formatCurrency(estimate.durableObjectDuration);
    $(`#${prefix}-worker-cost`).textContent = formatCurrency(estimate.workerRequests);
    $(`#${prefix}-table-total`).textContent = formatCurrency(estimate.total);
  };

  setCost("dual", dual);
  setCost("single", single);

  const englishLabel = PRICING_MODELS[inputs.englishModel].label;
  const frenchLabel = PRICING_MODELS[inputs.frenchModel].label;
  const englishRate = PRICING_MODELS[inputs.englishModel].neuronsPerMinute;
  const frenchRate = PRICING_MODELS[inputs.frenchModel].neuronsPerMinute;
  $("#dual-route-description").textContent =
    inputs.englishModel === inputs.frenchModel
      ? `Two ${englishLabel} route slots each process every captured minute.`
      : `Every captured minute runs through ${englishLabel} and ${frenchLabel}.`;
  $("#single-route-description").textContent =
    inputs.englishModel === inputs.frenchModel
      ? `${englishLabel} processes each minute once across both languages.`
      : `${englishLabel} handles English; ${frenchLabel} handles French.`;

  const savings = Math.max(0, dual.total - single.total);
  const savingsPercent = dual.total === 0 ? 0 : (savings / dual.total) * 100;
  $("#savings-total").textContent = `${formatCurrency(savings)} / month`;
  $("#savings-percent").textContent = `${Math.round(savingsPercent)}%`;
  $("#savings-context").textContent =
    savings === 0
      ? "The selected inference paths add no billable difference at this volume."
      : "Difference after the same platform overhead and selected allowances.";
  $("#captured-minutes").textContent = `${formatUsage(capturedMinutes)} captured minutes`;
  $("#french-share-output").textContent = `${Math.round(inputs.frenchShare * 100)}%`;
  $("#allowance-summary").textContent =
    dual.neurons === 0
      ? "No Workers AI model selected"
      : inputs.applyAllowances
        ? `${formatUsage(freeNeurons)} free AI neurons applied`
        : "Shared account allowances not applied";

  $("#sizing-ai-value").textContent =
    dual.neurons === 0
      ? "No Workers AI neurons"
      : `${formatCompactUsage(dual.neurons)} → ${formatCompactUsage(single.neurons)} neurons`;
  $("#sizing-ai-copy").textContent =
    dual.neurons === 0
      ? "Neither selected route uses Workers AI; inference is sized in the own-cluster card."
      : `Hot shadow applies both rates to ${formatUsage(capturedMinutes)} min; single-active applies EN to ${formatUsage(englishMinutes)} and FR to ${formatUsage(frenchMinutes)} min. Selected rates: EN ${formatNeuronRate(englishRate)} and FR ${formatNeuronRate(frenchRate)} neurons/min.`;
  $("#sizing-gateway-value").textContent = usesCluster
    ? `${formatCompactUsage(dual.clusterMinutes)} → ${formatCompactUsage(single.clusterMinutes)} cluster min`
    : "No custom-provider traffic";
  $("#sizing-gateway-copy").textContent = usesCluster
    ? `Cluster minutes use your ${formatUnitCurrency(inputs.clusterRate)} per-minute rate. AI Gateway core features add $0; optional logs are excluded.`
    : "No own-cluster route is selected. AI Gateway core features are still publicly listed at $0.";
  $("#sizing-do-value").textContent =
    `${formatCompactUsage(durableObjectRequestUsage)} requests · ${formatCompactUsage(durationGbSeconds)} GB-s`;
  $("#sizing-do-copy").textContent =
    `${formatUsage(inputs.sessions)} connections + ${formatUsage(capturedMinutes)} min × 600 frames ÷ 20; duration is min × 60 s × 0.128 GB and is shared across concurrent model sockets.`;
  $("#sizing-worker-value").textContent = `${formatCompactUsage(inputs.sessions)} upgrades`;
  $("#sizing-worker-copy").textContent =
    `One Worker request per voice WebSocket; Paid includes 10M monthly. Static assets are free, while CPU needs measured runtime usage.`;

  const throughput = calculateThroughputMinutes();
  if (throughput) {
    $("#throughput-minutes").textContent =
      `${formatCompactUsage(throughput.audioMinutes)} audio min / month`;
    $("#throughput-formula").textContent =
      `${formatUsage(throughput.concurrentStreams)} concurrent × ${formatUsage(throughput.wallMinutes)} wall min × ${Math.round(throughput.utilization * 100)}%`;
  }

  window.clearTimeout(pricingAnnouncementTimer);
  pricingAnnouncementTimer = window.setTimeout(() => {
    $("#pricing-status").textContent =
      `Estimate updated. Hot shadow ${formatCurrency(dual.total)} per month. Single active ${formatCurrency(single.total)} per month.`;
  }, 300);
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

pricingForm.addEventListener("submit", (event) => event.preventDefault());
pricingForm.querySelectorAll("input").forEach((control) =>
  control.addEventListener("input", renderPricing),
);
pricingForm.querySelectorAll("select").forEach((control) =>
  control.addEventListener("change", renderPricing),
);
$("#apply-throughput").addEventListener("click", () => {
  const throughput = calculateThroughputMinutes();
  if (!throughput || throughput.audioMinutes === 0) return;

  if (!validateNumberFields(PRICING_NUMBER_FIELDS, "#pricing-validation")) return;
  const averageMinutes = readPricingNumber("#minutes-per-session", 0.1, 1_440);
  const sessions = Math.ceil(throughput.audioMinutes / averageMinutes);
  if (sessions > MAX_SESSIONS) {
    const status = $<HTMLParagraphElement>("#pricing-validation");
    status.textContent = "This throughput exceeds the calculator's safe session range.";
    status.hidden = false;
    return;
  }

  $<HTMLInputElement>("#session-count").value = String(sessions);
  renderPricing();
});
pricingForm.addEventListener(
  "wheel",
  (event) => {
    if (event.target instanceof Element && event.target.matches('input[type="number"], select')) {
      (event.target as HTMLElement).blur();
    }
  },
  { capture: true },
);

window.addEventListener("beforeunload", () => voice.disconnect());

setConnection(false);
setListening(false);
renderPricing();
voice.connect();
