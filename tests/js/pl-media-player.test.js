import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const PLAYER_SOURCE = await readFile(
  new URL('../../elements/pl-media-player/pl-media-player.js', import.meta.url),
  'utf8',
);
const PLAYER_TEMPLATE_SOURCE = await readFile(
  new URL('../../elements/pl-media-player/pl-media-player.mustache', import.meta.url),
  'utf8',
);

class FakeElement extends EventTarget {
  constructor() {
    super();
    this.textContent = '';
    this.attributes = new Map();
    this.disabled = false;
    this.hidden = false;
    this.value = '';
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  emit(name, properties = {}) {
    const event = new Event(name, { cancelable: true });
    for (const [key, value] of Object.entries(properties)) {
      Object.defineProperty(event, key, { value });
    }
    this.dispatchEvent(event);
  }
}

class FakeMedia extends FakeElement {
  constructor() {
    super();
    this.controls = true;
    this.currentTime = 0;
    this.duration = 120;
    this.ended = false;
    this.muted = false;
    this.paused = true;
    this.seeking = false;
    this.volume = 1;
    this.pauseCalls = 0;
    this.playCalls = 0;
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }

  play() {
    this.playCalls += 1;
    this.paused = false;
    return Promise.resolve();
  }

  emit(name, properties = {}) {
    if (name === 'play' || name === 'playing') this.paused = false;
    if (name === 'pause' || name === 'ended') this.paused = true;
    super.emit(name, properties);
  }
}

class FakeContainer extends FakeElement {
  constructor(config) {
    super();
    this.media = new FakeMedia();
    this.controls = new FakeElement();
    this.controls.hidden = true;
    this.playLock = new FakeElement();
    this.playButton = new FakeElement();
    this.playButton.setAttribute('class', 'pl-media-player-play btn btn-outline-secondary btn-sm');
    this.playTooltip = new FakeElement();
    this.seekLock = new FakeElement();
    this.seek = new FakeElement();
    this.seekTooltip = new FakeElement();
    this.time = new FakeElement();
    this.muteLock = new FakeElement();
    this.muteButton = new FakeElement();
    this.muteButton.setAttribute('class', 'pl-media-player-mute btn btn-outline-secondary btn-sm');
    this.muteTooltip = new FakeElement();
    this.volume = new FakeElement();
    this.playbackCount = new FakeElement();
    this.playbackCount.value = '0';
    this.playbackCount.setAttribute('data-skip-unload-check', 'true');
    this.playbackWarning = new FakeElement();
    this.playbackWarning.hidden = true;
    this.playbackWarning.setAttribute('class', 'pl-media-player-playback-warning text-danger');
    this.remaining = new FakeElement();
    this.remaining.setAttribute('class', 'pl-media-player-remaining text-muted');
    this.status = new FakeElement();
    this.setAttribute('data-pl-media-player-config', JSON.stringify(config));
  }

  find(selector) {
    if (selector === 'audio, video') return [this.media];
    if (selector === '.pl-media-player-controls') return [this.controls];
    if (selector === '.pl-media-player-play-lock') return [this.playLock];
    if (selector === '.pl-media-player-play') return [this.playButton];
    if (selector === '.pl-media-player-play-tooltip') return [this.playTooltip];
    if (selector === '.pl-media-player-seek-lock') return [this.seekLock];
    if (selector === '.pl-media-player-seek') return [this.seek];
    if (selector === '.pl-media-player-seek-tooltip') return [this.seekTooltip];
    if (selector === '.pl-media-player-time') return [this.time];
    if (selector === '.pl-media-player-mute-lock') return [this.muteLock];
    if (selector === '.pl-media-player-mute') return [this.muteButton];
    if (selector === '.pl-media-player-mute-tooltip') return [this.muteTooltip];
    if (selector === '.pl-media-player-volume') return [this.volume];
    if (selector === '.pl-media-player-playback-count') return [this.playbackCount];
    if (selector === '.pl-media-player-playback-warning') return [this.playbackWarning];
    if (selector === '.pl-media-player-remaining') return [this.remaining];
    if (selector === '.pl-media-player-status') return [this.status];
    return [];
  }
}

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }
}

class MemoryHistory {
  constructor(state = null) {
    this.state = state;
  }

