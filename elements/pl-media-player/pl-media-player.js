(() => {
  'use strict';

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
    constructor(container, config, options = {}) {
      this.container = container;
      this.config = config;
      this.media = container.querySelector('audio, video');
      this.remainingElement = container.querySelector('.pl-media-player-remaining');
      this.statusElement = container.querySelector('.pl-media-player-status');
      this.storage = options.storage ?? this.#browserStorage();
      this.storageKey = `pl-media-player:v1:${config.variantId}:${config.playerId}`;
      this.lastAllowedTime = 0;
      this.internalPause = false;
      this.internalSeek = false;

      const persisted = config.persist ? this.#readPersistedPlays() : 0;
      this.budget = new PlaybackBudget(config.maxPlays, persisted);

      if (!this.media) return;
      this.#bind();
      this.#renderState();
    }

    #browserStorage() {
      if (!this.config.persist) return null;
      try {
        return globalThis.localStorage ?? null;
      } catch {
        return null;
      }
    }

    #readPersistedPlays() {
      if (!this.storage) return 0;
      try {
        const value = JSON.parse(this.storage.getItem(this.storageKey));
        return Number.isInteger(value?.playsUsed) && value.playsUsed >= 0 ? value.playsUsed : 0;
      } catch {
        return 0;
      }
    }

    #persist() {
      if (!this.config.persist || !this.storage) return;
      try {
        this.storage.setItem(this.storageKey, JSON.stringify({ playsUsed: this.budget.playsUsed }));
      } catch {
        // Storage can be disabled, full, or blocked by browser privacy settings.
      }
    }

    #bind() {
      this.media.addEventListener('play', () => this.#onPlay());
      this.media.addEventListener('playing', () => this.#onPlaying());
      this.media.addEventListener('pause', () => this.#onPause());
      this.media.addEventListener('ended', () => this.#onEnded());
      this.media.addEventListener('timeupdate', () => this.#onTimeUpdate());
      this.media.addEventListener('seeking', () => this.#onSeeking());
      this.media.addEventListener('error', () => this.#onError());
    }

    #setStatus(message) {
      if (this.statusElement) this.statusElement.textContent = message;
    }

    #renderState() {
      if (this.remainingElement && this.config.showRemaining) {
        const remaining = this.budget.remaining;
        this.remainingElement.textContent =
          remaining === null
            ? 'Unlimited playback attempts.'
            : `${remaining} playback ${remaining === 1 ? 'attempt' : 'attempts'} remaining.`;
      }
      const inactiveAndExhausted = this.budget.exhausted && !this.budget.sessionActive;
      this.container.dataset.exhausted = String(inactiveAndExhausted);
      this.media?.setAttribute('aria-disabled', String(inactiveAndExhausted));
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

    #onError() {
      if (!this.budget.sessionActive) {
        this.#setStatus('The media file could not be loaded. No playback attempt was used.');
      } else {
        this.#setStatus('The media file could not continue playing.');
      }
      this.#renderState();
    }
  }

  function initialize(root = document) {
    for (const container of root.querySelectorAll('[data-pl-media-player-config]')) {
      if (container.dataset.plMediaPlayerInitialized === 'true') continue;
      try {
        const config = JSON.parse(container.dataset.plMediaPlayerConfig);
        new MediaPlayerController(container, config);
        container.dataset.plMediaPlayerInitialized = 'true';
      } catch (error) {
        const status = container.querySelector('.pl-media-player-status');
        if (status) status.textContent = 'The media player could not be initialized.';
        console.error('pl-media-player initialization failed', error);
      }
    }
  }

  globalThis.PLMediaPlayer = { PlaybackBudget, MediaPlayerController, initialize };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => initialize(), { once: true });
    } else {
      initialize();
    }
  }
})();
