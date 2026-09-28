# Contributing

Thank you for contributing to Voice Router.

## Development

1. Fork and clone the repository.
2. Install dependencies with `npm install`.
3. Authenticate Wrangler with `npx wrangler login`.
4. Start the project with `npm run dev`.
5. Run `npm run check` before submitting a pull request.

Workers AI calls use the authenticated Cloudflare account and may incur usage charges.

## Pull Requests

- Keep changes focused and explain the user-visible behavior.
- Add or update documentation when behavior or configuration changes.
- Do not commit credentials, `.dev.vars`, `.env` files, generated builds, or local Wrangler state.
- Confirm microphone behavior in a secure browser context when changing the voice path.
- Include manual verification steps for routing or transcription changes.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
