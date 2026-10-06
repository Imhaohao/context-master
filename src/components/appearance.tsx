'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { Field } from './ui';
type Theme = 'dark' | 'light' | 'system';
const key = 'context-master-theme';
let fallbackTheme: Theme = 'dark';
function readTheme(): Theme { try { const value = localStorage.getItem(key); return value === 'light' || value === 'system' ? value : 'dark'; } catch { return fallbackTheme; } }
function applyTheme() {
  const preference = readTheme();
  const theme = preference === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : preference;
  document.documentElement.dataset.changingTheme = 'true';
  document.documentElement.dataset.theme = theme;
  void document.documentElement.offsetHeight;
  requestAnimationFrame(() => delete document.documentElement.dataset.changingTheme);
}
function subscribe(callback: () => void) {
  const update = () => { applyTheme(); callback(); };
  const media = matchMedia('(prefers-color-scheme: light)');
  window.addEventListener('storage', update); window.addEventListener('context-master-theme', update); media.addEventListener('change', update);
  return () => { window.removeEventListener('storage', update); window.removeEventListener('context-master-theme', update); media.removeEventListener('change', update); };
}
export function useAppearance() {
  const theme = useSyncExternalStore(subscribe, readTheme, () => 'dark' as Theme);
  useEffect(applyTheme, []);
  function change(value: Theme) { fallbackTheme = value; try { localStorage.setItem(key, value); } catch { /* Retain the preference for this window when storage is unavailable. */ } window.dispatchEvent(new Event('context-master-theme')); }
  return { theme, change };
}
export function AppearanceControl() {
  const { theme, change } = useAppearance();
  return <Field label="Color theme"><select value={theme} onChange={event => change(event.target.value as Theme)}><option value="dark">Dark</option><option value="light">Light</option><option value="system">Follow system</option></select></Field>;
}
