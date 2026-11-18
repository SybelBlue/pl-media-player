(($) => {
  'use strict';

  const VOLUME_STORAGE_KEY = 'pl-media-player:volume:v1';
  const volumePreferenceManagers = new WeakMap();
  let transientVolumePreferenceManager = null;

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
      this.$muteLock = this.$container.find('.pl-media-player-mute-lock').first();
      this.$muteButton = this.$container.find('.pl-media-player-mute').first();
      this.$muteTooltip = this.$container.find('.pl-media-player-mute-tooltip').first();
      this.$volume = this.$container.find('.pl-media-player-volume').first();
      this.$remaining = this.$container.find('.pl-media-player-remaining').first();
      this.$status = this.$container.find('.pl-media-player-status').first();
      this.storage = this.#browserStorage();
      this.playbackStorageKey = `pl-media-player:v1:${config.variantId}:${config.playerId}`;
      this.volumePreferenceManager = volumePreferenceManager(this.storage);
      this.lastAllowedTime = 0;
      this.lastAudibleVolume = 1;
      this.lastAppliedVolume = null;
      this.lastAppliedMuted = null;
      this.internalPause = false;
      this.internalSeek = false;

      const persisted = config.persist ? this.#readPersistedPlays() : 0;
      this.budget = new PlaybackBudget(config.maxPlays, persisted);

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
      if (!this.config.persist || !this.storage) return;
      try {
        this.storage.setItem(
          this.playbackStorageKey,
          JSON.stringify({ playsUsed: this.budget.playsUsed }),
        );
      } catch {
        // Storage can be disabled, full, or blocked by browser privacy settings.
      }
    }

    #bind() {
      this.$media.on({
        play: () => this.#onPlay(),
        playing: () => this.#onPlaying(),
        pause: () => this.#onPause(),
        ended: () => this.#onEnded(),
        loadedmetadata: () => this.#renderProgress(),
        durationchange: () => this.#renderProgress(),
        timeupdate: () => this.#onTimeUpdate(),
        seeking: () => this.#onSeeking(),
        volumechange: () => this.#onVolumeChange(),
        error: () => this.#onError(),
      });
      this.$playButton.on('click', () => this.#togglePlayback());
      this.$seek.on('input', () => this.#onSeekInput());
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

    #setStatus(message) {
      this.$status.text(message);
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
      this.#setStatus(message);
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
      const playMessage = inactiveAndExhausted
        ? 'Playback limit reached. No attempts remain.'
        : 'Pausing is disabled for this playback.';
      this.$playButton.text(playLabel).attr('aria-label', playLabel);
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
        'Seeking is disabled for this playback.',
        'Seek',
      );

      const muted = this.media.muted || this.media.volume === 0;
      const muteLabel = muted ? 'Unmute' : 'Mute';
      this.$muteButton.text(muteLabel).attr('aria-label', muteLabel);
      this.#setLockedControl(
        this.$muteLock,
        this.$muteButton,
        this.$muteTooltip,
        !this.config.allowMuting,
        'Muting is disabled for this playback.',
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
        this.$remaining.text(
          remaining === null
            ? ''
            : `${remaining} playback ${remaining === 1 ? 'attempt' : 'attempts'} remaining.`,
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
      if (finalUnpausableAttempt && !this.$status.text()) {
        this.#setStatus('This is your last playback attempt. Once started, it cannot be paused.');
      }
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
      const started = this.media.play();
      if (started && typeof started.catch === 'function') {
        started.catch(() => {
          this.#setStatus('Playback could not be started.');
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

    #toggleMuted() {
      if (!this.config.allowMuting) {
        this.#showLockout(this.$muteLock);
        return;
      }
      this.media.muted = !this.media.muted;
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
    }

    #denyPlayback() {
      this.internalPause = true;
      this.media.pause();
      this.internalPause = false;
      this.#setStatus('Playback limit reached. No attempts remain.');
      this.#renderState();
    }

    #onPlay() {
      if (!this.budget.sessionActive && this.budget.exhausted) {
        this.#denyPlayback();
        return;
      }
      this.#renderState();
    }

    #onPlaying() {
      if (!this.budget.sessionActive) {
        if (!this.budget.beginSession()) {
          this.#denyPlayback();
          return;
        }
        this.#persist();
      }
      this.#setStatus('');
      this.#renderState();
    }

    #onPause() {
      if (
        this.internalPause ||
        this.media.ended ||
        !this.budget.sessionActive ||
        this.config.allowPause
      ) {
        this.#renderState();
        return;
      }
      this.#setStatus('Pausing is disabled for this playback.');
      const resumed = this.media.play();
      if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {});
      this.#renderState();
    }

    #onEnded() {
      this.budget.endSession();
      this.lastAllowedTime = 0;
      if (this.budget.exhausted) {
        this.#setStatus('Playback limit reached. No attempts remain.');
      }
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
      this.#setStatus('Seeking is disabled for this playback.');
      this.#renderProgress();
    }

    #onVolumeChange() {
      if (!this.config.allowMuting && (this.media.muted || this.media.volume === 0)) {
        const preference = this.volumePreferenceManager.preference ?? {
          volume: this.lastAudibleVolume,
          lastAudibleVolume: this.lastAudibleVolume,
        };
        this.applyVolumePreference(preference, false);
        this.#setStatus('Muting is disabled for this playback.');
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
      if (!this.budget.sessionActive) {
        this.#setStatus('The media file could not be loaded. No playback attempt was used.');
      } else {
        this.#setStatus('The media file could not continue playing.');
      }
      this.#renderState();
    }
  }

  // initialize on load
  $(() => {
    $('[data-pl-media-player-config]').each((_index, container) => {
      const $container = $(container);
      if ($container.data('pl-media-player-initialized')) return;
      try {
        const config = JSON.parse($container.attr('data-pl-media-player-config'));
        new MediaPlayerController(container, config);
        $container.data('pl-media-player-initialized', true);
      } catch (error) {
        $container
          .find('.pl-media-player-status')
          .first()
          .text('The media player could not be initialized.');
        console.error('pl-media-player initialization failed', error);
      }
    });
  });
})(jQuery);
