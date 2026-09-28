# Voice Router

Real-time English and French speech model routing on Cloudflare Workers AI.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nouvellonsteph/ai-voice-router)

Voice Router streams microphone audio to two speech-to-text models and selects the best transcript path as the detected language changes. Flux handles English while Nova-3 provides multilingual transcription and word-level language metadata for routing.

## Features

- Automatic English and French model switching during a live session
- Manual Flux and Nova-3 routing controls
- Hot-shadow transcription for fast handoffs
- Live transcripts, routing state, latency, and switch telemetry
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
