import assert from 'node:assert/strict';
import { test } from 'node:test';

const jqueryEventHandlers = new WeakMap();

globalThis.jQuery = (target) => ({
  on(events, handler) {
    if (typeof events === 'object') {
      for (const [name, callback] of Object.entries(events)) this.on(name, callback);
      return this;
    }
    if (typeof target.addEventListener === 'function') {
      target.addEventListener(events, handler);
      return this;
    }
    let handlers = jqueryEventHandlers.get(target);
    if (!handlers) {
      handlers = new Map();
      jqueryEventHandlers.set(target, handlers);
    }
    const callbacks = handlers.get(events) ?? [];
    callbacks.push(handler);
    handlers.set(events, callbacks);
    return this;
  },

  trigger(name, parameters = []) {
    const handlers = jqueryEventHandlers.get(target);
    for (const handler of handlers?.get(name) ?? []) {
      handler({ target, type: name }, ...parameters);
    }
    return this;
  },
});

await import('../../elements/pl-media-player/pl-media-player.js');

const { MediaPlayerController } = globalThis.PLMediaPlayer;

class FakeClassList {
  toggle() {}
}

class FakeElement {
  constructor() {
    this.textContent = '';
    this.dataset = {};
    this.attributes = new Map();
    this.classList = new FakeClassList();
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
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

  setAttribute(name, value) {
    this.attributes.set(name, value);
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

class FakeContainer {
  constructor() {
    this.media = new FakeMedia();
    this.remaining = new FakeElement();
    this.status = new FakeElement();
    this.dataset = {};
  }

  querySelector(selector) {
    if (selector === 'audio, video') return this.media;
    if (selector === '.pl-media-player-remaining') return this.remaining;
    if (selector === '.pl-media-player-status') return this.status;
    return null;
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

function controller(overrides = {}, storage = null) {
  const container = new FakeContainer();
  const config = {
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
  const instance = new MediaPlayerController(container, config, { storage });
  return { container, instance };
}

test('initial playback consumes one attempt and pause/resume does not consume another', () => {
  const { container, instance } = controller();

  container.media.emit('playing');
  assert.equal(instance.budget.playsUsed, 1);
  assert.equal(container.remaining.textContent, '1 playback attempt remaining.');

  container.media.emit('pause');
  container.media.emit('playing');
  assert.equal(instance.budget.playsUsed, 1);
});

test('replay consumes another attempt and replay after exhaustion is denied', () => {
  const { container, instance } = controller({ maxPlays: 1 });

  container.media.emit('playing');
  container.media.ended = true;
  container.media.emit('ended');
  container.media.ended = false;
  container.media.emit('play');

  assert.equal(instance.budget.playsUsed, 1);
  assert.equal(container.media.pauseCalls, 1);
  assert.match(container.status.textContent, /limit reached/i);
});

test('disallowed pause is immediately resumed without another attempt', () => {
  const { container, instance } = controller({ allowPause: false });

  container.media.emit('playing');
  container.media.emit('pause');

  assert.equal(container.media.playCalls, 1);
  assert.equal(instance.budget.playsUsed, 1);
});

test('seeking can be prohibited or permitted', () => {
  const prohibited = controller({ allowSeeking: false });
  prohibited.container.media.currentTime = 4;
  prohibited.container.media.emit('timeupdate');
  prohibited.container.media.currentTime = 10;
  prohibited.container.media.emit('seeking');
  assert.equal(prohibited.container.media.currentTime, 4);

  const permitted = controller({ allowSeeking: true });
  permitted.container.media.currentTime = 10;
  permitted.container.media.emit('seeking');
  assert.equal(permitted.container.media.currentTime, 10);
});

test('persisted counts survive reload while a new variant is independent', () => {
  const storage = new MemoryStorage();
  const first = controller({ persist: true, variantId: 'first' }, storage);
  first.container.media.emit('playing');

  const reloaded = controller({ persist: true, variantId: 'first' }, storage);
  assert.equal(reloaded.instance.budget.playsUsed, 1);
  assert.equal(reloaded.instance.budget.sessionActive, false);

  const nextVariant = controller({ persist: true, variantId: 'second' }, storage);
  assert.equal(nextVariant.instance.budget.playsUsed, 0);
});

test('multiple players use independent storage keys', () => {
  const storage = new MemoryStorage();
  const first = controller({ persist: true, playerId: 'first' }, storage);
  const second = controller({ persist: true, playerId: 'second' }, storage);

  first.container.media.emit('playing');

  assert.equal(first.instance.budget.playsUsed, 1);
  assert.equal(second.instance.budget.playsUsed, 0);
  assert.equal(storage.values.size, 1);
});

test('volume is cached across variants without playback persistence', () => {
  const storage = new MemoryStorage();
  const first = controller({ persist: false, variantId: 'first' }, storage);

  first.container.media.volume = 0.35;
  first.container.media.emit('volumechange');

  const next = controller({ persist: false, playerId: 'other', variantId: 'second' }, storage);
  assert.equal(next.container.media.volume, 0.35);
  assert.deepEqual(JSON.parse(storage.getItem('pl-media-player:volume:v1')), {
    volume: 0.35,
    lastAudibleVolume: 0.35,
  });
});

test('volume changes synchronize players already initialized on the page', () => {
  const storage = new MemoryStorage();
  const first = controller({ playerId: 'first' }, storage);
  const second = controller({ playerId: 'second' }, storage);

  first.container.media.volume = 0.6;
  first.container.media.emit('volumechange');

  assert.equal(second.container.media.volume, 0.6);
});

test('restricted players reject mute and zero while preserving the cached preference', () => {
  const storage = new MemoryStorage();
  const unrestricted = controller({ allowMuting: true, playerId: 'unrestricted' }, storage);
  const restricted = controller({ allowMuting: false, playerId: 'restricted' }, storage);

  unrestricted.container.media.volume = 0.4;
  unrestricted.container.media.emit('volumechange');
  unrestricted.container.media.volume = 0;
  unrestricted.container.media.emit('volumechange');

  assert.equal(restricted.container.media.volume, 0.4);
  assert.deepEqual(JSON.parse(storage.getItem('pl-media-player:volume:v1')), {
    volume: 0,
    lastAudibleVolume: 0.4,
  });

  restricted.container.media.muted = true;
  restricted.container.media.emit('volumechange');
  assert.equal(restricted.container.media.muted, false);
  assert.equal(restricted.container.media.volume, 0.4);

  restricted.container.media.volume = 0;
  restricted.container.media.emit('volumechange');
  assert.equal(restricted.container.media.volume, 0.4);

  const futureUnrestricted = controller(
    { allowMuting: true, playerId: 'future-unrestricted' },
    storage,
  );
  const futureRestricted = controller(
    { allowMuting: false, playerId: 'future-restricted' },
    storage,
  );
  assert.equal(futureUnrestricted.container.media.volume, 0);
  assert.equal(futureRestricted.container.media.volume, 0.4);
});

test('mute state is neither cached nor synchronized when muting is allowed', () => {
  const storage = new MemoryStorage();
  const first = controller({ playerId: 'first' }, storage);
  const second = controller({ playerId: 'second' }, storage);

  first.container.media.muted = true;
  first.container.media.emit('volumechange');

  assert.equal(first.container.media.muted, true);
  assert.equal(second.container.media.muted, false);
  assert.equal(storage.getItem('pl-media-player:volume:v1'), null);
});

test('invalid cached volume is ignored and a missing audible value is repaired', () => {
  const invalidStorage = new MemoryStorage();
  invalidStorage.setItem(
    'pl-media-player:volume:v1',
    JSON.stringify({ volume: 2, lastAudibleVolume: 0.5 }),
  );
  const invalid = controller({}, invalidStorage);
  assert.equal(invalid.container.media.volume, 1);

  const zeroStorage = new MemoryStorage();
  zeroStorage.setItem('pl-media-player:volume:v1', JSON.stringify({ volume: 0 }));
  const restricted = controller({ allowMuting: false }, zeroStorage);
  assert.equal(restricted.container.media.volume, 1);
});

test('a loading failure before playing consumes no attempt', () => {
  const { container, instance } = controller();
  container.media.emit('error');

  assert.equal(instance.budget.playsUsed, 0);
  assert.match(container.status.textContent, /no playback attempt was used/i);
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
  const { container, instance } = controller({ persist: true }, storage);

  assert.doesNotThrow(() => container.media.emit('playing'));
  container.media.volume = 0.5;
  assert.doesNotThrow(() => container.media.emit('volumechange'));
  assert.equal(instance.budget.playsUsed, 1);
});
