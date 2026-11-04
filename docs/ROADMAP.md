# Roadmap

What works now, and what is left to build or check. Contributions on any open item are welcome, see "Contributing" in the [README](../README.md).

## Works now

- Rules engine with every rule covered by tests, and a simulator that plays thousands of random games
- Rooms, live updates, server timers, reconnect, and recovery after a server restart
- Each player only ever receives what they may see, proven by a test that plays a full game and checks every payload
- Day chat and a private Mafia chat at night, with rate limits
- Report, block and host kick, nickname rules, and a command line tool for reviewing reports
- Farsi (right to left) and English, phone first, with contrast and layout checks
- Data kept short: games and chat are deleted 24 hours after a game ends
- `setup_service.sh` for a Linux VM, a daily backup, a health check timer, and a size-limited log file
- Runs under a path such as `/hamdast/` behind an nginx that is already there, proven by a test that plays a game through a path-stripping proxy
- Caps on open rooms, per address and in total
- A load script (`npm run load`) that plays many rooms at once

## To build

- [ ] **Real voice.** The server already decides who may speak (turns by day, muted at night and during votes) and tells a voice provider. Only a fake provider exists, and it carries no audio. A real provider needs a self-hosted voice server such as LiveKit, working over TLS on port 443.
- [ ] Fall back to text when voice can't connect
- [ ] Automated browser tests (the screens were only checked by hand so far)
- [x] Bundle a Farsi web font with a licence that allows it (Vazirmatn, SIL Open Font License)
- [ ] A screen reader pass, and checks on real Android and iPhone browsers, including older phones
- [ ] Check install as a home screen app (the manifest, icon and service worker exist but were never tried on a real device)
- [ ] Stronger answer to repeat troublemakers. A ban only covers one session token today, because there are no accounts. See "Notes on the data" in [DESIGN.md](DESIGN.md).
- [ ] Alerts that reach a person when the health check fails (it shows in `systemctl --failed` and the journal today)
- [ ] Load test with voice on, and a load test on a real server instead of one machine
- [ ] Run `setup_service.sh` on a fresh VM, then again, to confirm the update path (both the own-VM and the shared nginx mode)
- [ ] Fill in `config/blocked-words.txt` with help from native Farsi and English speakers (it is empty on purpose)
- [ ] A second rule set, for example with more roles
- [ ] Balance: the simulator uses random players, so its win rates say nothing about real balance. Real games are needed to tune role counts and timers.

## Ideas for later

- A spoken defence round before a vote
- Spectators
- More languages
- Public rooms and matchmaking, which would need real moderation first
- Optional accounts
