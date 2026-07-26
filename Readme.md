# VC Server Bot

A single-purpose Discord bot: it joins one voice channel, stays there
24/7, and recovers automatically from every disconnect scenario it can
detect. Designed to run unattended on Railway for weeks or months.

## What it does

- Joins `VOICE_CHANNEL_ID` in `GUILD_ID` on startup.
- Keeps a single, well-defined connection state machine (`IDLE` →
  `CONNECTING` → `CONNECTED` / `RECONNECTING` → `STOPPING` → `STOPPED`).
- Recovers from: Discord gateway reconnects, voice server migration,
  voice websocket closures, network blips, and Railway process
  restarts.
- Runs a watchdog every 30 seconds that checks **actual Discord
  state** (is the bot really still in the channel, according to
  Discord - not just according to local variables) and forces a
  resync if reality has drifted.
- Never runs two reconnect attempts at once, never reuses a broken
  connection, and always destroys a stale connection before creating
  a new one.

## Requirements

- Node.js 22+
- A Discord bot token with permission to join the target voice
  channel (Connect permission on that channel).

## Configuration (Railway Variables)

Set these in your Railway service's **Variables** tab. There is no
`.env` file support by design - Railway Variables are the only
configuration source.

| Variable            | Description                                   |
|---------------------|------------------------------------------------|
| `DISCORD_TOKEN`      | Your bot's token                              |
| `GUILD_ID`           | The server (guild) ID the voice channel is in |
| `VOICE_CHANNEL_ID`   | The voice channel ID to join and stay in      |

The bot validates these on startup and fails fast with a clear error
if any are missing or malformed.

## Deploying on Railway

1. Push this repository to GitHub (or connect it directly).
2. Create a new Railway service from the repo.
3. Add the three variables above under **Variables**.
4. Railway will run `npm start` automatically (see `package.json`).
5. Watch the deploy logs - you should see:
   ```
   [timestamp] [INFO] VC Server Bot starting...
   [timestamp] [SUCCESS] Logged in as YourBot#0000.
   [timestamp] [SUCCESS] Voice connection established and ready.
   [timestamp] [SUCCESS] Watchdog running every 30s.
   ```

No PM2, Docker, or systemd config is needed or used - Railway manages
the process directly, and this bot handles `SIGTERM`/`SIGINT` cleanly
for zero-downtime redeploys.

## Project structure

```
package.json
src/
    config.js        - environment validation and all tunable constants
    logger.js         - structured, leveled logging for Railway logs
    voiceManager.js   - the voice connection state machine
    watchdog.js       - periodic real-state verification
    index.js          - process wiring, login retry, graceful shutdown
```

## Architecture notes

Every voice connection attempt is tagged with an incrementing
"epoch". Any event handler or delayed timer from a previous attempt
checks its captured epoch before it's allowed to touch shared state.
This is what prevents the classic failure modes of long-running voice
bots: duplicate reconnect loops, ghost connections left behind after a
newer attempt succeeded, and half-open sessions from a disconnect
handler firing after the bot already moved on.