  replaceState(state) {
    this.state = state;
  }
}

class FakeDocument {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  click(target) {
    for (const listener of this.listeners.get('click') ?? []) listener({ target });
  }
}

function createJQuery(containers) {
  const data = new WeakMap();
  const objectEventHandlers = new WeakMap();

  function collection(elements) {
    const jqueryCollection = {
      length: elements.length,

      attr(name, value) {
        if (value === undefined) return elements[0]?.getAttribute(name);
        for (const element of elements) element.setAttribute(name, value);
        return jqueryCollection;
      },

      removeAttr(name) {
        for (const element of elements) element.removeAttribute(name);
        return jqueryCollection;
      },

      prop(name, value) {
        if (value === undefined) return elements[0]?.[name];
        for (const element of elements) element[name] = value;
        return jqueryCollection;
      },

      val(value) {
        if (value === undefined) return elements[0]?.value;
        for (const element of elements) element.value = String(value);
        return jqueryCollection;
      },

      toggleClass(className, state) {
        for (const element of elements) {
          const classes = new Set(
            (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean),
          );
          if (state) classes.add(className);
          else classes.delete(className);
          element.setAttribute('class', [...classes].join(' '));
        }
        return jqueryCollection;
      },

      data(name, value) {
        if (value === undefined) return data.get(elements[0])?.get(name);
        for (const element of elements) {
          let elementData = data.get(element);
          if (!elementData) {
            elementData = new Map();
            data.set(element, elementData);
          }
          elementData.set(name, value);
        }
        return jqueryCollection;
      },

      each(callback) {
        elements.forEach((element, index) => callback(index, element));
        return jqueryCollection;
      },

      find(selector) {
        return collection(elements.flatMap((element) => element.find?.(selector) ?? []));
      },

      first() {
        return collection(elements.slice(0, 1));
      },

      on(events, handler) {
        if (typeof events === 'object') {
          for (const [name, callback] of Object.entries(events)) {
            jqueryCollection.on(name, callback);
          }
          return jqueryCollection;
        }

        for (const element of elements) {
          for (const eventName of events.split(/\s+/)) {
            if (typeof element.addEventListener === 'function') {
              element.addEventListener(eventName, handler);
              continue;
            }
            let handlers = objectEventHandlers.get(element);
            if (!handlers) {
              handlers = new Map();
              objectEventHandlers.set(element, handlers);
            }
            const callbacks = handlers.get(eventName) ?? [];
            callbacks.push(handler);
            handlers.set(eventName, callbacks);
          }
        }
        return jqueryCollection;
      },

      text(value) {
        if (value === undefined) return elements[0]?.textContent;
        for (const element of elements) element.textContent = value;
        return jqueryCollection;
      },

      trigger(name, parameters = []) {
        for (const element of elements) {
          for (const handler of objectEventHandlers.get(element)?.get(name) ?? []) {
            handler({ target: element, type: name }, ...parameters);
          }
        }
        return jqueryCollection;
      },
    };

    elements.forEach((element, index) => {
      jqueryCollection[index] = element;
    });
    return jqueryCollection;
  }

  return (target) => {
    if (typeof target === 'function') {
      target();
      return collection([]);
    }
    if (target === '[data-pl-media-player-config]') return collection(containers);
    return collection(target == null ? [] : [target]);
  };
}

function config(overrides = {}) {
  return {
    allowMuting: true,
    allowOverlappingPlayback: false,
    allowPause: true,
    allowSeeking: true,
    maxPlays: 2,
    playerId: 'main',
    showRemaining: true,
    variantId: '101',
    ...overrides,
  };
}

function container(overrides = {}, playsUsed = 0) {
  const player = new FakeContainer(config(overrides));
  player.playbackCount.value = String(playsUsed);
  return player;
}

function loadPlayers(
  containers,
  storage = new MemoryStorage(),
  history = new MemoryHistory(),
  document = new FakeDocument(),
) {
  const context = {
    console,
    document,
    history,
    jQuery: createJQuery(containers),
    localStorage: storage,
  };
  vm.runInNewContext(PLAYER_SOURCE, context, { filename: 'pl-media-player.js' });
  return context;
}

