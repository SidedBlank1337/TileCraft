export type SoundName =
  | "break" | "hit" | "place" | "pickup" | "jump" | "click" | "craft" | "level_up" | "achievement"
  | "quest" | "trade" | "market" | "notification" | "error";

export type MusicContext = "menu" | "world" | "underground" | "event";

export interface AudioSettings {
  master_volume: number;
  music_volume: number;
  sfx_volume: number;
  muted: boolean;
  music_enabled: boolean;
}

interface TrackDefinition {
  name: string;
  tempo: number;
  root: number;
  scale: number[];
  lead: OscillatorType;
  pad: OscillatorType;
  progression: number[];
}

// All music is generated live from these note patterns; no audio files ship with the game.
const TRACKS: Record<MusicContext, TrackDefinition[]> = {
  menu: [{ name: "Lantern Square", tempo: 84, root: 57, scale: [0, 2, 4, 7, 9], lead: "triangle", pad: "sine", progression: [0, 5, 3, 4] }],
  world: [
    { name: "Meadow Steps", tempo: 104, root: 60, scale: [0, 2, 4, 7, 9], lead: "square", pad: "triangle", progression: [0, 3, 4, 0] },
    { name: "Willow Drift", tempo: 92, root: 62, scale: [0, 2, 3, 7, 9], lead: "triangle", pad: "sine", progression: [0, 5, 3, 4] }
  ],
  underground: [{ name: "Hollow Echoes", tempo: 72, root: 52, scale: [0, 3, 5, 7, 10], lead: "sine", pad: "triangle", progression: [0, 5, 3, 6] }],
  event: [{ name: "Festival Lights", tempo: 124, root: 64, scale: [0, 2, 4, 5, 7, 9, 11], lead: "square", pad: "sawtooth", progression: [0, 4, 5, 3] }]
};

const SETTINGS_KEY = "tilecraft_audio";
const DEFAULT_SETTINGS: AudioSettings = { master_volume: 0.7, music_volume: 0.45, sfx_volume: 0.8, muted: false, music_enabled: true };

function NoteFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private music_gain: GainNode | null = null;
  private sfx_gain: GainNode | null = null;
  private music_timer: number | null = null;
  private music_context: MusicContext = "menu";
  private track_index = 0;
  private step = 0;
  private next_time = 0;
  settings: AudioSettings = { ...DEFAULT_SETTINGS };
  private listeners = new Set<() => void>();

  constructor() {
    try {
      const saved = localStorage.getItem(SETTINGS_KEY);
      if (saved) this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
    } catch {
      // Storage blocked: defaults apply.
    }
  }

  Subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Browsers block audio until a user gesture, so this runs from the first click/key.
  Unlock(): void {
    if (this.context) {
      if (this.context.state === "suspended") void this.context.resume();
      return;
    }
    const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    this.context = new AudioContextClass();
    this.master = this.context.createGain();
    this.music_gain = this.context.createGain();
    this.sfx_gain = this.context.createGain();
    this.music_gain.connect(this.master);
    this.sfx_gain.connect(this.master);
    this.master.connect(this.context.destination);
    this.ApplyVolumes();
    if (this.settings.music_enabled) this.StartMusic();
  }

  Update(patch: Partial<AudioSettings>): void {
    this.settings = { ...this.settings, ...patch };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // Not persisted locally; the server copy still saves.
    }
    this.ApplyVolumes();
    if (patch.music_enabled === true) this.StartMusic();
    if (patch.music_enabled === false) this.StopMusic();
    for (const listener of this.listeners) listener();
  }

  private ApplyVolumes(): void {
    if (!this.master || !this.music_gain || !this.sfx_gain) return;
    this.master.gain.value = this.settings.muted ? 0 : this.settings.master_volume;
    this.music_gain.gain.value = this.settings.music_volume * 0.35;
    this.sfx_gain.gain.value = this.settings.sfx_volume;
  }

  get playing(): boolean {
    return this.music_timer !== null;
  }

  get track_name(): string {
    const list = TRACKS[this.music_context];
    return list[this.track_index % list.length].name;
  }

  SetMusicContext(context: MusicContext): void {
    if (context === this.music_context) return;
    this.music_context = context;
    this.track_index = 0;
    this.step = 0;
    for (const listener of this.listeners) listener();
  }

  NextTrack(): void {
    this.track_index++;
    this.step = 0;
    for (const listener of this.listeners) listener();
  }

  StartMusic(): void {
    if (!this.context || this.music_timer !== null) return;
    this.next_time = this.context.currentTime + 0.1;
    this.music_timer = window.setInterval(() => this.ScheduleMusic(), 100);
    for (const listener of this.listeners) listener();
  }

  StopMusic(): void {
    if (this.music_timer !== null) clearInterval(this.music_timer);
    this.music_timer = null;
    for (const listener of this.listeners) listener();
  }

  private ScheduleMusic(): void {
    const context = this.context;
    if (!context || !this.music_gain) return;
    const list = TRACKS[this.music_context];
    const track = list[this.track_index % list.length];
    const beat = 60 / track.tempo / 2;
    while (this.next_time < context.currentTime + 0.3) {
      const bar = Math.floor(this.step / 8) % track.progression.length;
      const chord_root = track.root + track.scale[track.progression[bar] % track.scale.length] + (track.progression[bar] >= track.scale.length ? 12 : 0);
      if (this.step % 8 === 0) {
        for (const offset of [0, 7, 12]) this.Tone(NoteFrequency(chord_root - 12 + offset), this.next_time, beat * 7.5, track.pad, 0.06, this.music_gain);
      }
      // Deterministic pseudo-random melody so tracks loop recognizably.
      const seed = Math.sin((this.step + this.track_index * 97) * 12.9898) * 43758.5453;
      const roll = seed - Math.floor(seed);
      if (roll > 0.35) {
        const degree = Math.floor(roll * 100) % track.scale.length;
        const octave = roll > 0.85 ? 12 : 0;
        this.Tone(NoteFrequency(track.root + 12 + track.scale[degree] + octave), this.next_time, beat * 0.9, track.lead, 0.05, this.music_gain);
      }
      if (this.step % 4 === 0) this.Tone(NoteFrequency(chord_root - 24), this.next_time, beat * 1.8, "triangle", 0.08, this.music_gain);
      this.next_time += beat;
      this.step++;
    }
  }

  private Tone(frequency: number, start: number, duration: number, type: OscillatorType, volume: number, destination: AudioNode, slide_to?: number): void {
    const context = this.context!;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    if (slide_to) oscillator.frequency.exponentialRampToValueAtTime(slide_to, start + duration);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.05);
  }

  private Noise(start: number, duration: number, volume: number, filter_frequency: number): void {
    const context = this.context!;
    const buffer = context.createBuffer(1, Math.floor(context.sampleRate * duration), context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    source.buffer = buffer;
    filter.type = "lowpass";
    filter.frequency.value = filter_frequency;
    gain.gain.value = volume;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfx_gain!);
    source.start(start);
  }

  Play(name: SoundName): void {
    if (!this.context || !this.sfx_gain || this.settings.muted) return;
    const now = this.context.currentTime;
    const out = this.sfx_gain;
    const arpeggio = (notes: number[], step: number, type: OscillatorType, volume: number) =>
      notes.forEach((note, index) => this.Tone(NoteFrequency(note), now + index * step, step * 1.6, type, volume, out));
    switch (name) {
      case "hit": this.Noise(now, 0.06, 0.25, 900); break;
      case "break": this.Noise(now, 0.18, 0.4, 1400); this.Tone(160, now, 0.12, "square", 0.08, out, 70); break;
      case "place": this.Tone(220, now, 0.07, "square", 0.08, out, 330); break;
      case "pickup": arpeggio([76, 83], 0.05, "triangle", 0.12); break;
      case "jump": this.Tone(300, now, 0.12, "square", 0.05, out, 520); break;
      case "click": this.Tone(660, now, 0.04, "square", 0.05, out); break;
      case "craft": arpeggio([64, 67, 71], 0.06, "triangle", 0.1); this.Noise(now, 0.1, 0.15, 3000); break;
      case "level_up": arpeggio([60, 64, 67, 72, 76, 79], 0.08, "square", 0.08); break;
      case "achievement": arpeggio([67, 71, 74, 79], 0.1, "triangle", 0.14); break;
      case "quest": arpeggio([72, 76, 79], 0.09, "triangle", 0.12); break;
      case "trade": arpeggio([69, 73, 76], 0.07, "sine", 0.14); break;
      case "market": arpeggio([79, 84], 0.06, "triangle", 0.12); break;
      case "notification": arpeggio([81, 76], 0.07, "sine", 0.1); break;
      case "error": this.Tone(180, now, 0.15, "sawtooth", 0.06, out, 120); break;
    }
  }
}

export const audio = new AudioEngine();
