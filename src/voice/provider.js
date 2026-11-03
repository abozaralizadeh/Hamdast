// Voice provider interface. A provider talks to whatever carries the audio.
// Only the fake exists. It carries no audio and needs no outside service.
// A real provider (the plan proposes a self-hosted LiveKit server) would
// implement the same four methods, and is not built yet.
//
//   openRoom(roomId)                 start a voice room for a game
//   tokenFor(roomId, seatId)         what a browser needs to join that room
//   setSpeakers(roomId, seatIds)     only these seats may publish audio
//   closeRoom(roomId)                tear the voice room down

export class FakeVoice {
  enabled = true;
  name = 'fake';

  constructor() {
    this.rooms = new Map();
    this.calls = [];
  }

  openRoom(roomId) {
    this.calls.push(['openRoom', roomId]);
    if (!this.rooms.has(roomId)) this.rooms.set(roomId, { speakers: [] });
  }

  tokenFor(roomId, seatId) {
    this.calls.push(['tokenFor', roomId, seatId]);
    // Not a credential: it only says this is the local stand-in.
    return { provider: 'fake', url: null, token: `fake:${roomId}:${seatId}` };
  }

  setSpeakers(roomId, seatIds) {
    this.calls.push(['setSpeakers', roomId, [...seatIds]]);
    const room = this.rooms.get(roomId);
    if (room) room.speakers = [...seatIds];
  }

  speakersOf(roomId) {
    return this.rooms.get(roomId)?.speakers ?? [];
  }

  closeRoom(roomId) {
    this.calls.push(['closeRoom', roomId]);
    this.rooms.delete(roomId);
  }
}

export const NoVoice = Object.freeze({
  enabled: false,
  name: 'off',
  openRoom() {},
  tokenFor() { return null; },
  setSpeakers() {},
  closeRoom() {},
});

export function createVoice(config) {
  if (config.voiceProvider === 'fake') return new FakeVoice();
  return NoVoice;
}
