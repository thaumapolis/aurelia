/**
 * Aurelia - audio engine.
 *
 * Each string gets one oscillator voice per partial. Partial k's frequency is
 * k x fundamental (length in pixels -> Hz), and its gain is driven by how much
 * of the string's actual wave shape looks like a sine of that same shape. That
 * single rule is the whole mapping: a triangular pluck lights up many partials
 * and sounds bright, a bowed string is nearly sinusoidal and sounds pure, and
 * dragging two strings together (which changes the fundamental) glides the pitch.
 *
 * Nothing here reads the DOM, and `AudioContext` is injected so the module can
 * be unit tested against a fake graph.
 */

export const PARTIALS = 5;
const MASTER_GAIN = 0.1;
const GAIN_SMOOTHING = 0.075;
const ANALYSIS_POINTS = 96;

/** One oscillator + gain pair for one partial of one string. */
class Partial {
  constructor(context, destination, frequency, role) {
    this.oscillator = context.createOscillator();
    this.gain = context.createGain();
    this.role = role;
    this.oscillator.type = 'sine';
    this.oscillator.frequency.value = frequency;
    this.gain.gain.value = 0;
    this.oscillator.connect(this.gain);
    this.gain.connect(destination);
    this.target = 0;
  }

  start(at) {
    this.oscillator.start(at);
  }

  /**
   * Glide to a new frequency. `immediate` is used when a string was rebuilt
   * (length jumped), where a long glide would sound like a slide whistle.
   */
  setFrequency(frequency, immediate) {
    if (!Number.isFinite(frequency) || frequency <= 0) return;
    const clamped = Math.min(12000, Math.max(20, frequency));
    if (immediate) {
      this.oscillator.frequency.value = clamped;
    } else {
      this.oscillator.frequency.setTargetAtTime(clamped, this.now, 0.05);
    }
  }
}

/** Per-string synth voice: PARTIALS oscillators plus a muteable bus gain. */
class Voice {
  constructor(context, destination, line) {
    this.line = line;
    this.partials = [];
    this.bus = context.createGain();
    this.bus.gain.value = 1;
    this.bus.connect(destination);
    this.coefficients = new Float32Array(PARTIALS);
    this.generation = -1;
    this.rebuild(context, line);
  }

  rebuild(context, line) {
    const fundamental = line.pitchHz();
    if (this.partials.length === 0) {
      for (let k = 0; k < PARTIALS; k += 1) {
        this.partials.push(new Partial(context, this.bus, fundamental * (k + 1), `partial-${k + 1}`));
      }
    } else {
      for (let k = 0; k < this.partials.length; k += 1) {
        this.partials[k].setFrequency(fundamental * (k + 1), true);
      }
    }
    this.generation = line.generation;
  }

  start(at) {
    for (const partial of this.partials) partial.start(at);
  }

  dispose() {
    try {
      for (const partial of this.partials) partial.oscillator.stop();
    } catch {
      /* already stopped */
    }
    this.bus.disconnect();
  }
}

/**
 * Fourier projection of the sampled wave shape onto sine modes, run through a
 * level detector per partial. Returns gains in [0, 1].
 *
 * The string is sampled at ANALYSIS_POINTS evenly spaced points; mode k gets
 * sum(u[i] * sin(k*pi*i/(N-1))), which is the discrete sine transform the fixed
 * ends of the string actually imply.
 */
function analyse(voice, line, dt) {
  const n = line.n;
  const step = Math.max(1, Math.round(n / ANALYSIS_POINTS));
  const samples = [];
  for (let i = 0; i < n; i += step) samples.push(line.u[i]);
  const points = samples.length;
  const scale = 2 / points;
  for (let k = 1; k <= PARTIALS; k += 1) {
    let sum = 0;
    for (let i = 0; i < points; i += 1) {
      sum += samples[i] * Math.sin((k * Math.PI * i) / (points - 1));
    }
    const amplitude = Math.abs(sum * scale);
    const target = Math.min(1, amplitude * 1.35);
    const current = voice.coefficients[k - 1];
    const rate = target > current ? 0.35 : GAIN_SMOOTHING;
    voice.coefficients[k - 1] = current + (target - current) * Math.min(1, rate * dt * 60);
  }
}

export class AudioEngine {
  constructor(AudioContextCtor) {
    this.AudioContextCtor = AudioContextCtor ?? null;
    this.context = null;
    this.voices = new Map();
    this.master = null;
    this.enabled = false;
    this.muted = false;
    this.lastError = null;
  }

  /**
   * Create the AudioContext. Browsers require this to happen inside a user
   * gesture, so it is called from the first pointer-down rather than at boot.
   */
  async enable() {
    if (this.enabled) return true;
    if (!this.AudioContextCtor) {
      this.lastError = 'no-audiocontext';
      return false;
    }
    try {
      const context = new this.AudioContextCtor({ latencyHint: 'interactive' });
      const master = context.createGain();
      master.gain.value = 0;
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -12;
      limiter.knee.value = 24;
      limiter.ratio.value = 6;
      master.connect(limiter);
      limiter.connect(context.destination);
      this.context = context;
      this.master = master;
      this.enabled = true;
      this.lastError = null;
      await this._resume(context);
      return true;
    } catch (error) {
      this.lastError = String(error);
      this.enabled = false;
      return false;
    }
  }

  async _resume(context) {
    if (context.state === 'suspended') {
      try {
        await context.resume();
      } catch {
        /* autoplay policy may still block; the next gesture retries */
      }
    }
  }

  /** Call from any user gesture; retries a context the browser left suspended. */
  async unlock() {
    if (!this.enabled) return this.enable();
    await this._resume(this.context);
    return true;
  }

  disable() {
    for (const voice of this.voices.values()) voice.dispose();
    this.voices.clear();
    if (this.master) this.master.disconnect();
    if (this.context) this.context.close();
    this.context = null;
    this.master = null;
    this.enabled = false;
  }

  setMuted(muted) {
    this.muted = muted;
  }

  /** Keep one voice per string, creating/discarding as the set changes. */
  sync(strings) {
    if (!this.enabled) return;
    const live = new Set(strings.map((line) => line.id));
    for (const [id, voice] of this.voices) {
      if (!live.has(id)) {
        voice.dispose();
        this.voices.delete(id);
      }
    }
    for (const line of strings) {
      let voice = this.voices.get(line.id);
      if (!voice) {
        voice = new Voice(this.context, this.master, line);
        voice.start(this.context.currentTime);
        this.voices.set(line.id, voice);
      } else if (voice.generation !== line.generation) {
        voice.rebuild(this.context, line);
      }
    }
  }

  /** Push one frame of the simulation into the oscillators. */
  update(strings, dt) {
    if (!this.enabled) return;
    const masterTarget = this.muted ? 0 : MASTER_GAIN;
    this.master.gain.setTargetAtTime(masterTarget, this.context.currentTime, 0.05);
    for (const line of strings) {
      const voice = this.voices.get(line.id);
      if (!voice) continue;
      analyse(voice, line, dt);
      const fundamental = line.pitchHz();
      const retuned = false;
      for (let k = 0; k < PARTIALS; k += 1) {
        const partial = voice.partials[k];
        partial.now = this.context.currentTime;
        partial.setFrequency(fundamental * (k + 1), retuned);
        const strength = line.held ? 0 : voice.coefficients[k];
        partial.gain.gain.setTargetAtTime(strength, this.context.currentTime, 0.04);
      }
    }
  }
}
