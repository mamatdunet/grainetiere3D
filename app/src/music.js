// The tracks are served with the site, so they stay behind the password page.
const AMBIENT_LEVEL = 1;
const TRACK_LEVEL = 0.4; // the ambient track is mastered about 10 dB below the others
const TRACKS = [
  { name: 'Morceau 1', url: new URL('./music/track-01.mp3', import.meta.url).href, level: TRACK_LEVEL },
  { name: 'Morceau 2', url: new URL('./music/track-02.mp3', import.meta.url).href, level: TRACK_LEVEL },
  { name: 'Morceau 3', url: new URL('./music/track-03.mp3', import.meta.url).href, level: TRACK_LEVEL },
  { name: 'Morceau 4', url: new URL('./music/track-04.mp3', import.meta.url).href, level: TRACK_LEVEL },
  { name: 'Morceau 5', url: new URL('./music/track-05.mp3', import.meta.url).href, level: TRACK_LEVEL },
  { name: 'Morceau 6', url: new URL('./music/track-06.mp3', import.meta.url).href, level: TRACK_LEVEL },
  { name: 'Ambiance', url: new URL('./music/ambient.mp3', import.meta.url).href, level: AMBIENT_LEVEL },
];

function shuffled(items) {
  const order = [...items];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

export class Music {
  constructor(onChange) {
    this.onChange = onChange;
    this.volume = 0.6;
    this.playing = false;
    this.order = shuffled(TRACKS);
    this.position = 0;
  }

  get tracks() {
    return TRACKS;
  }

  get current() {
    return this.order[this.position];
  }

  // Must be called from a click or a key press: browsers refuse sound otherwise.
  setup() {
    if (this.audio) return;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.addEventListener('ended', () => this.next());
    const Context = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Context();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;
    // A gain node rather than audio.volume, which iPhones ignore.
    this.ctx.createMediaElementSource(this.audio).connect(this.gain).connect(this.ctx.destination);
    this.audio.src = this.order[this.position].url;
  }

  async play() {
    this.setup();
    this.playing = true;
    this.onChange();
    try {
      await this.ctx.resume();
      await this.audio.play();
      this.fade(1);
    } catch (error) {
      console.warn('musique', error);
      this.playing = false;
      this.onChange();
    }
  }

  pause() {
    this.playing = false;
    this.audio?.pause();
    this.onChange();
  }

  next() {
    this.choose(this.order[(this.position + 1) % this.order.length]);
  }

  choose(track) {
    this.setup();
    this.position = this.order.indexOf(track);
    this.audio.src = track.url;
    this.gain.gain.value = 0;
    this.onChange();
    if (this.playing) this.play();
  }

  setVolume(value) {
    this.volume = value;
    if (this.playing) this.fade(0.1);
  }

  fade(seconds) {
    const now = this.ctx.currentTime;
    const level = this.volume * this.order[this.position].level;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.linearRampToValueAtTime(level, now + seconds);
  }
}
