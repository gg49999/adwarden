# Contributing

Thanks for helping out! Issues and pull requests are welcome.

## Getting started
1. Fork and clone the repo, then `npm install`.
2. Create a test bot (see the README) and a private test server.
3. `cp .env.example .env`, fill in your token and app ID, and set `DEV_GUILD_ID`
   to your test server so commands register instantly.
4. `npm run dev`

## Before opening a PR
- `npm run typecheck` and `npm test` pass.
- New ad rules: add the field to `ChannelRulesSchema` (`src/modules/ads/rules.ts`),
  the check to `evaluateAd` (`src/modules/ads/engine.ts`), and a test in `tests/`.
- Keep pure logic (rule engine, word matching, parsers) free of Discord/database
  calls so it stays testable.
- Never commit `.env`, tokens, or database files.

## Style
- TypeScript strict mode, ES modules.
- User-facing text should say what happened and what to do next.