function playbackKey(history, overrides = {}) {
  const playerConfig = config(overrides);
  return `pl-media-player:v2:${history.state.plMediaPlayerPageInstanceId}:${playerConfig.playerId}`;
}

test('all lockout popups use Bootstrap utility styling', () => {
  const bootstrapClasses = /bg-dark text-white rounded px-2 py-1 small shadow-sm/g;
  assert.equal(PLAYER_TEMPLATE_SOURCE.match(bootstrapClasses)?.length, 3);
  assert.doesNotMatch(PLAYER_TEMPLATE_SOURCE, /\btooltip fade\b/);
});

test('unlimited playback does not show a remaining-attempt message', () => {
  const player = container({ maxPlays: null });
  loadPlayers([player]);

  assert.equal(player.remaining.textContent, '');
  assert.equal(player.remaining.hidden, true);
});

test('initial playback consumes one attempt and pause/resume does not consume another', () => {
  const player = container();
  loadPlayers([player]);

  assert.match(player.remaining.getAttribute('class'), /\btext-muted\b/);
  assert.doesNotMatch(player.remaining.getAttribute('class'), /\btext-danger\b/);

  player.media.emit('playing');
  assert.equal(player.remaining.textContent, '1 play left.');
  assert.match(player.remaining.getAttribute('class'), /\btext-danger\b/);
  assert.doesNotMatch(player.remaining.getAttribute('class'), /\btext-muted\b/);

  player.media.emit('pause');
  player.media.emit('playing');
  assert.equal(player.remaining.textContent, '1 play left.');
  assert.match(player.remaining.getAttribute('class'), /\btext-danger\b/);
});

test('an active limited playback marks the question dirty until the session ends', () => {
  const player = container();
  loadPlayers([player]);

  assert.equal(player.playbackCount.getAttribute('data-skip-unload-check'), 'true');

  player.media.emit('playing');
  assert.equal(player.playbackCount.getAttribute('data-skip-unload-check'), null);

  player.media.emit('pause');
  assert.equal(player.playbackCount.getAttribute('data-skip-unload-check'), null);

  player.media.ended = true;
  player.media.emit('ended');
  assert.equal(player.playbackCount.getAttribute('data-skip-unload-check'), 'true');
});

test('unlimited playback remains excluded from the unload dirty check', () => {
  const player = container({ maxPlays: null });
  loadPlayers([player]);

  player.media.emit('playing');

  assert.equal(player.playbackCount.getAttribute('data-skip-unload-check'), 'true');
});

test('starting a player pauses other interruptible players by default', () => {
  const first = container({ playerId: 'first' });
  const second = container({ playerId: 'second' });
  loadPlayers([first, second]);

  first.media.emit('playing');
  second.playButton.emit('click');

  assert.equal(first.media.pauseCalls, 1);
  assert.equal(second.media.playCalls, 1);
});

test('an uninterruptible player prevents conflicting playback', () => {
  const first = container({ allowPause: false, playerId: 'first' });
  const second = container({ allowOverlappingPlayback: true, playerId: 'second' });
  loadPlayers([first, second]);

  first.media.emit('playing');
  second.playButton.emit('click');

  assert.equal(first.media.pauseCalls, 0);
  assert.equal(second.media.playCalls, 0);
  assert.equal(
    second.status.textContent,
    'Another media player is playing and cannot be interrupted.',
  );
});

test('a conflicting native play event is stopped before using an attempt', () => {
  const first = container({ allowPause: false, playerId: 'first' });
  const second = container({ playerId: 'second' });
  loadPlayers([first, second]);

  first.media.emit('playing');
  second.media.emit('play');

  assert.equal(first.media.pauseCalls, 0);
  assert.equal(second.media.pauseCalls, 1);
  assert.equal(second.media.paused, true);
  assert.equal(second.playbackCount.value, '0');
  assert.equal(
    second.status.textContent,
    'Another media player is playing and cannot be interrupted.',
  );
});

test('players overlap only when both opt in', () => {
  const first = container({ allowOverlappingPlayback: true, playerId: 'first' });
  const second = container({ allowOverlappingPlayback: true, playerId: 'second' });
  loadPlayers([first, second]);

  first.media.emit('playing');
  second.playButton.emit('click');

  assert.equal(first.media.pauseCalls, 0);
  assert.equal(second.media.playCalls, 1);
});

