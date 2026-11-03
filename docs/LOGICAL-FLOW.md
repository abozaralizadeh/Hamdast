# Logical flow

The main flows, step by step. Flows 1 to 5 are built (v0.1). Flow 6 is built-in voice, which is not built yet: the server side runs against a local fake only.

## 1. Create a room and join

1. A player opens the site, picks a nickname and taps Create room.
2. The server makes a room with a short code and link. That player becomes the room host.
3. The host shares the link in any messaging app.
4. Friends open the link, pick a nickname and land in the lobby.
5. The host starts the game when 6 to 12 players are in. The host can remove someone before it starts.

```mermaid
sequenceDiagram
    actor Host
    actor Friend
    participant Server
    Host->>Server: Create room with nickname
    Server-->>Host: Room code, link, session token
    Host-->>Friend: Shares link outside the app
    Friend->>Server: Join room with nickname
    Server-->>Friend: Session token and lobby view
    Server-->>Host: Player list updated
    Host->>Server: Start game
    Server->>Server: Check 6 to 12 players, deal roles
    Server-->>Host: Own role only
    Server-->>Friend: Own role only
```

## 2. The game loop

1. Each player sees only their own role. Mafia players also see their team.
2. First night is an introduction: the Mafia team meets and nobody is harmed.
3. Day: the app announces what happened, then players talk until the timer ends.
4. Vote: each living player picks someone or skips.
5. Night: roles act in secret.
6. After each night and each vote the app checks for a winner.

```mermaid
stateDiagram-v2
    [*] --> Lobby
    Lobby --> RoleReveal: Host starts
    RoleReveal --> IntroNight
    IntroNight --> Day
    Day --> Vote: Timer ends
    Vote --> WinCheckAfterVote
    WinCheckAfterVote --> Night: No winner
    WinCheckAfterVote --> GameOver: Winner
    Night --> WinCheckAfterNight
    WinCheckAfterNight --> Day: No winner
    WinCheckAfterNight --> GameOver: Winner
    GameOver --> Lobby: Play again
    GameOver --> [*]: Leave
```

## 3. Night

1. Everyone sees the night screen. Living players with a role get their action.
2. The Mafia team talks in its private chat. The Godfather picks the target. If the Godfather is gone, the remaining Mafia picks.
3. The Doctor picks one person to save.
4. The Detective picks one person to check.
5. The night ends when all actions are in or the timer runs out. A missed action counts as no action.
6. The server works out the result. If the target was saved, nobody dies.
7. The Detective gets a private answer. The Godfather always reads as not Mafia.

```mermaid
flowchart TD
    A["Night starts"] --> B["Collect Mafia, Doctor and Detective actions"]
    B --> C{"All in, or timer ended?"}
    C -- No --> B
    C -- Yes --> D{"Mafia picked a target?"}
    D -- No --> F["Nobody dies"]
    D -- Yes --> E{"Doctor saved the target?"}
    E -- Yes --> F
    E -- No --> G["Target is eliminated"]
    F --> H["Send Detective a private answer"]
    G --> H
    H --> I["Check for a winner"]
```

## 4. Day and vote

1. The app announces who was eliminated, or that nobody was. It doesn't reveal roles or who saved whom.
2. Living players talk until the timer ends. Eliminated players can read but not write.
3. Living players vote in secret. Votes appear when everyone has voted or the timer ends.
4. The player with the most votes is eliminated. A tie, or skip having the most votes, means nobody goes.

```mermaid
flowchart TD
    A["Vote opens"] --> B["Living players pick someone or skip"]
    B --> C["Timer ends or all votes are in"]
    C --> D["Show the votes"]
    D --> E{"One player has the most votes?"}
    E -- No --> F["Nobody is eliminated"]
    E -- Yes --> G["Player is eliminated, role stays hidden"]
    F --> H["Check for a winner"]
    G --> H
    H --> I{"Winner?"}
    I -- Yes --> J["Game over, all roles shown"]
    I -- No --> K["Night"]
```

Win checks:

- Citizens win when no Mafia players are left.
- Mafia wins when living Mafia players equal or outnumber everyone else.

## 5. Dropped connection

1. The browser keeps a session token.
2. If the connection drops, the player shows as away and the game carries on.
3. On return, the token restores their seat and the server sends the current view.
4. If they miss their action, it counts as no action. If they miss a vote, it counts as a skip.
5. After two missed phases in a row they're marked absent and stay in the game as someone who can be voted out. Mafia's win check still counts them.
6. If the room host is gone, the host role passes to the next player. The app runs the game, so play doesn't stop.

```mermaid
sequenceDiagram
    actor Player
    participant Server
    participant Others as Other players
    Player--xServer: Connection lost
    Server-->>Others: Player shown as away
    Server->>Server: Timers keep running
    Player->>Server: Reconnect with session token
    Server->>Server: Check token, find seat
    Server-->>Player: Current filtered view
    Server-->>Others: Player is back
```

## 6. Voice (Phase 6)

1. When the game starts, the server creates one voice room and gives each player a token.
2. The server decides who can talk, so hiding a mic button isn't what protects the game.
3. By day, players speak in turn with a timer. Then there's a short open discussion.
4. At night every mic is off and the Mafia team uses its text chat.
5. Eliminated players can listen but not speak.
6. If voice can't connect, the player stays in with text and sees a clear message.
7. Audio is never recorded.

```mermaid
sequenceDiagram
    participant Game as Game server
    participant Voice as Voice server
    actor Speaker
    actor Others
    Game->>Voice: Day turn: allow Speaker's mic only
    Speaker->>Voice: Talks
    Voice-->>Others: Audio
    Game->>Voice: Turn over: move to next speaker
    Game->>Voice: Night: mute all
```

## 7. Report and block (before the public test)

1. Any player can report another from the player list, with a reason.
2. The report saves the nickname, room, time and recent chat from that game, so it's kept after chat would normally be deleted.
3. Blocking hides that player's chat for the person who blocked them.
4. A person reviews reports and can ban a session or remove content.
5. Report data is deleted after review, on a fixed schedule.

```mermaid
flowchart LR
    A["Player taps report"] --> B["Reason and game details saved"]
    B --> C["Review queue"]
    C --> D{"Breaks the rules?"}
    D -- Yes --> E["Ban or remove"]
    D -- No --> F["Close report"]
    E --> G["Delete data on schedule"]
    F --> G
```
