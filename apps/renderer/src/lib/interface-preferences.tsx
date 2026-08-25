import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  defaultInterfacePreferences,
  mergeInterfacePreferences,
  normalizeInterfacePreferences,
  type ContentWidth,
  type InterfacePreferences,
  type InterfacePreferencesPatch,
} from '@openlab/protocol';
import { resolveSemanticPalette } from './semantic-palette.js';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface InterfacePreferencesContextValue {
  preferences: InterfacePreferences;
  saveStatus: SaveStatus;
  saveError: string | undefined;
  restartRequired: boolean;
  update(patch: InterfacePreferencesPatch, options?: { debounced?: boolean }): void;
}

const InterfacePreferencesContext = createContext<InterfacePreferencesContextValue | undefined>(undefined);

const SERIF_STACK = '"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", STSong, SimSun, Georgia, serif';
const SANS_STACK = '"Segoe UI Variable", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", sans-serif';
const MONO_STACK = '"Cascadia Code", "SFMono-Regular", Consolas, monospace';

function cssWidth(value: ContentWidth): string {
  return value === 'unbounded' ? '100%' : `${value}px`;
}

export function resolvedInterfaceTheme(preferences: InterfacePreferences, dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false): Exclude<InterfacePreferences['theme'], 'auto'> {
  return preferences.theme === 'auto' ? dark ? 'cyan-night' : 'warm-paper' : preferences.theme;
}

export function applyInterfacePreferences(preferences: InterfacePreferences): void {
  const root = document.documentElement;
  const resolvedTheme = resolvedInterfaceTheme(preferences);
  const semanticPalette = resolveSemanticPalette(preferences, resolvedTheme);
  const readingFont = preferences.readingFont === 'serif' ? SERIF_STACK : SANS_STACK;
  const markdownFont = preferences.markdown.font === 'follow-reading'
    ? readingFont
    : preferences.markdown.font === 'serif'
      ? SERIF_STACK
      : preferences.markdown.font === 'monospace' ? MONO_STACK : SANS_STACK;
  const delta = preferences.readingSizeDelta;
  root.dataset.theme = resolvedTheme;
  root.dataset.themeSelection = preferences.theme;
  root.dataset.paperTexture = String(preferences.paperTexture);
  root.dataset.sunnyMode = String(preferences.sunnyMode);
  root.dataset.sessionDensity = preferences.singleLineSessions ? 'single' : 'comfortable';
  root.dataset.readingFont = preferences.readingFont;
  root.lang = preferences.locale;
  root.style.colorScheme = ['cyan-night', 'ming', 'cyan-night-contrast'].includes(resolvedTheme) ? 'dark' : 'light';
  root.style.setProperty('--reading-font-family', readingFont);
  root.style.setProperty('--markdown-font-family', markdownFont);
  root.style.setProperty('--reading-body-size', `${16 + delta}px`);
  root.style.setProperty('--markdown-body-size', `${preferences.markdown.bodySize + delta}px`);
  root.style.setProperty('--markdown-h1-size', `${preferences.markdown.heading1Size + delta}px`);
  root.style.setProperty('--markdown-h2-size', `${preferences.markdown.heading2Size + delta}px`);
  root.style.setProperty('--markdown-h3-size', `${preferences.markdown.heading3Size + delta}px`);
  root.style.setProperty('--markdown-line-height', String(preferences.markdown.lineHeight));
  root.style.setProperty('--markdown-content-padding', `${preferences.markdown.contentPadding}px`);
  root.style.setProperty('--chat-content-width', cssWidth(preferences.chatWidth));
  root.style.setProperty('--markdown-content-width', cssWidth(preferences.markdown.contentWidth));
  for (const [role, color] of Object.entries(semanticPalette)) {
    root.style.setProperty(`--semantic-${role}`, color);
  }
}

export async function loadInterfacePreferences(): Promise<InterfacePreferences> {
  if (!window.openlab) return defaultInterfacePreferences();
  try { return normalizeInterfacePreferences(await window.openlab.getInterfacePreferences()); }
  catch { return defaultInterfacePreferences(); }
}

export function InterfacePreferencesProvider({ initial, children }: { initial: InterfacePreferences; children: ReactNode }) {
  const normalizedInitial = useMemo(() => normalizeInterfacePreferences(initial), [initial]);
  const [preferences, setPreferences] = useState(normalizedInitial);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState<string>();
  const [restartRequired, setRestartRequired] = useState(false);
  const current = useRef(normalizedInitial);
  const lastSaved = useRef(normalizedInitial);
  const revision = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const saveChain = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    current.current = preferences;
    applyInterfacePreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (current.current.theme === 'auto') applyInterfacePreferences(current.current); };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => () => { if (timer.current !== undefined) window.clearTimeout(timer.current); }, []);

  const persist = useCallback((next: InterfacePreferences, targetRevision: number) => {
    saveChain.current = saveChain.current.then(async () => {
      try {
        const result = window.openlab
          ? await window.openlab.updateInterfacePreferences(next)
          : { preferences: next, restartRequired: false };
        const saved = normalizeInterfacePreferences(result.preferences);
        lastSaved.current = saved;
        if (revision.current === targetRevision) {
          current.current = saved;
          setPreferences(saved);
          setRestartRequired(result.restartRequired);
          setSaveError(undefined);
          setSaveStatus('saved');
        }
      } catch (error) {
        if (revision.current !== targetRevision) return;
        current.current = lastSaved.current;
        setPreferences(lastSaved.current);
        setSaveError(error instanceof Error ? error.message : String(error));
        setSaveStatus('error');
      }
    });
  }, []);

  const update = useCallback((patch: InterfacePreferencesPatch, options?: { debounced?: boolean }) => {
    const next = mergeInterfacePreferences(current.current, patch);
    current.current = next;
    setPreferences(next);
    applyInterfacePreferences(next);
    setSaveError(undefined);
    setSaveStatus('saving');
    revision.current += 1;
    const targetRevision = revision.current;
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => persist(next, targetRevision), options?.debounced ? 300 : 0);
  }, [persist]);

  const value = useMemo<InterfacePreferencesContextValue>(() => ({
    preferences, saveStatus, saveError, restartRequired, update,
  }), [preferences, restartRequired, saveError, saveStatus, update]);
  return <InterfacePreferencesContext.Provider value={value}>{children}</InterfacePreferencesContext.Provider>;
}

export function useInterfacePreferences(): InterfacePreferencesContextValue {
  const value = useContext(InterfacePreferencesContext);
  if (!value) throw new Error('InterfacePreferencesProvider is missing');
  return value;
}