test('replay consumes another attempt and replay after exhaustion is denied', () => {
  const player = container({ maxPlays: 1 });
  loadPlayers([player]);

  player.media.emit('playing');
  player.media.ended = true;
  player.media.emit('ended');
  player.media.ended = false;
  player.media.emit('play');

  assert.equal(player.remaining.textContent, 'No plays left.');
  assert.equal(player.media.pauseCalls, 1);
  assert.equal(player.status.textContent, '');
});

test('disallowed pause is immediately resumed without another attempt', () => {
  const player = container({ allowPause: false });
  loadPlayers([player]);

  player.media.emit('playing');
  player.media.emit('pause');

  assert.equal(player.media.playCalls, 1);
  assert.equal(player.remaining.textContent, '1 play left.');
});

test('a prohibited pause disables the button and explains the lockout when pressed', () => {
  const player = container({ allowPause: false });
  loadPlayers([player]);

  assert.equal(player.media.controls, false);
  assert.equal(player.controls.hidden, false);
  assert.equal(player.playButton.disabled, false);
  assert.equal(player.playButton.getAttribute('data-icon'), 'play');
  assert.equal(player.playButton.getAttribute('aria-label'), 'Play');

  player.media.emit('playing');

  assert.equal(player.playButton.disabled, true);
  assert.equal(player.playButton.getAttribute('data-icon'), 'pause');
  assert.equal(player.playButton.getAttribute('aria-label'), 'Pause');
  assert.equal(player.playLock.getAttribute('data-locked'), 'true');
  assert.equal(player.playLock.getAttribute('tabindex'), '0');
  assert.equal(player.playTooltip.textContent, 'Pausing disabled.');

  player.playLock.emit('click');

  assert.equal(player.status.textContent, 'Pausing disabled.');
  assert.equal(player.playLock.getAttribute('data-show-tooltip'), 'true');
  assert.equal(player.media.pauseCalls, 0);
});

test('a final unpausable attempt is red and warned about before playback', () => {
  const player = container({ allowPause: false, maxPlays: 1 });
  loadPlayers([player]);

  assert.equal(player.playButton.disabled, false);
  assert.equal(player.playButton.getAttribute('data-icon'), 'play');
  assert.equal(player.playButton.getAttribute('data-warning'), 'true');
  assert.match(player.playButton.getAttribute('class'), /\bbtn-danger\b/);
  assert.doesNotMatch(player.playButton.getAttribute('class'), /\bbtn-outline-secondary\b/);
  assert.equal(player.playbackWarning.hidden, false);
  assert.equal(player.playbackWarning.textContent, 'Final play; pausing disabled.');
  assert.match(player.playbackWarning.getAttribute('class'), /\btext-danger\b/);
  assert.equal(player.status.textContent, '');

  player.media.emit('playing');

  assert.equal(player.playButton.disabled, true);
  assert.equal(player.playButton.getAttribute('data-warning'), 'false');
  assert.doesNotMatch(player.playButton.getAttribute('class'), /\bbtn-danger\b/);
  assert.match(player.playButton.getAttribute('class'), /\bbtn-outline-secondary\b/);
  assert.equal(player.playbackWarning.hidden, true);
  assert.equal(player.playbackWarning.textContent, '');
  assert.equal(player.status.textContent, '');
});

test('the warning appears when a later playback becomes the final unpausable attempt', () => {
  const player = container({ allowPause: false, maxPlays: 2 });
  loadPlayers([player]);

  assert.equal(player.playButton.getAttribute('data-warning'), 'false');
  assert.equal(player.status.textContent, '');

  player.media.emit('playing');
  player.media.ended = true;
  player.media.emit('ended');

  assert.equal(player.playButton.disabled, false);
  assert.equal(player.playButton.getAttribute('data-warning'), 'true');
  assert.equal(player.playbackWarning.hidden, false);
  assert.equal(player.playbackWarning.textContent, 'Final play; pausing disabled.');
  assert.equal(player.status.textContent, '');
});

