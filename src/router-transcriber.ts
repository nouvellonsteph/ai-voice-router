import {
  WorkersAIFluxSTT,
  type Transcriber,
  type TranscriberSession,
  type TranscriberSessionOptions,
} from "agents/voice";

export type RouterMode = "auto" | "flux" | "nova";
export type RouterModel = "flux" | "nova";
export type DetectedLanguage = "en" | "fr";

export interface RouterState {
  mode: RouterMode;
  activeModel: RouterModel;
  detectedLanguage: DetectedLanguage;
  reason: "startup" | "language" | "manual" | "fallback";
  event: "state" | "switch";
  observerAvailable: boolean;
  diagnostic?: string;
  timestamp: number;
}

interface AiBinding {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

interface LanguageGuess {
  language: DetectedLanguage;
  confidence: number;
}

interface NovaWord {
  language?: string;
}

interface NovaAlternative {
  transcript?: string;
  languages?: string[];
  words?: NovaWord[];
}

interface NovaResult {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: {
    alternatives?: NovaAlternative[];
  };
}

const FRENCH_WORDS = new Set([
  "alors", "avec", "bonjour", "bonsoir", "ce", "cette", "comment", "dans",
  "des", "est", "et", "francais", "française", "français", "ici", "je",
  "les", "mais", "merci", "nous", "oui", "parle", "pas", "pour", "que",
  "qui", "suis", "sur", "tres", "très", "une", "vous", "ça",
]);

const ENGLISH_WORDS = new Set([
  "about", "and", "are", "can", "cloudflare", "english", "for", "from",
  "hello", "how", "is", "now", "please", "speaking", "that", "thank",
  "the", "this", "today", "voice", "what", "with", "you",
]);

function detectLanguage(text: string): LanguageGuess | null {
  const normalized = text.toLocaleLowerCase().replace(/[’']/g, " ");
  const words = normalized.match(/[\p{L}]+/gu) ?? [];
  if (words.length < 2) return null;

  let french = /[àâçéèêëîïôùûüÿœ]/i.test(text) ? 3 : 0;
  let english = 0;

  for (const word of words) {
    if (FRENCH_WORDS.has(word)) french += 1;
    if (ENGLISH_WORDS.has(word)) english += 1;
  }

  if (french >= 2 && french > english + 1) {
    return { language: "fr", confidence: french - english };
  }
  if (english >= 2 && english > french + 1) {
    return { language: "en", confidence: english - french };
  }
  return null;
}

function normalizeLanguage(value: string | undefined): DetectedLanguage | null {
  const language = value?.toLocaleLowerCase().split("-")[0];
  return language === "en" || language === "fr" ? language : null;
}

function languageFromAlternative(alternative: NovaAlternative): LanguageGuess | null {
  const counts: Record<DetectedLanguage, number> = { en: 0, fr: 0 };
  for (const word of alternative.words ?? []) {
    const language = normalizeLanguage(word.language);
    if (language) counts[language] += 1;
  }

  const total = counts.en + counts.fr;
  if (total > 0) {
    const language = counts.fr > counts.en ? "fr" : "en";
    return { language, confidence: counts[language] / total };
  }

  const language = normalizeLanguage(alternative.languages?.[0]);
  return language ? { language, confidence: 1 } : null;
}

class LanguageAwareNova3Transcriber implements Transcriber {
  constructor(
    private readonly ai: AiBinding,
    private readonly onLanguage: (guess: LanguageGuess) => void,
  ) {}

  createSession(options: TranscriberSessionOptions = {}): TranscriberSession {
    return new LanguageAwareNova3Session(this.ai, options, this.onLanguage);
  }
}

class LanguageAwareNova3Session implements TranscriberSession {
  private socket: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private fatalReported = false;
  private pendingChunks: ArrayBuffer[] = [];
  private finalizedSegments: string[] = [];
  private readonly ready: Promise<void>;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((reason: unknown) => void) | null = null;

  constructor(
    ai: AiBinding,
    private readonly options: TranscriberSessionOptions,
    private readonly onLanguage: (guess: LanguageGuess) => void,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.ready.catch(() => undefined);
    void this.connect(ai);
  }

  waitUntilReady(): Promise<void> {
    return this.ready;
  }

  feed(chunk: ArrayBuffer): void {
    if (this.closed) return;
    if (this.connected && this.socket) this.socket.send(chunk);
    else this.pendingChunks.push(chunk);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingChunks = [];
    try {
      this.socket?.close();
    } catch {
      // The socket may already be closed by the provider.
    }
    this.socket = null;
    this.connected = false;
    this.settleReady();
  }

  private async connect(ai: AiBinding): Promise<void> {
    try {
      const response = (await ai.run(
        "@cf/deepgram/nova-3",
        {
          encoding: "linear16",
          sample_rate: "16000",
          language: "multi",
          interim_results: "true",
          vad_events: "true",
          endpointing: "100",
          utterance_end_ms: "1000",
          smart_format: "true",
          punctuate: "true",
        },
        { websocket: true },
      )) as Response;

      if (this.closed) {
        response.webSocket?.accept();
        response.webSocket?.close();
        this.settleReady();
        return;
      }

      if (!response.webSocket) {
        throw new Error("Workers AI Nova-3 did not return a WebSocket");
      }

      this.socket = response.webSocket;
      this.socket.accept();
      this.connected = true;
      this.socket.addEventListener("message", (event) => this.handleMessage(event));
      this.socket.addEventListener("close", (event) => {
        this.connected = false;
        if (!this.closed) {
          this.reportFatal(
            new Error(`Workers AI Nova-3 WebSocket closed (${event.code}: ${event.reason || "no reason"})`),
          );
        }
      });
      this.socket.addEventListener("error", () => {
        this.connected = false;
        this.reportFatal(new Error("Workers AI Nova-3 WebSocket error"));
      });

      for (const chunk of this.pendingChunks) this.socket.send(chunk);
      this.pendingChunks = [];
      this.settleReady();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("Nova-3 connection failed");
      this.reportFatal(failure);
      this.rejectReadiness(failure);
    }
  }

  private handleMessage(event: MessageEvent): void {
    if (this.closed || typeof event.data !== "string") return;

    try {
      const data = JSON.parse(event.data) as NovaResult;
      if (data.type === "SpeechStarted") {
        this.options.onSpeechStart?.();
        return;
      }
      if (data.type !== "Results") return;

      const alternative = data.channel?.alternatives?.[0];
      if (!alternative) return;

      const transcript = alternative.transcript ?? "";
      const language = languageFromAlternative(alternative) ?? detectLanguage(transcript);
      if (language) this.onLanguage(language);

      if (data.is_final && transcript) this.finalizedSegments.push(transcript);
      if (data.speech_final) {
        const finalTranscript = this.finalizedSegments.join(" ").trim();
        this.finalizedSegments = [];
        if (finalTranscript) this.options.onUtterance?.(finalTranscript);
      } else if (!data.is_final && transcript) {
        const finalized = this.finalizedSegments.join(" ");
        this.options.onInterim?.(finalized ? `${finalized} ${transcript}` : transcript);
      }
    } catch {
      // Ignore malformed provider control frames.
    }
  }

  private settleReady(): void {
    this.resolveReady?.();
    this.resolveReady = null;
    this.rejectReady = null;
  }

  private rejectReadiness(error: Error): void {
    this.rejectReady?.(error);
    this.resolveReady = null;
    this.rejectReady = null;
  }

  private reportFatal(error: Error): void {
    if (this.closed || this.fatalReported) return;
    this.fatalReported = true;
    this.options.onFatalError?.(error);
  }
}

export class RouterTranscriber implements Transcriber {
  private session: RoutingSession | null = null;

  constructor(
    private readonly ai: AiBinding,
    private mode: RouterMode,
    private readonly onState: (state: RouterState) => void,
  ) {}

  createSession(options: TranscriberSessionOptions = {}): TranscriberSession {
    this.session = new RoutingSession(this.ai, this.mode, options, this.onState);
    return this.session;
  }

  setMode(mode: RouterMode): void {
    this.mode = mode;
    this.session?.setMode(mode);
  }
}

class RoutingSession implements TranscriberSession {
  private readonly flux: TranscriberSession;
  private readonly nova: TranscriberSession;
  private readonly ready: Promise<void>;
  private mode: RouterMode;
  private activeModel: RouterModel = "flux";
  private detectedLanguage: DetectedLanguage = "en";
  private fluxAvailable = true;
  private novaAvailable = true;
  private closed = false;
  private lastSpeechStart = 0;
  private lastFinalAt = 0;
  private lastFinalSource: RouterModel | null = null;
  private languageCandidate: DetectedLanguage | null = null;
  private languageCandidateCount = 0;
  private readonly latestInterim: Record<RouterModel, string> = {
    flux: "",
    nova: "",
  };

  constructor(
    ai: AiBinding,
    mode: RouterMode,
    private readonly options: TranscriberSessionOptions,
    private readonly onState: (state: RouterState) => void,
  ) {
    this.mode = mode;
    this.activeModel = mode === "nova" ? "nova" : "flux";

    this.flux = new WorkersAIFluxSTT(ai, {
      eotThreshold: 0.7,
      eotTimeoutMs: 1800,
      sampleRate: 16000,
      keyterms: ["Cloudflare", "Voice Router", "Workers AI"],
    }).createSession({
      onInterim: (text) => this.handleModelText("flux", text, false),
      onSpeechStart: (text) => this.handleSpeechStart(text),
      onUtterance: (text) => this.handleModelText("flux", text, true),
      onFatalError: (error) => this.handleFatal("flux", error),
    });

    this.nova = new LanguageAwareNova3Transcriber(ai, (guess) => {
      this.handleDetectedLanguage(guess);
    }).createSession({
      onInterim: (text) => this.handleModelText("nova", text, false),
      onSpeechStart: (text) => this.handleSpeechStart(text),
      onUtterance: (text) => this.handleModelText("nova", text, true),
      onFatalError: (error) => this.handleFatal("nova", error),
    });

    this.ready = this.waitForProviders();
  }

  waitUntilReady(): Promise<void> {
    return this.ready;
  }

  feed(chunk: ArrayBuffer): void {
    if (this.closed) return;
    if (this.fluxAvailable) this.flux.feed(chunk);
    if (this.novaAvailable) this.nova.feed(chunk.slice(0));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flux.close();
    this.nova.close();
  }

  setMode(mode: RouterMode): void {
    if (this.closed) return;
    const previous = this.activeModel;
    this.mode = mode;
    this.activeModel = this.resolveModel();
    this.emitState(previous === this.activeModel ? "state" : "switch", "manual");
    this.options.onInterim?.(this.latestInterim[this.activeModel]);
  }

  private async waitForProviders(): Promise<void> {
    const [flux, nova] = await Promise.allSettled([
      this.flux.waitUntilReady?.() ?? Promise.resolve(),
      this.nova.waitUntilReady?.() ?? Promise.resolve(),
    ]);

    this.fluxAvailable = flux.status === "fulfilled";
    this.novaAvailable = nova.status === "fulfilled";

    if (!this.fluxAvailable && !this.novaAvailable) {
      throw new Error("No speech recognition model could be started");
    }

    this.activeModel = this.resolveModel();
    this.emitState("state", this.fluxAvailable && this.novaAvailable ? "startup" : "fallback");
  }

  private handleModelText(source: RouterModel, text: string, final: boolean): void {
    if (final) this.handleFinal(source, text);
    else this.handleInterim(source, text);
  }

  private handleDetectedLanguage(guess: LanguageGuess): void {
    if (guess.language === this.detectedLanguage) {
      this.languageCandidate = null;
      this.languageCandidateCount = 0;
      return;
    }

    if (this.languageCandidate === guess.language) this.languageCandidateCount += 1;
    else {
      this.languageCandidate = guess.language;
      this.languageCandidateCount = 1;
    }

    if (guess.confidence < 0.7 && this.languageCandidateCount < 2) return;

    const previous = this.activeModel;
    this.detectedLanguage = guess.language;
    this.languageCandidate = null;
    this.languageCandidateCount = 0;
    if (this.mode === "auto") this.activeModel = this.resolveModel();
    this.emitState(previous === this.activeModel ? "state" : "switch", "language");
    if (previous !== this.activeModel) {
      this.options.onInterim?.(this.latestInterim[this.activeModel]);
    }
  }

  private handleInterim(source: RouterModel, text: string): void {
    this.latestInterim[source] = text;
    if (source === this.activeModel) this.options.onInterim?.(text);
  }

  private handleFinal(source: RouterModel, text: string): void {
    this.latestInterim[source] = "";
    if (source !== this.activeModel || !text.trim()) return;

    const now = Date.now();
    if (this.lastFinalSource !== source && now - this.lastFinalAt < 750) return;

    this.lastFinalAt = now;
    this.lastFinalSource = source;
    this.options.onUtterance?.(text.trim());
  }

  private handleSpeechStart(text?: string): void {
    const now = Date.now();
    if (now - this.lastSpeechStart < 500) return;
    this.lastSpeechStart = now;
    this.options.onSpeechStart?.(text);
  }

  private handleFatal(source: RouterModel, error: Error): void {
    if (this.closed) return;
    if (source === "flux") this.fluxAvailable = false;
    else this.novaAvailable = false;

    if (!this.fluxAvailable && !this.novaAvailable) {
      this.options.onFatalError?.(error);
      return;
    }

    const previous = this.activeModel;
    this.activeModel = this.resolveModel();
    this.emitState(previous === this.activeModel ? "state" : "switch", "fallback", error.message);
  }

  private resolveModel(): RouterModel {
    let preferred: RouterModel;
    if (this.mode === "flux") preferred = "flux";
    else if (this.mode === "nova") preferred = "nova";
    else preferred = this.detectedLanguage === "fr" ? "nova" : "flux";

    if (preferred === "flux" && !this.fluxAvailable) return "nova";
    if (preferred === "nova" && !this.novaAvailable) return "flux";
    return preferred;
  }

  private emitState(
    event: "state" | "switch",
    reason: RouterState["reason"],
    diagnostic?: string,
  ): void {
    this.onState({
      mode: this.mode,
      activeModel: this.activeModel,
      detectedLanguage: this.detectedLanguage,
      reason,
      event,
      observerAvailable: this.novaAvailable,
      ...(diagnostic ? { diagnostic } : {}),
      timestamp: Date.now(),
    });
  }
}
