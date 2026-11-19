(($) => {
  'use strict';

  const PLAYBACK_CONFLICT_MESSAGE = 'Another media player is playing and cannot be interrupted.';
  const PAGE_INSTANCE_STATE_KEY = 'plMediaPlayerPageInstanceId';
  const VOLUME_STORAGE_KEY = 'pl-media-player:volume:v1';
  const TEST_TONE_LEVELS = [0.08, 0.16, 0.32];
  const TEST_TONE_DURATION = 0.2;
  const TEST_TONE_GAP = 0.08;
  const volumePreferenceManagers = new WeakMap();
  let transientVolumePreferenceManager = null;
  let testSoundAudioContext = null;

  function createPageInstanceId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function pageInstanceId(variantId) {
    try {
      const state = history.state;
      if (
        state !== null &&
        typeof state === 'object' &&
        !Array.isArray(state) &&
        typeof state[PAGE_INSTANCE_STATE_KEY] === 'string'
      ) {
        return state[PAGE_INSTANCE_STATE_KEY];
      }

      // Do not replace a non-object state owned by the host application.
      if (state !== null && (typeof state !== 'object' || Array.isArray(state))) {
        return `variant:${variantId}`;
      }

      const id = createPageInstanceId();
      history.replaceState({ ...state, [PAGE_INSTANCE_STATE_KEY]: id }, '');
      return id;
    } catch {
      // History can be unavailable in embedded or privacy-restricted contexts.
      return `variant:${variantId}`;
    }
  }

  function bindPageInstanceReset() {
    if (typeof document === 'undefined') return;
    document.addEventListener(
      'click',
      (event) => {
        if (!event.target.closest?.('.js-new-variant-button')) return;
        try {
          const state = history.state;
          if (
            state === null ||
            typeof state !== 'object' ||
            Array.isArray(state) ||
            typeof state[PAGE_INSTANCE_STATE_KEY] !== 'string'
          ) {
            return;
          }
          const nextState = { ...state };
          delete nextState[PAGE_INSTANCE_STATE_KEY];
          history.replaceState(nextState, '');
        } catch {
          // A new variant can still load when history state is unavailable.
        }
      },
      { capture: true },
    );
  }

  function isVolume(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
  }

  function isAudibleVolume(value) {
    return isVolume(value) && value > 0;
  }

  class VolumePreferenceManager {
    constructor(storage) {
      this.storage = storage;
      this.$events = $({});
      this.preference = this.#read();
    }

    #read() {
      if (!this.storage) return null;
      try {
        const value = JSON.parse(this.storage.getItem(VOLUME_STORAGE_KEY));
        if (!isVolume(value?.volume)) return null;
        const lastAudibleVolume = isAudibleVolume(value?.lastAudibleVolume)
          ? value.lastAudibleVolume
          : isAudibleVolume(value.volume)
            ? value.volume
            : 1;
        return { volume: value.volume, lastAudibleVolume };
      } catch {
        return null;
      }
    }

    #persist() {
      if (!this.storage || !this.preference) return;
      try {
        this.storage.setItem(VOLUME_STORAGE_KEY, JSON.stringify(this.preference));
      } catch {
        // Storage can be disabled, full, or blocked by browser privacy settings.
      }
    }

    register(controller) {
      this.$events.on('preferencechange', (_event, preference) => {
        controller.applyVolumePreference(preference, false);
      });
      if (this.preference) controller.applyVolumePreference(this.preference, true);
    }

    update(volume) {
      if (!isVolume(volume)) return;
      const lastAudibleVolume = isAudibleVolume(volume)
        ? volume
        : (this.preference?.lastAudibleVolume ?? 1);
      this.preference = { volume, lastAudibleVolume };
      this.#persist();
      this.$events.trigger('preferencechange', [this.preference]);
    }
  }

  function volumePreferenceManager(storage) {
    if (storage && (typeof storage === 'object' || typeof storage === 'function')) {
      let manager = volumePreferenceManagers.get(storage);
      if (!manager) {
        manager = new VolumePreferenceManager(storage);
        volumePreferenceManagers.set(storage, manager);
      }
      return manager;
    }

    // Keep browser instances synchronized even when persistent storage is unavailable.
    transientVolumePreferenceManager ??= new VolumePreferenceManager(null);
    return transientVolumePreferenceManager;
  }

  class PlaybackCoordinator {
    constructor() {
      this.controllers = new Set();
    }

    register(controller) {
      this.controllers.add(controller);
    }

    requestPlayback(controller) {
      const conflicts = [...this.controllers].filter(
        (other) =>
          other !== controller &&
          other.media.paused === false &&
          !other.media.ended &&
          (!controller.config.allowOverlappingPlayback || !other.config.allowOverlappingPlayback),
      );
      if (conflicts.some((other) => !other.config.allowPause)) return false;
      for (const other of conflicts) other.pauseForAnotherPlayer();
      return true;
    }
  }

  const playbackCoordinator = new PlaybackCoordinator();

  class PlaybackBudget {
    constructor(maxPlays, playsUsed = 0) {
      this.maxPlays = Number.isInteger(maxPlays) ? maxPlays : null;
      this.playsUsed = Number.isInteger(playsUsed) && playsUsed >= 0 ? playsUsed : 0;
      this.sessionActive = false;
    }

    get remaining() {
      return this.maxPlays === null ? null : Math.max(0, this.maxPlays - this.playsUsed);
    }

    get exhausted() {
      return this.remaining === 0;
    }

    beginSession() {
      if (this.sessionActive) return true;
      if (this.exhausted) return false;
      this.playsUsed += 1;
      this.sessionActive = true;
      return true;
    }

    endSession() {
      this.sessionActive = false;
    }
  }

  class MediaPlayerController {
    constructor(container, config) {
      this.$container = $(container);
      this.config = config;
      this.$media = this.$container.find('audio, video').first();
      this.media = this.$media[0];
      this.$controls = this.$container.find('.pl-media-player-controls').first();
      this.$playLock = this.$container.find('.pl-media-player-play-lock').first();
      this.$playButton = this.$container.find('.pl-media-player-play').first();
      this.$playTooltip = this.$container.find('.pl-media-player-play-tooltip').first();
      this.$seekLock = this.$container.find('.pl-media-player-seek-lock').first();
      this.$seek = this.$container.find('.pl-media-player-seek').first();
      this.$seekTooltip = this.$container.find('.pl-media-player-seek-tooltip').first();
      this.$time = this.$container.find('.pl-media-player-time').first();
      this.$audioButtons = this.$container.find('.pl-media-player-audio-buttons').first();
      this.$testSoundControl = this.$container
        .find('.pl-media-player-test-sound-control')
        .first();
      this.$testSoundButton = this.$container.find('.pl-media-player-test-sound').first();
      this.$muteLock = this.$container.find('.pl-media-player-mute-lock').first();
      this.$muteButton = this.$container.find('.pl-media-player-mute').first();
      this.$muteTooltip = this.$container.find('.pl-media-player-mute-tooltip').first();
      this.$volume = this.$container.find('.pl-media-player-volume').first();
      this.$playbackCount = this.$container.find('.pl-media-player-playback-count').first();
      this.$playbackWarning = this.$container.find('.pl-media-player-playback-warning').first();
      this.$remaining = this.$container.find('.pl-media-player-remaining').first();
      this.$status = this.$container.find('.pl-media-player-status').first();
      this.storage = this.#browserStorage();
      this.playbackStorageKey = `pl-media-player:v2:${pageInstanceId(config.variantId)}:${config.playerId}`;
      this.volumePreferenceManager = volumePreferenceManager(this.storage);
      this.lastAllowedTime = 0;
      this.lastAudibleVolume = 1;
      this.lastAppliedVolume = null;
      this.lastAppliedMuted = null;
      this.internalPause = false;
      this.internalSeek = false;
      this.loading = Boolean(config.externalAudio && this.media?.readyState < 1);
      this.testSoundPlaying = false;

      const submitted = Number(this.$playbackCount.val());
      const submittedPlays = Number.isInteger(submitted) && submitted >= 0 ? submitted : 0;
      const persistedPlays = this.#readPersistedPlays();
      this.budget = new PlaybackBudget(config.maxPlays, Math.max(submittedPlays, persistedPlays));
      this.$playbackCount.val(String(this.budget.playsUsed));
      // A submitted input can be newer than local storage, for example when storage was
      // previously unavailable. Keep both recovery paths at the highest observed count.
      if (submittedPlays > persistedPlays) this.#persist();

      if (!this.media) return;
      this.media.controls = false;
      this.$controls.prop('hidden', false);
      this.lastAudibleVolume = isAudibleVolume(this.media.volume) ? this.media.volume : 1;
      this.volumePreferenceManager.register(this);
      if (!this.config.allowMuting && !this.volumePreferenceManager.preference) {
        this.applyVolumePreference(
          { volume: this.lastAudibleVolume, lastAudibleVolume: this.lastAudibleVolume },
          true,
        );
      } else if (this.lastAppliedVolume === null) {
        this.lastAppliedVolume = this.media.volume;
        this.lastAppliedMuted = this.media.muted;
      }
      this.#bind();
      playbackCoordinator.register(this);
      this.#renderState();
    }

    #browserStorage() {
      try {
        return localStorage;
      } catch {
        return null;
      }
    }

    #readPersistedPlays() {
      if (!this.storage) return 0;
      try {
        const value = JSON.parse(this.storage.getItem(this.playbackStorageKey));
        return Number.isInteger(value?.playsUsed) && value.playsUsed >= 0 ? value.playsUsed : 0;
      } catch {
        return 0;
      }
    }

    #persist() {
      this.$playbackCount.val(String(this.budget.playsUsed));
      if (!this.storage) return;
      try {
        this.storage.setItem(
          this.playbackStorageKey,
          JSON.stringify({ playsUsed: this.budget.playsUsed }),
        );
      } catch {
        // Storage can be disabled, full, or blocked by browser privacy settings.
      }
    }

    #setUnloadDirty(dirty) {
      if (this.budget.maxPlays === null) return;
      // PrairieLearn excludes marked inputs from its beforeunload form comparison.
      if (dirty) this.$playbackCount.removeAttr('data-skip-unload-check');
      else this.$playbackCount.attr('data-skip-unload-check', 'true');
    }

    #bind() {
      this.$media.on({
        loadstart: () => this.#setLoading(true),
        play: () => this.#onPlay(),
        playing: () => this.#onPlaying(),
        pause: () => this.#onPause(),
        ended: () => this.#onEnded(),
        loadedmetadata: () => this.#setLoading(false),
        canplay: () => this.#setLoading(false),
        waiting: () => this.#setLoading(true),
        durationchange: () => this.#renderProgress(),
        timeupdate: () => this.#onTimeUpdate(),
        seeking: () => this.#onSeeking(),
        volumechange: () => this.#onVolumeChange(),
        error: () => this.#onError(),
      });
      this.$playButton.on('click', () => this.#togglePlayback());
      this.$seek.on('input', () => this.#onSeekInput());
      this.$testSoundButton.on('click', () => this.#playTestSound());
      this.$muteButton.on('click', () => this.#toggleMuted());
      this.$volume.on('input', () => this.#onVolumeInput());
      this.#bindLockout(this.$playLock);
      this.#bindLockout(this.$seekLock);
      this.#bindLockout(this.$muteLock);
    }

    applyVolumePreference(preference, initialize) {
      if (!this.media) return;
      this.lastAudibleVolume = preference.lastAudibleVolume;
      const volume =
        this.config.allowMuting || preference.volume > 0
          ? preference.volume
          : preference.lastAudibleVolume;
      if (this.media.volume !== volume) this.media.volume = volume;
      if ((!this.config.allowMuting || initialize) && this.media.muted) {
        this.media.muted = false;
      }
      this.lastAppliedVolume = volume;
      this.lastAppliedMuted = this.media.muted;
    }

    pauseForAnotherPlayer() {
      this.media.pause();
    }

    #setStatus(message) {
      this.$status.text(message);
    }

    #setLoading(loading) {
      if (!this.config.externalAudio || this.loading === loading) {
        if (!loading) this.#renderProgress();
        return;
      }
      this.loading = loading;
      this.#renderState();
    }

    #bindLockout($lock) {
      const warn = (event) => {
        if ($lock.attr('data-locked') !== 'true') return;
        event.preventDefault();
        event.stopPropagation();
        this.#showLockout($lock);
      };
      $lock.on('click', warn);
      $lock.on('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') warn(event);
      });
      $lock.on('blur mouseleave', () => $lock.attr('data-show-tooltip', 'false'));
    }

    #showLockout($lock) {
      const message = $lock.attr('data-lockout-message');
      if (!message) return;
      this.#setStatus(message === this.$remaining.text() ? '' : message);
      $lock.attr('data-show-tooltip', 'true');
    }

    #setLockedControl($lock, $control, $tooltip, locked, message, label) {
      $control.prop('disabled', locked);
      $lock.attr('data-locked', String(locked));
      $lock.attr('data-lockout-message', locked ? message : '');
      $lock.attr('tabindex', locked ? '0' : '-1');
      $lock.attr('aria-disabled', String(locked));
      if (locked) $lock.attr('aria-label', `${label}. ${message}`);
      else $lock.removeAttr('aria-label');
      $lock.attr('data-show-tooltip', 'false');
      $tooltip.text(locked ? message : '');
    }

    #formatTime(value) {
      if (!Number.isFinite(value) || value < 0) return '0:00';
      const seconds = Math.floor(value % 60)
        .toString()
        .padStart(2, '0');
      const totalMinutes = Math.floor(value / 60);
      if (totalMinutes < 60) return `${totalMinutes}:${seconds}`;
      return `${Math.floor(totalMinutes / 60)}:${String(totalMinutes % 60).padStart(2, '0')}:${seconds}`;
    }

    #renderProgress() {
      const duration = Number.isFinite(this.media.duration) ? this.media.duration : 0;
      const currentTime = Number.isFinite(this.media.currentTime) ? this.media.currentTime : 0;
      this.$seek.attr('max', String(duration));
      this.$seek.val(String(Math.min(currentTime, duration)));
      this.$time.text(`${this.#formatTime(currentTime)} / ${this.#formatTime(duration)}`);
    }

    #renderControls(inactiveAndExhausted) {
      const isPlaying = this.media.paused === false && !this.media.ended;
      const playLabel = isPlaying ? 'Pause' : 'Play';
      const playLocked = inactiveAndExhausted || (isPlaying && !this.config.allowPause);
      const finalUnpausableAttempt =
        !isPlaying &&
        !inactiveAndExhausted &&
        !this.config.allowPause &&
        this.budget.remaining === 1;
      const playMessage = inactiveAndExhausted ? 'No plays left.' : 'Pausing disabled.';
      this.$playButton
        .attr('data-icon', this.loading ? 'loading' : isPlaying ? 'pause' : 'play')
        .attr('aria-label', playLabel)
        .attr('aria-busy', String(this.loading));
      this.$playButton.attr('data-warning', String(finalUnpausableAttempt));
      this.$playButton.toggleClass('btn-danger', finalUnpausableAttempt);
      this.$playButton.toggleClass('btn-outline-secondary', !finalUnpausableAttempt);
      this.#setLockedControl(
        this.$playLock,
        this.$playButton,
        this.$playTooltip,
        playLocked,
        playMessage,
        playLabel,
      );

      this.#setLockedControl(
        this.$seekLock,
        this.$seek,
        this.$seekTooltip,
        !this.config.allowSeeking,
        'Seeking disabled.',
        'Seek',
      );

      const muted = this.media.muted || this.media.volume === 0;
      const muteLabel = muted ? 'Unmute' : 'Mute';
      this.$muteButton.attr('data-icon', muted ? 'muted' : 'volume').attr('aria-label', muteLabel);
      this.$volume.attr('data-muted', String(muted));
      this.#setLockedControl(
        this.$muteLock,
        this.$muteButton,
        this.$muteTooltip,
        !this.config.allowMuting,
        'Muting disabled.',
        muteLabel,
      );
      this.$volume.attr('min', this.config.allowMuting ? '0' : '0.01');
      this.$volume.val(String(this.media.volume));
      this.#renderProgress();
    }

    #renderState() {
      if (this.config.showRemaining) {
        const remaining = this.budget.remaining;
        this.$remaining.prop('hidden', remaining === null);
        this.$remaining.toggleClass('text-danger', remaining === 1);
        this.$remaining.toggleClass('text-muted', remaining !== 1);
        this.$remaining.text(
          remaining === null
            ? ''
            : remaining === 0
              ? 'No plays left.'
              : `${remaining} ${remaining === 1 ? 'play' : 'plays'} left.`,
        );
      }
      const inactiveAndExhausted = this.budget.exhausted && !this.budget.sessionActive;
      this.$container.attr('data-exhausted', String(inactiveAndExhausted));
      this.$media.attr('aria-disabled', String(inactiveAndExhausted));
      this.#renderControls(inactiveAndExhausted);
      const finalUnpausableAttempt =
        this.media.paused !== false &&
        !inactiveAndExhausted &&
        !this.config.allowPause &&
        this.budget.remaining === 1;
      this.$playbackWarning.prop('hidden', !finalUnpausableAttempt);
      this.$playbackWarning.text(finalUnpausableAttempt ? 'Final play; pausing disabled.' : '');
    }

    #togglePlayback() {
      if (!this.media.paused && !this.media.ended) {
        if (!this.config.allowPause) {
          this.#showLockout(this.$playLock);
          return;
        }
        this.media.pause();
        return;
      }

      if (this.budget.exhausted && !this.budget.sessionActive) {
        this.#showLockout(this.$playLock);
        return;
      }
      if (!playbackCoordinator.requestPlayback(this)) {
        this.#setStatus(PLAYBACK_CONFLICT_MESSAGE);
        this.#renderState();
        return;
      }
      this.#setLoading(true);
      const started = this.media.play();
      if (started && typeof started.catch === 'function') {
        started.catch(() => {
          this.#setLoading(false);
          this.#setStatus('Could not start playback.');
          this.#renderState();
        });
      }
    }

    #onSeekInput() {
      if (!this.config.allowSeeking) {
        this.#showLockout(this.$seekLock);
        return;
      }
      const nextTime = Number(this.$seek.val());
      if (Number.isFinite(nextTime)) this.media.currentTime = nextTime;
    }

    async #playTestSound() {
      if (this.testSoundPlaying) return;
      const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!AudioContextClass) {
        this.#hideTestSound('pl-media-player test sound is not supported in this browser.');
        return;
      }

      this.testSoundPlaying = true;
      this.$testSoundButton.prop('disabled', true);
      let oscillator = null;
      let gain = null;
      try {
        if (!testSoundAudioContext || testSoundAudioContext.state === 'closed') {
          testSoundAudioContext = new AudioContextClass();
        }
        if (testSoundAudioContext.state === 'suspended') {
          await testSoundAudioContext.resume();
        }

        oscillator = testSoundAudioContext.createOscillator();
        gain = testSoundAudioContext.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = 440;
        oscillator.connect(gain);
        gain.connect(testSoundAudioContext.destination);

        const volume = this.media.muted ? 0 : this.media.volume;
        const startTime = testSoundAudioContext.currentTime;
        for (const [index, level] of TEST_TONE_LEVELS.entries()) {
          const toneStart = startTime + index * (TEST_TONE_DURATION + TEST_TONE_GAP);
          const toneEnd = toneStart + TEST_TONE_DURATION;
          const toneVolume = level * volume;
          gain.gain.setValueAtTime(0, toneStart);
          gain.gain.linearRampToValueAtTime(toneVolume, toneStart + 0.015);
          gain.gain.setValueAtTime(toneVolume, toneEnd - 0.03);
          gain.gain.linearRampToValueAtTime(0, toneEnd);
        }

        oscillator.onended = () => {
          oscillator.disconnect();
          gain.disconnect();
          this.testSoundPlaying = false;
          this.$testSoundButton.prop('disabled', false);
        };
        oscillator.start(startTime);
        oscillator.stop(
          startTime +
            TEST_TONE_LEVELS.length * TEST_TONE_DURATION +
            (TEST_TONE_LEVELS.length - 1) * TEST_TONE_GAP,
        );
      } catch (error) {
        oscillator?.disconnect();
        gain?.disconnect();
        this.#hideTestSound('pl-media-player could not play the test sound.', error);
      }
    }

    #hideTestSound(message, error) {
      this.testSoundPlaying = false;
      this.$testSoundButton.prop('disabled', false);
      this.$testSoundControl.prop('hidden', true);
      this.$audioButtons.attr('data-test-sound-unavailable', 'true');
      if (error) console.error(message, error);
      else console.error(message);
    }

    #toggleMuted() {
      if (!this.config.allowMuting) {
        this.#showLockout(this.$muteLock);
        return;
      }
      const unmute = this.media.muted || this.media.volume === 0;
      if (unmute && this.media.volume === 0) {
        this.media.volume = this.lastAudibleVolume;
      }
      this.media.muted = !unmute;
    }

    #onVolumeInput() {
      const nextVolume = Number(this.$volume.val());
      if (!isVolume(nextVolume)) return;
      if (!this.config.allowMuting && nextVolume === 0) {
        this.#showLockout(this.$muteLock);
        this.$volume.val(String(this.media.volume));
        return;
      }
      this.media.volume = nextVolume;
      this.media.muted = nextVolume === 0;
    }

    #denyPlayback(message = this.config.showRemaining ? '' : 'No plays left.') {
      this.internalPause = true;
      this.media.pause();
      this.#setStatus(message);
      this.#renderState();
    }

    #onPlay() {
      if (!this.budget.sessionActive && this.budget.exhausted) {
        this.#denyPlayback();
        return;
      }
      if (!playbackCoordinator.requestPlayback(this)) {
        this.#denyPlayback(PLAYBACK_CONFLICT_MESSAGE);
        return;
      }
      this.#setLoading(true);
      this.#renderState();
    }

    #onPlaying() {
      this.#setLoading(false);
      if (!this.budget.sessionActive) {
        if (!this.budget.beginSession()) {
          this.#denyPlayback();
          return;
        }
        this.#persist();
      }
      this.#setUnloadDirty(true);
      this.#setStatus('');
      this.#renderState();
    }

    #onPause() {
      this.#setLoading(false);
      if (this.internalPause) {
        this.internalPause = false;
        this.#renderState();
        return;
      }
      if (this.media.ended || !this.budget.sessionActive || this.config.allowPause) {
        this.#renderState();
        return;
      }
      this.#setStatus('Pausing disabled.');
      const resumed = this.media.play();
      if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {});
      this.#renderState();
    }

    #onEnded() {
      this.#setLoading(false);
      this.budget.endSession();
      this.#setUnloadDirty(false);
      this.lastAllowedTime = 0;
      this.#setStatus('');
      this.#renderState();
    }

    #onTimeUpdate() {
      if (!this.media.seeking) this.lastAllowedTime = this.media.currentTime;
      this.#renderProgress();
    }

    #onSeeking() {
      if (this.config.allowSeeking || this.internalSeek) return;
      if (Math.abs(this.media.currentTime - this.lastAllowedTime) < 0.25) return;
      this.internalSeek = true;
      this.media.currentTime = this.lastAllowedTime;
      this.internalSeek = false;
      this.#setStatus('Seeking disabled.');
      this.#renderProgress();
    }

    #onVolumeChange() {
      if (!this.config.allowMuting && (this.media.muted || this.media.volume === 0)) {
        const preference = this.volumePreferenceManager.preference ?? {
          volume: this.lastAudibleVolume,
          lastAudibleVolume: this.lastAudibleVolume,
        };
        this.applyVolumePreference(preference, false);
        this.#setStatus('Muting disabled.');
        this.#renderState();
        return;
      }

      if (
        this.media.volume === this.lastAppliedVolume &&
        this.media.muted === this.lastAppliedMuted
      ) {
        return;
      }

      if (this.media.volume === this.lastAppliedVolume) {
        // Muting is intentionally local to this player and is never cached or synchronized.
        this.lastAppliedMuted = this.media.muted;
        this.#renderState();
        return;
      }

      this.lastAppliedVolume = this.media.volume;
      this.lastAppliedMuted = this.media.muted;
      this.volumePreferenceManager.update(this.media.volume);
      this.#renderState();
    }

    #onError() {
      this.#setLoading(false);
      if (!this.budget.sessionActive) {
        this.#setStatus('Media failed to load; play not used.');
      } else {
        this.#setStatus('Media stopped unexpectedly.');
      }
      this.#renderState();
    }
  }

  // initialize on load
  $(() => {
    bindPageInstanceReset();
    $('[data-pl-media-player-config]').each((_index, container) => {
      const $container = $(container);
      if ($container.data('pl-media-player-initialized')) return;
      try {
        const config = JSON.parse($container.attr('data-pl-media-player-config'));
        new MediaPlayerController(container, config);
        $container.data('pl-media-player-initialized', true);
      } catch (error) {
        $container.find('.pl-media-player-status').first().text('Player failed to load.');
        console.error('pl-media-player initialization failed', error);
      }
    });
  });
})(jQuery);
