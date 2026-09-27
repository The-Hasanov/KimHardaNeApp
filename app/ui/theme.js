import { useSyncExternalStore } from 'react';

const THEME_STORAGE_KEY = 'theme';
const systemPrefersDark = matchMedia('(prefers-color-scheme: dark)');
const themeListeners = new Set();

const chosenTheme = () => localStorage.getItem(THEME_STORAGE_KEY);
export const isNightMode = () => (chosenTheme() ?? (systemPrefersDark.matches ? 'dark' : 'light')) === 'dark';

export function applyTheme() {
  document.documentElement.classList.toggle('dark', isNightMode());
  themeListeners.forEach(notify => notify());
}

export function setNightMode(isOn) {
  localStorage.setItem(THEME_STORAGE_KEY, isOn ? 'dark' : 'light');
  applyTheme();
}

function subscribeToTheme(listener) {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

export const useNightMode = () => useSyncExternalStore(subscribeToTheme, isNightMode);

systemPrefersDark.addEventListener('change', applyTheme);
