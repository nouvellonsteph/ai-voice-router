# Voice Router

Real-time English and French speech model routing on Cloudflare Workers AI.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nouvellonsteph/ai-voice-router)

Voice Router streams microphone audio to two speech-to-text models and selects the best transcript path as the detected language changes. Flux handles English while Nova-3 provides multilingual transcription and word-level language metadata for routing.

## Features

- Automatic English and French model switching during a live session
- Manual Flux and Nova-3 routing controls
- Hot-shadow transcription for fast handoffs
- Live transcripts, routing state, latency, and switch telemetry
- Public cost simulator comparing hot shadow with single-active routing
- Stateful WebSocket sessions backed by a Durable Object
- Responsive frontend served from Workers Static Assets

## Architecture

```text
Browser microphone
       |
       v
Cloudflare Voice WebSocket
       |
       v
VoiceRouterAgent (Durable Object)
       |
       +--> Flux STT --------> English transcript
       |
       +--> Nova-3 STT ------> multilingual transcript + language metadata
                    |
                    v
             routing decision
```

Both models receive 16 kHz PCM16 audio. In automatic mode, Nova-3 language metadata selects Flux for English and Nova-3 for French. If one provider fails, the router falls back to the available model.

## Pricing Simulator

The application includes a client-side monthly cost simulator using Cloudflare's public USD list prices. Users choose a route for English and French independently: Flux, Nova-3, or no Workers AI model with inference sent to their own HTTPS cluster through an AI Gateway custom provider.

For `M` captured audio minutes, French share `F`, and selected model neuron rates `N_en` and `N_fr`, Workers AI usage is estimated as:

```text
Current hot shadow: M * (N_en + N_fr) neurons
Single active:      M * ((N_en * (1 - F)) + (N_fr * F)) neurons
Workers AI cost:    max(0, neurons - free neurons) * $0.011 / 1,000
```

An own-cluster route has a Workers AI neuron rate of zero. Its audio minutes are multiplied by the user-entered amortized cluster or provider cost. AI Gateway core features are currently listed at $0, so the simulator itemizes the gateway at $0 and keeps external inference separate.

The model rates are:

- Flux WebSocket: 700 neurons or $0.0077 per audio minute
- Nova-3 WebSocket: 836.36 neurons or $0.0092 per audio minute
- Workers AI free allocation: 10,000 neurons per active day

### Converting bandwidth to audio minutes

The optional throughput helper converts aggregate audio ingress into the session volume used by the estimate:

```text
Concurrent streams = ingress Gbps * 1,000,000 / stream kbps
Audio minutes      = concurrent streams * active hours * 60 * utilization
Voice sessions     = audio minutes / average session minutes
```

For this application's 16 kHz, 16-bit, mono PCM audio, one stream is `256 kbps`. A sustained `19 Gbps` payload therefore represents about `74,219` concurrent streams, `106,875,000` audio minutes per day, or `3,206,250,000` audio minutes in a 30-day month. This is an upper-bound conversion unless the source figure is confirmed as sustained inbound audio payload; protocol overhead, egress, idle capacity, and compression change the result.

### Feature sizing rationale

- **Workers AI**: selected route minutes are multiplied by the public per-model neuron rate. The daily free allocation is subtracted before applying `$0.011 / 1,000 neurons`.
- **AI Gateway**: custom providers can point to self-hosted HTTPS inference endpoints. Core gateway features add `$0`; own-cluster inference uses the editable per-audio-minute rate. Optional Gateway logs follow Workers Logs pricing and are excluded. The custom endpoint and streaming transport remain the user's implementation responsibility.
- **Durable Objects requests**: each session opens one connection. The installed voice client emits a frame after accumulating at least 1,600 samples at 16 kHz. The estimate conservatively uses approximately 600 incoming frames per minute, which Cloudflare's 20:1 WebSocket billing ratio converts to 30 billable requests per minute.
- **Durable Objects duration**: active provider WebSockets prevent hibernation during a call. The documented 128 MB allocation yields `60 seconds * 0.128 GB = 7.68 GB-s` per captured minute.
- **Workers**: one initial WebSocket upgrade is billed per voice session. Static asset requests are free. CPU is excluded because it requires measured runtime usage.
- **Workers Paid plan**: the optional `$5` line represents the account-wide monthly minimum. Turn it off when estimating incremental cost on an account that already has the plan.

Worker CPU, control frames, SQLite metadata, taxes, Enterprise discounts, retries, and other account traffic are excluded. Included usage is account-wide, and the daily Workers AI allowance assumes traffic is spread evenly across the selected active days.

Pricing sources, checked September 28, 2026:

- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [AI Gateway pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/)
- [AI Gateway custom providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

## Requirements

- Node.js 22.18 or later (LTS releases only)
- A Cloudflare account with Workers AI access
- Wrangler authenticated with `npx wrangler login`

Workers AI is a remote service and may incur usage charges during local development and production use.

## Local Development

```bash
npm install
npm run dev
```

Open the local URL printed by Wrangler and allow microphone access. Workers AI requests still run remotely.

## Validation

```bash
npm run check
```

This checks TypeScript, builds the frontend, and validates a dry-run Worker deployment.

## Deployment

Use the Deploy to Cloudflare button above, or deploy with Wrangler:

```bash
npm run deploy
```

Cloudflare automatically provisions the Workers AI and Durable Object bindings declared in `wrangler.jsonc`.

## Project Structure

- `src/router-transcriber.ts`: parallel transcription, language detection, and model routing
- `src/voice-router-agent.ts`: stateful Cloudflare Voice agent
- `src/worker.ts`: Worker entry point, agent routing, health endpoint, and assets
- `src/client.ts`: browser voice client and live UI state
- `index.html` and `src/styles.css`: application interface
- `wrangler.jsonc`: Cloudflare bindings and deployment configuration

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Security issues should follow [SECURITY.md](SECURITY.md), not the public issue tracker.

## License

Licensed under the [MIT License](LICENSE).
