# AGENTS.md

## Project Overview

Voice Router is a Cloudflare Worker that sends live browser microphone audio to Flux and Nova-3 speech-to-text models. A Durable Object owns each session and selects Flux for English or Nova-3 for French.

## Commands

- Install dependencies: `npm install`
- Run locally: `npm run dev`
- Build frontend: `npm run build`
- Validate all checks: `npm run check`
- Generate Cloudflare types: `npm run types`
- Deploy: `npm run deploy`

## Architecture

- `src/worker.ts` is the Worker entry point.
- `src/voice-router-agent.ts` owns per-connection router state.
- `src/router-transcriber.ts` feeds both STT providers and controls handoffs.
- `src/client.ts` manages the browser voice session and renders telemetry.
- `wrangler.jsonc` is the source of truth for bindings and migrations.

## Change Guidelines

- Keep audio at 16 kHz PCM16 unless the entire voice path is updated together.
- Preserve Nova-3 word-level language metadata; automatic routing depends on it.
- Clone audio buffers before feeding the second model because WebSocket sends may transfer them.
- Keep provider failure handling isolated so one model can remain available as a fallback.
- Do not hand-edit `worker-configuration.d.ts`; regenerate it with `npm run types` after binding changes.
- Do not commit secrets, generated `dist`, `node_modules`, or `.wrangler` state.
- Prefer small, typed changes and avoid `any` or double casts.

## Verification

Run `npm run check` for every code or configuration change. For routing changes, also test one continuous session in this order: English, French, then English. Confirm the active model changes Flux, Nova-3, then Flux and that only one final transcript is emitted per utterance.
