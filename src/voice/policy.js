// Who may speak, decided by the server (hiding a button in the browser would
// not protect the game). Pure, so it is easy to test with made-up times.

// By day, living players speak one at a time, then discussion opens up.
// Turns use at most 70% of the day, so open discussion always gets a share.
export function speakingState({ aliveIds, startedAt, dayMs, speakMs, now }) {
  const n = aliveIds.length;
  if (n === 0) return { mode: 'open' };
  const total = Math.min(n * speakMs, Math.floor(dayMs * 0.7));
  const per = Math.floor(total / n);
  const elapsed = now - startedAt;
  if (per <= 0 || elapsed < 0 || elapsed >= per * n) return { mode: 'open' };
  const index = Math.floor(elapsed / per);
  return { mode: 'turn', speakerId: aliveIds[index], turnEndsAt: startedAt + (index + 1) * per };
}

// Returns { mode, allowed: [seatId], speakerId?, turnEndsAt? } for the current moment.
export function voicePolicy({ state, activeSeatIds, startedAt, speakMs, now }) {
  if (!state || state.phase === 'over') return { mode: 'open', allowed: [...activeSeatIds] };
  if (state.phase !== 'day') return { mode: 'muted', allowed: [] };
  const aliveIds = state.players.filter((p) => p.alive).map((p) => p.id);
  const turn = speakingState({ aliveIds, startedAt, dayMs: state.settings.dayMs, speakMs, now });
  if (turn.mode === 'turn') return { mode: 'turn', allowed: [turn.speakerId], speakerId: turn.speakerId, turnEndsAt: turn.turnEndsAt };
  return { mode: 'open', allowed: aliveIds };
}
