# Adwarden

[![CI](https://github.com/gg49999/adwarden/actions/workflows/ci.yml/badge.svg)](https://github.com/gg49999/adwarden/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A self-hostable Discord bot for **advertising servers**. It reads every invite posted in
your ad channels, works out which server it points to, and enforces your rules: no
link-only posts, no NSFW servers in SFW channels, cooldowns per user *and* per
advertised server, blocklists that survive new invite codes, and more. It also keeps
ad channels clean by itself and includes the moderation, role and anti-raid tools an
ad server needs.

```
member posts ad ─▶ anti-scam / anti-spam ─▶ invite lookup ─▶ channel rules ─▶ keep · delete + DM · review queue
                                                                                │
                                         sticky "Post an Ad" message ◀──────────┘ moves back to the bottom
```

## Features

### Invite-aware ad checks
- Every `discord.gg` / `discord.com/invite` link is looked up: target server ID, name,
  member count, NSFW level, and whether it's expired.
- Hidden invites are caught: zero-width characters, `discord . gg / code` spacing,
  masked markdown links, and link shorteners (`dsc.gg`, `bit.ly`, …), which are
  followed to see where they lead.
- **Per-channel rule profiles** (27 rules) with Strict / Standard / Relaxed presets:
  require an invite, max invites, minimum description length (stops link-only
  posts), no other links or an allowed-domain list, max lines/emojis/caps, no
  `@everyone` or role pings, required keywords, SFW only, minimum server size,
  minimum time in your server, user cooldown, per-server cooldown, cross-channel
  duplicates, and ad expiry.
- **What happens on a violation** is chosen per channel: delete + DM the reason,
  delete quietly, send to the review queue, or log only. It can optionally add a
  warning or a timeout.
- The DM tells the poster exactly what to fix and includes their ad so they can
  copy, fix and repost it.
- **Edits are re-checked.** An ad that's edited into a scam, a different server or an
  NSFW invite is removed.
- **Blocklist by server ID.** A blocked server stays blocked when it makes new invites,
  and its existing ads are removed right away.
- **Ad bans:** stop someone from advertising without banning them from the server.
- **`/test-ad`** dry-runs an ad against a channel's rules.

### Rulesets
- Named, reusable sets of restrictions, e.g. "Big servers", "Gaming", "Partners".
  Link several channels to one ruleset, and a change to the ruleset applies to all of
  them.
- Each ruleset or channel can set character limits (minimum and maximum description
  length, maximum total length, lines, emojis), whether attachments are allowed,
  timing, and **its own blocked-words list**.
- Manage them in `/settings` → Ad rules, or with `/ruleset create|rule|apply|unlink|view|list|delete`.
  Deleting a ruleset leaves every linked channel with a copy of its rules.

### Word filter
- A server-wide filtered-word list with its own tab in `/settings`.
- Matching syntax: `word` (whole word), `word*` (starts with), `*word` (ends with), and
  `*word*` (anywhere). Multi-word phrases work too.
- Catches **l33tspeak**, s p a c e d and s.p.a.c.e.d letters, stretched letters
  (freeeee), accents and fullwidth/styled look-alike letters. Each of these can be
  switched off.
- Applies to every channel, only ad channels, or only channels you pick, with exempt
  channels, exempt roles and an optional staff exemption.
- Actions: delete (with an optional DM), delete + warn (counts toward escalation),
  delete + timeout, or log only. Edited messages are checked too.
- A **Test** button checks a message against the filter without posting anything.

### Sticky messages
- Keeps a message at the bottom of a channel. It reposts after a short quiet period
  (debounced, one repost at a time per channel, sends the new copy before deleting the
  old one), and restarts are handled.
- An optional **📢 Post an Ad** button opens a form. The bot checks the ad and posts it
  as a clean, consistent embed with the server's icon, member count, tags and a Join
  button.
- It can show the channel's live rule summary, so the sticky never falls out of date.

### Stale-ad cleanup
- An author leaves → their ads are deleted after a grace period (cancelled if they
  rejoin).
- An invite dies → the ad is deleted (invites are re-checked in the background).
- Ads expire after N days, if the channel is set to.
- A weekly cleanup report goes to the ad log.

### Review queue
- Strict channels can review every ad, or only rule-breaking ones. Staff get
  **Approve / Reject (with reason) / Reject + 7-day ad ban** buttons, plus the resolved
  server info.
- **Advertiser reputation:** clean posts raise it and violations lower it. Trusted
  posters (by score or by role) skip the queue.

### Moderation
- `/warn` `/timeout` `/untimeout` `/kick` `/ban` (permanent or temporary) `/softban`
  `/unban` `/note`, with numbered cases, `/history`, and `/case view|reason|void`.
- **Escalation ladder** (default: 3 warns → 1h timeout, 5 → 1d, 7 → ban).
- **Ban appeals:** the ban DM has an Appeal button, and staff accept or deny in an
  appeals channel.
- `/purge` with filters (user, bots, humans, links, invites, attachments, text).
- `/channel lock|unlock|slowmode`, and `/lockdown start|end`, which restores exactly the
  channels it locked.
- **`/report-dm`:** members report DM advertisers with a screenshot, and staff act on it
  with Warn / Ban / Dismiss buttons.

### Roles
- Button role panels (toggle mode or pick-one mode) with `/panel`.
- `/role add|remove|temp|bulk`. Bulk changes show a preview and ask for confirmation
  first.
- Join roles (with an optional delay), plus roles that are **restored when someone
  rejoins** (e.g. quarantine), so leaving and rejoining doesn't shed a punishment.

### Anti-raid and anti-scam
- Blocks scam/phishing links (look-alike detection, a local list, and an optional
  remote community list).
- Mass-mention and cross-channel copy-paste spam detection.
- Minimum account age → log, quarantine role, or kick.
- Join-burst raid alerts with optional automatic lockdown.

### Logging and stats
- Mod, ad, message (edit/delete) and member (join/leave) logs, each in its own channel
  or all in one.
- `/ad stats`: most-advertised servers, top advertisers, which rules fire most, and the
  rejection rate.

### Setup
- **`/setup`**: one screen to pick ad channels, a preset, a log channel, a review
  channel, and whether to post sticky "Post an Ad" messages. It also tells you which
  permissions the bot is missing.
- **`/settings`**: a tabbed control panel (Overview · Ad rules · Word filter ·
  Anti-raid · Channels) where you toggle rules from menus and edit limits in forms.
  Changes save immediately.
- `/config view|channel|module|ads|antiraid|escalation` for typed changes.
- **`/config export` / `import`:** share a whole setup between servers as a file.

---

## Running it

### 1. Create the Discord application
1. Go to <https://discord.com/developers/applications> → **New Application**.
2. **Bot** tab → **Reset Token**, then copy it.
3. On the same tab, turn on **Server Members Intent** and **Message Content Intent**.
   The bot needs both: one to read ads, one for join/leave cleanup.
4. Invite the bot. Replace `CLIENT_ID` with your Application ID:
   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands&permissions=1099780189206
   ```
5. In **Server Settings → Roles**, drag the bot's role **above** the roles it should
   manage or moderate.

### 2. Configure
```bash
cp .env.example .env
```
Fill in `DISCORD_TOKEN` and `CLIENT_ID`. Optionally set `DEV_GUILD_ID` to your test
server's ID so commands register instantly there instead of globally.

### 3. Start
Requires Node.js 20.12 or newer.
```bash
npm install
npm run dev        # development: auto-restarts on file changes
```
For production:
```bash
npm run build
npm start
```
Both commands create or upgrade the SQLite database (`prisma/adwarden.db`) and
register the slash commands on startup. Set `DEPLOY_ON_START=false` to skip
registering, or run `npm run deploy` by hand.

### Docker
```bash
docker compose up -d --build
```
The database is kept in the `adwarden-data` volume.

### Postgres instead of SQLite
Change `provider` in `prisma/schema.prisma` to `"postgresql"`, set `DATABASE_URL` to
your connection string, and run `npm run db:push`.

## Permissions

| Permission | Why |
|---|---|
| View Channels, Send Messages, Embed Links, Read Message History | Reading ads, posting stickies, logs and ad embeds |
| Manage Messages | Removing ads that break rules, `/purge` |
| Moderate Members | Timeouts |
| Kick / Ban Members | `/kick`, `/ban`, escalation, anti-raid |
| Manage Roles | Role panels, join roles, quarantine, `/role` |
| Manage Channels | `/channel lock`, `/lockdown`, slowmode |
| Attach Files | `/config export` |

Only the moderation features need the moderation permissions. The ad checks and
stickies work with just the first two rows.

## Development

```bash
npm test           # rule-engine, invite-detection and parser tests (vitest)
npm run typecheck
```

```
src/
  index.ts              startup, event wiring, background jobs
  client.ts             discord.js client + intents
  registry.ts           every command and button/modal handler
  core/                 config schema, permissions, replies, durations
  modules/
    ads/                engine (pure rules), invite lookup, review queue,
                        /ad /adchannel /blocklist /test-ad /adban, stale cleanup
    sticky/             sticky messages
    moderation/         cases, escalation, appeals, reports, lockdown
    roles/              panels, temp/bulk roles, auto & persistent roles
    antiraid/           scam links, spam, join gate, raid detection
    logging/            log channels, message/member logs
    wordfilter/         word matching (pure) + message handler
    setup/              /setup wizard, /settings panel, /config
tests/                  unit tests for the pure parts
prisma/schema.prisma    database schema
```

The rule engine (`src/modules/ads/engine.ts`) is a pure function: all lookups happen
before it runs. To add a rule, add a field to `ChannelRulesSchema` in `rules.ts`, a
check in `evaluateAd`, and a test.

## Privacy
Adwarden stores moderation cases, ad metadata (message ID, author ID, advertised
server ID and name) and per-server settings. Ad text is stored only while an ad waits
in the review queue. Message logs are posted to channels you choose and aren't kept by
the bot.

## License
MIT
