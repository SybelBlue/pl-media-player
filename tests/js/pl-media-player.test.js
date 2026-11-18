import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const PLAYER_SOURCE = await readFile(
  new URL('../../elements/pl-media-player/pl-media-player.js', import.meta.url),
  'utf8',
);

class FakeElement {
  constructor() {
    this.textContent = '';
    this.attributes = new Map();
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
}

class FakeMedia extends EventTarget {
  constructor() {
    super();
    this.currentTime = 0;
    this.ended = false;
    this.muted = false;
    this.seeking = false;
    this.volume = 1;
    this.pauseCalls = 0;
    this.playCalls = 0;
    this.attributes = new Map();
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  pause() {
    this.pauseCalls += 1;
  }

  play() {
    this.playCalls += 1;
    return Promise.resolve();
  }

  emit(name) {
    this.dispatchEvent(new Event(name));
  }
}

class FakeContainer extends FakeElement {
  constructor(config) {
    super();
    this.media = new FakeMedia();
    this.remaining = new FakeElement();
    this.status = new FakeElement();
    this.setAttribute('data-pl-media-player-config', JSON.stringify(config));
  }

  find(selector) {
    if (selector === 'audio, video') return [this.media];
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
          if (typeof element.addEventListener === 'function') {
            element.addEventListener(events, handler);
            continue;
          }
          let handlers = objectEventHandlers.get(element);
          if (!handlers) {
            handlers = new Map();
            objectEventHandlers.set(element, handlers);
          }
          const callbacks = handlers.get(events) ?? [];
          callbacks.push(handler);
          handlers.set(events, callbacks);
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

function container(overrides = {}) {
  return new FakeContainer(config(overrides));
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
