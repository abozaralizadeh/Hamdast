# Rules (v0.1)

These are the rules the game engine plays, and the tests in `test/engine.test.js` check each one. All numbers are starting points that real games should adjust. Change them in `src/engine/rules.js` and `.env`.

## Setup

- 6 to 12 players. Everyone plays, because the app is the moderator.
- Roles are dealt at random by the server. Nobody can see anyone else's role, except that Mafia players see their own teammates.

| Players | Mafia side | Doctor | Detective | Citizens |
| --- | --- | --- | --- | --- |
| 6 | 2 | 1 | 1 | 2 |
| 7 | 2 | 1 | 1 | 3 |
| 8 | 2 | 1 | 1 | 4 |
| 9 | 3 | 1 | 1 | 4 |
| 10 | 3 | 1 | 1 | 5 |
| 11 | 3 | 1 | 1 | 6 |
| 12 | 4 | 1 | 1 | 6 |

The Mafia side is always one Godfather plus plain Mafia players.

## Roles

- **Citizen:** no night action.
- **Doctor:** saves one living player each night. May save themselves only once per game.
- **Detective:** checks one living player (not themselves) each night and gets a private answer: Mafia or not Mafia. The Godfather reads as not Mafia.
- **Mafia:** knows the team and talks in the Mafia chat at night. Has a night action only when the Godfather is dead.
- **Godfather:** picks the night target. Reads as not Mafia to the Detective.

## Phases

1. **Introduction night.** The Mafia meets in their chat. No actions, nobody is harmed. Default 20 seconds.
2. **Day.** Everyone alive talks. Default 3 minutes. It ends early when every living player who is not absent has pressed "Ready to vote".
3. **Vote.** Default 45 seconds. It ends early when every living player who is not absent has voted.
4. **Night.** Default 45 seconds. It always runs the full time unless `NIGHT_EARLY_END=true`, because an early end would show from the timing which roles are still alive.
5. Back to day, until one side wins.

The host can change the day, vote and night times in the lobby, within the limits set by `MIN_PHASE_MS` and 15 minutes.

## Night

- Actions are chosen in secret. A player can change their choice until the night ends.
- All actions resolve at the same moment. A Doctor or Detective killed this night still has their action count.
- The Godfather picks the target. If the Godfather is dead, the first remaining Mafia player (in seat order) who picked decides.
- Mafia cannot target Mafia, and the target must be alive.
- If the Doctor saved the target, nobody dies. The morning announcement says only that nobody died, so it never shows who was saved.
- A missed action counts as no action. If the Godfather picks nobody, nobody dies.

## Vote

- A vote is final once cast. You cannot vote for yourself or a dead player. You can skip.
- The player with the most votes is out, if that is strictly more than the skips and no one else has the same count.
- A tie, or skips equal to or above the top count, means nobody is out.
- All votes are shown after the round. The role of the player who is out stays hidden until the game ends.
- A missed vote counts as a skip.

## Winning

- Citizens win when no Mafia player is left.
- Mafia wins when living Mafia players equal or outnumber everyone else.
- Both are checked after every night and every vote. At the end all roles are shown.

## Players who leave, drop or go quiet

- A dropped connection does not pause the game. The player shows as "away", can come back with the same browser, and gets their seat and role back.
- Missing two phases in a row (a night action they owed, or a vote) marks a player **absent**. The game stops waiting for them, they stay in the game and can still be voted out, and they count for the win check. Acting again clears the mark.
- Leaving on purpose marks the player absent straight away. Their token stops working, so they cannot come back.
- If the host leaves, the host role passes to the next active player.
- If everyone leaves, the room is deleted.
- If nobody who is not absent is left to wait for, a phase never ends early, so the timers run it out.

## Chat

- Lobby and game over: everyone can write in the public chat.
- Day: only living players write in the public chat. Eliminated players can read.
- Night: only living Mafia write, in the private Mafia chat. Other players cannot see it until the game ends.
- Vote: no chat.
- Messages are limited to 300 characters and 5 messages in 5 seconds per player.
