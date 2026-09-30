'use strict';
const crypto = require('node:crypto');

const PIN_PATTERN = /^\d{4}$/;
const DEFAULT_PREFERENCES = { showReactions: true, sound: true };
const PREFERENCE_NAMES = Object.keys(DEFAULT_PREFERENCES);
const MAX_PIN_TRIES = 5;
const PIN_LOCK_MS = 60000;

const nameKeyOf = name => String(name ?? '').toLowerCase();
const hashPin = (pin, salt) => crypto.scryptSync(pin, salt, 32).toString('hex');
const isPin = pin => typeof pin === 'string' && PIN_PATTERN.test(pin);

function cleanPreferences(preferences) {
  const clean = {};
  for (const name of PREFERENCE_NAMES) if (typeof preferences?.[name] === 'boolean') clean[name] = preferences[name];
  return clean;
}

function memoryProfileStorage() {
  const profiles = new Map();
  return {
    get: key => (profiles.has(key) ? { ...profiles.get(key) } : null),
    save: profile => void profiles.set(profile.key, { ...profile }),
  };
}

class ProfileError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    Object.assign(this, details);
  }
}

class PlayerProfiles {
  constructor(storage = memoryProfileStorage(), { now = () => Date.now() } = {}) {
    this.storage = storage;
    this.now = now;
    this.pinTries = new Map();
  }

  find(name) {
    return this.storage.get(nameKeyOf(name));
  }

  hasPin(name) {
    return !!this.find(name)?.pinHash;
  }

  preferencesOf(name) {
    return { ...DEFAULT_PREFERENCES, ...cleanPreferences(this.find(name)?.preferences) };
  }

  nameOf(name) {
    return this.find(name)?.name ?? name;
  }

  ensure(name, { preferences, isRenamed = false } = {}) {
    const existing = this.find(name);
    const profile = existing ?? { key: nameKeyOf(name), name, pinHash: null, pinSalt: null, preferences: cleanPreferences(preferences) };
    this.storage.save({ ...profile, name: isRenamed ? name : profile.name });
    return this.find(name);
  }

  unlock(name, pin) {
    const profile = this.find(name);
    if (!profile?.pinHash) return;
    const key = profile.key;
    const tries = this.pinTries.get(key) ?? { failed: 0, lockedUntil: 0 };
    const secondsLocked = Math.ceil((tries.lockedUntil - this.now()) / 1000);
    if (secondsLocked > 0) throw new ProfileError(429, `Too many wrong PINs. Try again in ${secondsLocked} s`, { needsPin: true });
    if (pin == null || pin === '') throw new ProfileError(403, 'This name has a PIN. Type it to continue.', { needsPin: true });
    const given = Buffer.from(isPin(pin) ? hashPin(pin, profile.pinSalt) : '', 'hex');
    const expected = Buffer.from(profile.pinHash, 'hex');
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
      this.pinTries.delete(key);
      return;
    }
    tries.failed += 1;
    if (tries.failed >= MAX_PIN_TRIES) {
      this.pinTries.set(key, { failed: 0, lockedUntil: this.now() + PIN_LOCK_MS });
      throw new ProfileError(429, `Too many wrong PINs. Try again in ${PIN_LOCK_MS / 1000} s`, { needsPin: true });
    }
    this.pinTries.set(key, tries);
    const left = MAX_PIN_TRIES - tries.failed;
    throw new ProfileError(403, `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left`, { needsPin: true });
  }

  setPin(name, pin) {
    if (pin !== null && !isPin(pin)) throw new ProfileError(400, 'A PIN is 4 digits');
    const profile = this.ensure(name);
    const pinSalt = pin === null ? null : crypto.randomBytes(16).toString('hex');
    this.storage.save({ ...profile, pinSalt, pinHash: pin === null ? null : hashPin(pin, pinSalt) });
    this.pinTries.delete(profile.key);
  }

  setPreferences(name, preferences) {
    const profile = this.ensure(name);
    this.storage.save({ ...profile, preferences: { ...cleanPreferences(profile.preferences), ...cleanPreferences(preferences) } });
    return this.preferencesOf(name);
  }
}

module.exports = { PlayerProfiles, ProfileError, memoryProfileStorage, nameKeyOf, DEFAULT_PREFERENCES, MAX_PIN_TRIES, PIN_LOCK_MS };