test('enabled custom controls play, pause, seek, mute, and adjust volume', () => {
  const player = container();
  loadPlayers([player]);

  player.playButton.emit('click');
  assert.equal(player.media.playCalls, 1);

  player.media.emit('playing');
  player.playButton.emit('click');
  assert.equal(player.media.pauseCalls, 1);

  player.seek.value = '42';
  player.seek.emit('input');
  assert.equal(player.media.currentTime, 42);

  player.muteButton.emit('click');
  assert.equal(player.media.muted, true);
  player.media.emit('volumechange');
  assert.equal(player.muteButton.getAttribute('data-icon'), 'muted');
  assert.equal(player.muteButton.getAttribute('aria-label'), 'Unmute');
  assert.equal(player.volume.getAttribute('data-muted'), 'true');
  assert.equal(player.volume.disabled, false);
  player.muteButton.emit('click');
  player.media.emit('volumechange');
  assert.equal(player.media.muted, false);
  assert.equal(player.muteButton.getAttribute('data-icon'), 'volume');
  assert.equal(player.muteButton.getAttribute('aria-label'), 'Mute');
  assert.equal(player.volume.getAttribute('data-muted'), 'false');

  player.volume.value = '0';
  player.volume.emit('input');
  player.media.emit('volumechange');
  assert.equal(player.media.volume, 0);
  assert.equal(player.media.muted, true);
  assert.equal(player.muteButton.getAttribute('data-icon'), 'muted');
  assert.equal(player.muteButton.getAttribute('aria-label'), 'Unmute');
  assert.equal(player.volume.getAttribute('data-muted'), 'true');

  player.volume.value = '0.3';
  player.volume.emit('input');
  player.media.emit('volumechange');
  assert.equal(player.media.volume, 0.3);
  assert.equal(player.media.muted, false);
  assert.equal(player.muteButton.getAttribute('data-icon'), 'volume');
  assert.equal(player.muteButton.getAttribute('aria-label'), 'Mute');
  assert.equal(player.volume.getAttribute('data-muted'), 'false');
});

test('unmuting at zero restores the last audible volume', () => {
  const player = container();
  loadPlayers([player]);

  player.volume.value = '0.4';
  player.volume.emit('input');
  player.media.emit('volumechange');
  player.volume.value = '0';
  player.volume.emit('input');
  player.media.emit('volumechange');

  player.muteButton.emit('click');
  player.media.emit('volumechange');

  assert.equal(player.media.volume, 0.4);
  assert.equal(player.media.muted, false);
  assert.equal(player.muteButton.getAttribute('data-icon'), 'volume');
  assert.equal(player.volume.getAttribute('data-muted'), 'false');
});

test('locked controls expose warnings to pointer and keyboard users', () => {
  const player = container({ allowMuting: false, allowSeeking: false });
  loadPlayers([player]);

  assert.equal(player.muteButton.disabled, true);
  assert.equal(player.seek.disabled, true);
  assert.equal(player.muteTooltip.textContent, 'Muting disabled.');
  assert.equal(player.seekTooltip.textContent, 'Seeking disabled.');

  player.muteLock.emit('keydown', { key: 'Enter' });
  assert.equal(player.status.textContent, 'Muting disabled.');

  player.seekLock.emit('click');
  assert.equal(player.status.textContent, 'Seeking disabled.');
});

test('play is disabled with a warning once all attempts are exhausted', () => {
  const player = container({ maxPlays: 1 });
  loadPlayers([player]);

  player.media.emit('playing');
  player.media.ended = true;
  player.media.emit('ended');

  assert.equal(player.playButton.disabled, true);
  assert.equal(player.playButton.getAttribute('data-icon'), 'play');
  assert.equal(player.playTooltip.textContent, 'No plays left.');

  player.playLock.emit('click');
  assert.equal(player.status.textContent, '');
});

test('exhaustion is announced below the player when the remaining count is hidden', () => {
  const player = container({ maxPlays: 1, showRemaining: false });
  loadPlayers([player]);

  player.media.emit('playing');
  player.media.ended = true;
  player.media.emit('ended');
  player.playLock.emit('click');

  assert.equal(player.remaining.textContent, '');
  assert.equal(player.status.textContent, 'No plays left.');
});

