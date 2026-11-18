import assert from 'node:assert/strict';
import { test } from 'node:test';

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
    this.seeking = false;
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
  assert.equal(instance.budget.playsUsed, 1);
});
