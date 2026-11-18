import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const PLAYER_SOURCE = await readFile(
  new URL('../../elements/pl-media-player/pl-media-player.js', import.meta.url),
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
  }

  play() {
    this.playCalls += 1;
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
    this.playbackWarning = new FakeElement();
    this.playbackWarning.hidden = true;
    this.playbackWarning.setAttribute(
      'class',
      'pl-media-player-playback-warning small text-danger mb-1',
    );
    this.remaining = new FakeElement();
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
    allowPause: true,
    allowSeeking: true,
    maxPlays: 2,
    persist: false,
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

function loadPlayers(containers, storage = new MemoryStorage()) {
  const context = {
    console,
    jQuery: createJQuery(containers),
    localStorage: storage,
  };
  vm.runInNewContext(PLAYER_SOURCE, context, { filename: 'pl-media-player.js' });
  return context;
}

function playbackKey(overrides = {}) {
  const playerConfig = config(overrides);
  return `pl-media-player:v1:${playerConfig.variantId}:${playerConfig.playerId}`;
}

test('unlimited playback does not show a remaining-attempt message', () => {
  const player = container({ maxPlays: null });
  loadPlayers([player]);

  assert.equal(player.remaining.textContent, '');
  assert.equal(player.remaining.hidden, true);
});

test('initial playback consumes one attempt and pause/resume does not consume another', () => {
  const player = container();
  loadPlayers([player]);

  player.media.emit('playing');
  assert.equal(player.remaining.textContent, '1 playback attempt remaining.');

  player.media.emit('pause');
  player.media.emit('playing');
  assert.equal(player.remaining.textContent, '1 playback attempt remaining.');
});

test('replay consumes another attempt and replay after exhaustion is denied', () => {
  const player = container({ maxPlays: 1 });
  loadPlayers([player]);

  player.media.emit('playing');
  player.media.ended = true;
  player.media.emit('ended');
  player.media.ended = false;
  player.media.emit('play');

  assert.equal(player.remaining.textContent, '0 playback attempts remaining.');
  assert.equal(player.media.pauseCalls, 1);
  assert.match(player.status.textContent, /limit reached/i);
});

test('disallowed pause is immediately resumed without another attempt', () => {
  const player = container({ allowPause: false });
  loadPlayers([player]);

  player.media.emit('playing');
  player.media.emit('pause');

  assert.equal(player.media.playCalls, 1);
  assert.equal(player.remaining.textContent, '1 playback attempt remaining.');
});

test('a prohibited pause disables the button and explains the lockout when pressed', () => {
  const player = container({ allowPause: false });
  loadPlayers([player]);

  assert.equal(player.media.controls, false);
  assert.equal(player.controls.hidden, false);
  assert.equal(player.playButton.disabled, false);
  assert.equal(player.playButton.textContent, 'Play');

  player.media.emit('playing');

  assert.equal(player.playButton.disabled, true);
  assert.equal(player.playButton.textContent, 'Pause');
  assert.equal(player.playLock.getAttribute('data-locked'), 'true');
  assert.equal(player.playLock.getAttribute('tabindex'), '0');
  assert.match(player.playTooltip.textContent, /pausing is disabled/i);

  player.playLock.emit('click');

  assert.match(player.status.textContent, /pausing is disabled/i);
  assert.equal(player.playLock.getAttribute('data-show-tooltip'), 'true');
  assert.equal(player.media.pauseCalls, 0);
});

test('a final unpausable attempt is red and warned about before playback', () => {
  const player = container({ allowPause: false, maxPlays: 1 });
  loadPlayers([player]);

  assert.equal(player.playButton.disabled, false);
  assert.equal(player.playButton.textContent, 'Play');
  assert.equal(player.playButton.getAttribute('data-warning'), 'true');
  assert.match(player.playButton.getAttribute('class'), /\bbtn-danger\b/);
  assert.doesNotMatch(player.playButton.getAttribute('class'), /\bbtn-outline-secondary\b/);
  assert.equal(player.playbackWarning.hidden, false);
  assert.equal(player.playbackWarning.textContent, 'Playback cannot be stopped once started.');
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
  assert.equal(player.playbackWarning.textContent, 'Playback cannot be stopped once started.');
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

  player.volume.value = '0.3';
  player.volume.emit('input');
  assert.equal(player.media.volume, 0.3);
});

test('locked controls expose warnings to pointer and keyboard users', () => {
  const player = container({ allowMuting: false, allowSeeking: false });
  loadPlayers([player]);

  assert.equal(player.muteButton.disabled, true);
  assert.equal(player.seek.disabled, true);
  assert.match(player.muteTooltip.textContent, /muting is disabled/i);
  assert.match(player.seekTooltip.textContent, /seeking is disabled/i);

  player.muteLock.emit('keydown', { key: 'Enter' });
  assert.match(player.status.textContent, /muting is disabled/i);

  player.seekLock.emit('click');
  assert.match(player.status.textContent, /seeking is disabled/i);
});

test('play is disabled with a warning once all attempts are exhausted', () => {
  const player = container({ maxPlays: 1 });
  loadPlayers([player]);

  player.media.emit('playing');
  player.media.ended = true;
  player.media.emit('ended');

  assert.equal(player.playButton.disabled, true);
  assert.equal(player.playButton.textContent, 'Play');
  assert.match(player.playTooltip.textContent, /limit reached/i);

  player.playLock.emit('click');
  assert.match(player.status.textContent, /limit reached/i);
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

test('persisted counts survive reload while a new variant is independent', () => {
  const storage = new MemoryStorage();
  const first = container({ persist: true, variantId: 'first' });
  loadPlayers([first], storage);
  first.media.emit('playing');

  const reloaded = container({ persist: true, variantId: 'first' });
  loadPlayers([reloaded], storage);
  assert.equal(reloaded.remaining.textContent, '1 playback attempt remaining.');

  const nextVariant = container({ persist: true, variantId: 'second' });
  loadPlayers([nextVariant], storage);
  assert.equal(nextVariant.remaining.textContent, '2 playback attempts remaining.');
});

test('submitted playback count survives Save and Grade without browser persistence', () => {
  const first = container();
  loadPlayers([first]);
  first.media.emit('playing');

  assert.equal(first.playbackCount.value, '1');

  const rerendered = container({}, first.playbackCount.value);
  loadPlayers([rerendered]);

  assert.equal(rerendered.remaining.textContent, '1 playback attempt remaining.');
  rerendered.media.emit('playing');
  assert.equal(rerendered.playbackCount.value, '2');
  assert.equal(rerendered.remaining.textContent, '0 playback attempts remaining.');
});

test('multiple players use independent storage keys', () => {
  const storage = new MemoryStorage();
  const first = container({ persist: true, playerId: 'first' });
  const second = container({ persist: true, playerId: 'second' });
  loadPlayers([first, second], storage);

  first.media.emit('playing');

  assert.equal(first.remaining.textContent, '1 playback attempt remaining.');
  assert.equal(second.remaining.textContent, '2 playback attempts remaining.');
  assert.equal(storage.values.size, 1);
});

test('volume is cached across variants without playback persistence', () => {
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
  const player = container({ persist: true });
  loadPlayers([player], storage);
  player.media.emit('error');

  assert.equal(storage.getItem(playbackKey({ persist: true })), null);
  assert.match(player.status.textContent, /no playback attempt was used/i);
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
  const player = container({ persist: true });
  assert.doesNotThrow(() => loadPlayers([player], storage));

  assert.doesNotThrow(() => player.media.emit('playing'));
  player.media.volume = 0.5;
  assert.doesNotThrow(() => player.media.emit('volumechange'));
  assert.equal(player.remaining.textContent, '1 playback attempt remaining.');
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