test('seeking can be prohibited or permitted', () => {
  const prohibited = container({ allowSeeking: false, playerId: 'prohibited' });
  const permitted = container({ allowSeeking: true, playerId: 'permitted' });
  loadPlayers([prohibited, permitted]);

  prohibited.media.currentTime = 4;
  prohibited.media.emit('timeupdate');
  prohibited.media.currentTime = 10;
  prohibited.media.emit('seeking');
  assert.equal(prohibited.media.currentTime, 4);

  permitted.media.currentTime = 10;
  permitted.media.emit('seeking');
  assert.equal(permitted.media.currentTime, 10);
});

test('counts survive reload when the host renders a different server variant', () => {
  const storage = new MemoryStorage();
  const history = new MemoryHistory();
  const first = container({ variantId: 'first' });
  loadPlayers([first], storage, history);
  first.media.emit('playing');

  assert.equal(first.playbackCount.value, '1');
  assert.deepEqual(JSON.parse(storage.getItem(playbackKey(history))), {
    playsUsed: 1,
  });

  const reloaded = container({ variantId: 'second' });
  loadPlayers([reloaded], storage, history);
  assert.equal(reloaded.remaining.textContent, '1 play left.');
  assert.equal(reloaded.playbackCount.value, '1');
});

test('PrairieLearn New variant navigation receives an independent playback budget', () => {
  const storage = new MemoryStorage();
  const history = new MemoryHistory();
  const document = new FakeDocument();
  const first = container({ variantId: 'first' });
  loadPlayers([first], storage, history, document);
  first.media.emit('playing');

  const firstPageId = history.state.plMediaPlayerPageInstanceId;
  document.click({
    closest(selector) {
      return selector === '.js-new-variant-button' ? this : null;
    },
  });

  const nextVariant = container({ variantId: 'second' });
  loadPlayers([nextVariant], storage, history);
  assert.equal(nextVariant.remaining.textContent, '2 plays left.');
  assert.notEqual(firstPageId, history.state.plMediaPlayerPageInstanceId);
});

test('submitted playback input seeds and advances browser persistence', () => {
  const storage = new MemoryStorage();
  const history = new MemoryHistory();
  const player = container({}, 1);
  loadPlayers([player], storage, history);

  const key = playbackKey(history);
  assert.deepEqual(JSON.parse(storage.getItem(key)), { playsUsed: 1 });

  player.media.emit('playing');
  assert.equal(player.playbackCount.value, '2');
  assert.deepEqual(JSON.parse(storage.getItem(key)), { playsUsed: 2 });
  assert.equal(player.remaining.textContent, 'No plays left.');
});

test('browser persistence restores a count when the rendered input is stale', () => {
  const storage = new MemoryStorage();
  const history = new MemoryHistory({ plMediaPlayerPageInstanceId: 'existing-page' });
  storage.setItem(playbackKey(history), JSON.stringify({ playsUsed: 1 }));
  const player = container({}, 0);
  loadPlayers([player], storage, history);

  assert.equal(player.playbackCount.value, '1');
  assert.equal(player.remaining.textContent, '1 play left.');
});

test('multiple players use independent storage keys', () => {
  const storage = new MemoryStorage();
  const history = new MemoryHistory();
  const first = container({ playerId: 'first' });
  const second = container({ playerId: 'second' });
  loadPlayers([first, second], storage, history);

  first.media.emit('playing');

  assert.equal(first.remaining.textContent, '1 play left.');
  assert.equal(second.remaining.textContent, '2 plays left.');
  assert.equal(storage.values.size, 1);
});

test('volume is cached across variants independently of playback persistence', () => {
  const storage = new MemoryStorage();
  const first = container({ variantId: 'first' });
  loadPlayers([first], storage);

  first.media.volume = 0.35;
  first.media.emit('volumechange');

  const next = container({ playerId: 'other', variantId: 'second' });
  loadPlayers([next], storage);
  assert.equal(next.media.volume, 0.35);
  assert.deepEqual(JSON.parse(storage.getItem('pl-media-player:volume:v1')), {
    volume: 0.35,
    lastAudibleVolume: 0.35,
  });
});

test('volume changes synchronize players already initialized on the page', () => {
  const first = container({ playerId: 'first' });
  const second = container({ playerId: 'second' });
  loadPlayers([first, second]);

  first.media.volume = 0.6;
  first.media.emit('volumechange');

  assert.equal(second.media.volume, 0.6);
});

