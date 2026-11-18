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
        timeupdate: () => this.#onTimeUpdate(),
        seeking: () => this.#onSeeking(),
        volumechange: () => this.#onVolumeChange(),
        error: () => this.#onError(),
      });
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

    #renderState() {
      if (this.config.showRemaining) {
        const remaining = this.budget.remaining;
        this.$remaining.text(
          remaining === null
            ? 'Unlimited playback attempts.'
            : `${remaining} playback ${remaining === 1 ? 'attempt' : 'attempts'} remaining.`,
        );
      }
      const inactiveAndExhausted = this.budget.exhausted && !this.budget.sessionActive;
      this.$container.attr('data-exhausted', String(inactiveAndExhausted));
      this.$media.attr('aria-disabled', String(inactiveAndExhausted));
    }

    #denyPlayback() {
      this.internalPause = true;
      this.media.pause();
      this.internalPause = false;
      this.#setStatus('Playback limit reached. No attempts remain.');
      this.#renderState();
    }

    #onPlay() {
      if (!this.budget.sessionActive && this.budget.exhausted) this.#denyPlayback();
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
        return;
      }
      this.#setStatus('Pausing is disabled for this playback.');
      const resumed = this.media.play();
      if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {});
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
    }

    #onSeeking() {
      if (this.config.allowSeeking || this.internalSeek) return;
      if (Math.abs(this.media.currentTime - this.lastAllowedTime) < 0.25) return;
      this.internalSeek = true;
      this.media.currentTime = this.lastAllowedTime;
      this.internalSeek = false;
      this.#setStatus('Seeking is disabled for this playback.');
    }

    #onVolumeChange() {
      if (!this.config.allowMuting && (this.media.muted || this.media.volume === 0)) {
        const preference = this.volumePreferenceManager.preference ?? {
          volume: this.lastAudibleVolume,
          lastAudibleVolume: this.lastAudibleVolume,
        };
        this.applyVolumePreference(preference, false);
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
        return;
      }

      this.lastAppliedVolume = this.media.volume;
      this.lastAppliedMuted = this.media.muted;
      this.volumePreferenceManager.update(this.media.volume);
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