test('restricted players reject mute and zero while preserving the cached preference', () => {
  const storage = new MemoryStorage();
  const unrestricted = container({ playerId: 'unrestricted' });
  const restricted = container({ allowMuting: false, playerId: 'restricted' });
  loadPlayers([unrestricted, restricted], storage);

  unrestricted.media.volume = 0.4;
  unrestricted.media.emit('volumechange');
  unrestricted.media.volume = 0;
  unrestricted.media.emit('volumechange');

  assert.equal(restricted.media.volume, 0.4);
  assert.deepEqual(JSON.parse(storage.getItem('pl-media-player:volume:v1')), {
    volume: 0,
    lastAudibleVolume: 0.4,
  });

  restricted.media.muted = true;
  restricted.media.emit('volumechange');
  assert.equal(restricted.media.muted, false);
  assert.equal(restricted.media.volume, 0.4);

  restricted.media.volume = 0;
  restricted.media.emit('volumechange');
  assert.equal(restricted.media.volume, 0.4);

  const futureUnrestricted = container({ playerId: 'future-unrestricted' });
  const futureRestricted = container({ allowMuting: false, playerId: 'future-restricted' });
  loadPlayers([futureUnrestricted, futureRestricted], storage);
  assert.equal(futureUnrestricted.media.volume, 0);
  assert.equal(futureRestricted.media.volume, 0.4);
});

test('mute state is neither cached nor synchronized when muting is allowed', () => {
  const storage = new MemoryStorage();
  const first = container({ playerId: 'first' });
  const second = container({ playerId: 'second' });
  loadPlayers([first, second], storage);

  first.media.muted = true;
  first.media.emit('volumechange');

  assert.equal(first.media.muted, true);
  assert.equal(second.media.muted, false);
  assert.equal(storage.getItem('pl-media-player:volume:v1'), null);
});

test('invalid cached volume is ignored and a missing audible value is repaired', () => {
  const invalidStorage = new MemoryStorage();
  invalidStorage.setItem(
    'pl-media-player:volume:v1',
    JSON.stringify({ volume: 2, lastAudibleVolume: 0.5 }),
  );
  const invalid = container();
  loadPlayers([invalid], invalidStorage);
  assert.equal(invalid.media.volume, 1);

  const zeroStorage = new MemoryStorage();
  zeroStorage.setItem('pl-media-player:volume:v1', JSON.stringify({ volume: 0 }));
  const restricted = container({ allowMuting: false });
  loadPlayers([restricted], zeroStorage);
  assert.equal(restricted.media.volume, 1);
});

test('a loading failure before playing consumes no attempt', () => {
  const storage = new MemoryStorage();
  const history = new MemoryHistory();
  const player = container();
  loadPlayers([player], storage, history);
  player.media.emit('error');

  assert.equal(storage.getItem(playbackKey(history)), null);
  assert.equal(player.status.textContent, 'Media failed to load; play not used.');
});

test('blocked localStorage does not crash playback', () => {
  const storage = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  const player = container();
  assert.doesNotThrow(() => loadPlayers([player], storage));

  assert.doesNotThrow(() => player.media.emit('playing'));
  player.media.volume = 0.5;
  assert.doesNotThrow(() => player.media.emit('volumechange'));
  assert.equal(player.remaining.textContent, '1 play left.');
});

test('the implementation does not publish an application API globally', () => {
  const context = loadPlayers([container()]);

  assert.equal(Object.hasOwn(context, 'PLMediaPlayer'), false);
  assert.equal(Object.hasOwn(context, 'PlaybackBudget'), false);
  assert.equal(Object.hasOwn(context, 'MediaPlayerController'), false);
  assert.equal(Object.hasOwn(context, 'initialize'), false);
});

test('jQuery initialization data prevents duplicate event handlers', () => {
  const player = container({ allowPause: false });
  const context = loadPlayers([player]);
  vm.runInNewContext(PLAYER_SOURCE, context, { filename: 'pl-media-player.js' });

  player.media.emit('playing');
  player.media.emit('pause');

  assert.equal(player.media.playCalls, 1);
});
