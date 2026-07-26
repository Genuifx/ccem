import { invoke } from '@tauri-apps/api/core';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import zh from './zh.json';
import en from './en.json';
import { createSerialTaskQueue } from '../lib/serialTaskQueue';

type LocaleKey = 'zh' | 'en';
type Messages = Record<string, Record<string, string>>;
type LanguageSaveRequest = {
  language: LocaleKey;
  revision: number;
};

const messages: Record<LocaleKey, Messages> = { zh, en };

interface LocaleContextType {
  t: (key: string, params?: Record<string, string | number>) => string;
  lang: LocaleKey;
  languageHydrated: boolean;
  setLang: (lang: LocaleKey) => Promise<void>;
  captureLanguageHydration: () => number;
  hydratePersistedLanguage: (lang: unknown, expectedRevision: number) => void;
}

const LocaleContext = createContext<LocaleContextType | null>(null);

function parseLocaleKey(value: unknown): LocaleKey | null {
  return value === 'zh' || value === 'en' ? value : null;
}

function readLegacyLocale(): LocaleKey | null {
  if (typeof localStorage === 'undefined') {
    return null;
  }

  try {
    return parseLocaleKey(localStorage.getItem('ccem-locale'));
  } catch {
    return null;
  }
}

function readCachedLocale(): LocaleKey {
  if (typeof localStorage === 'undefined') {
    return 'zh';
  }

  try {
    const cachedSettings = localStorage.getItem('ccem-settings');
    if (!cachedSettings) {
      return readLegacyLocale() ?? 'zh';
    }
    return parseLocaleKey(JSON.parse(cachedSettings).language)
      ?? readLegacyLocale()
      ?? 'zh';
  } catch {
    return readLegacyLocale() ?? 'zh';
  }
}

function cacheConfirmedLocale(language: LocaleKey) {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    const cachedSettings = localStorage.getItem('ccem-settings');
    const parsed = cachedSettings ? JSON.parse(cachedSettings) : {};
    localStorage.setItem('ccem-settings', JSON.stringify({
      ...parsed,
      language,
    }));
  } catch {
    try {
      localStorage.setItem('ccem-settings', JSON.stringify({ language }));
    } catch {
      // Cache failure must not affect the backend-owned language setting.
    }
  }
}

function clearLegacyLocale() {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    localStorage.removeItem('ccem-locale');
  } catch {
    // A stale compatibility key is harmless when storage is unavailable.
  }
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<LocaleKey>(readCachedLocale);
  const [languageHydrated, setLanguageHydrated] = useState(false);
  const currentLanguageRef = useRef(lang);
  const initialLanguageRef = useRef(lang);
  const confirmedLanguageRef = useRef<LocaleKey | null>(null);
  const languageRevisionRef = useRef(0);
  const pendingSelectionRevisionRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const saveLanguageQueueRef = useRef<(
    request: LanguageSaveRequest,
  ) => Promise<void>>();

  if (!saveLanguageQueueRef.current) {
    saveLanguageQueueRef.current = createSerialTaskQueue(
      async ({ language, revision }: LanguageSaveRequest) => {
        try {
          await invoke('save_language', { language });
          confirmedLanguageRef.current = language;
          cacheConfirmedLocale(language);
          clearLegacyLocale();

          if (
            pendingSelectionRevisionRef.current === revision
            && currentLanguageRef.current === language
          ) {
            pendingSelectionRevisionRef.current = null;
          }
        } catch (error) {
          if (
            pendingSelectionRevisionRef.current === revision
            && currentLanguageRef.current === language
          ) {
            const fallbackLanguage = confirmedLanguageRef.current
              ?? initialLanguageRef.current;
            languageRevisionRef.current += 1;
            pendingSelectionRevisionRef.current = null;
            currentLanguageRef.current = fallbackLanguage;
            if (mountedRef.current) {
              setLangState(fallbackLanguage);
            }
          }
          throw error;
        }
      },
    );
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const captureLanguageHydration = useCallback(
    () => languageRevisionRef.current,
    [],
  );

  const hydratePersistedLanguage = useCallback((
    value: unknown,
    expectedRevision: number,
  ) => {
    if (languageRevisionRef.current !== expectedRevision) {
      return;
    }

    const persistedLanguage = parseLocaleKey(value);
    languageRevisionRef.current += 1;
    const hydrationRevision = languageRevisionRef.current;
    setLanguageHydrated(true);

    if (persistedLanguage) {
      confirmedLanguageRef.current = persistedLanguage;
      pendingSelectionRevisionRef.current = null;
      currentLanguageRef.current = persistedLanguage;
      setLangState(persistedLanguage);
      cacheConfirmedLocale(persistedLanguage);
      clearLegacyLocale();
      return;
    }

    // Pre-language settings files are migrated exactly once from the legacy key.
    // Until that dedicated save succeeds, the backend's effective language is zh.
    const migrationLanguage = readLegacyLocale() ?? 'zh';
    confirmedLanguageRef.current = 'zh';
    pendingSelectionRevisionRef.current = hydrationRevision;
    currentLanguageRef.current = migrationLanguage;
    setLangState(migrationLanguage);
    void saveLanguageQueueRef.current?.({
      language: migrationLanguage,
      revision: hydrationRevision,
    }).catch(() => {
      // Settings surfaces explicit failures for user-triggered changes. A startup
      // migration safely falls back to the backend default and can retry next run.
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const expectedRevision = captureLanguageHydration();

    void invoke<{ language?: unknown }>('get_settings')
      .then((settings) => {
        if (!cancelled) {
          hydratePersistedLanguage(settings.language, expectedRevision);
        }
      })
      .catch(() => {
        // A Settings-page read may still hydrate the provider. Until then, the
        // presentation cache is read-only and no fallback is written to backend.
      });

    return () => {
      cancelled = true;
    };
  }, [captureLanguageHydration, hydratePersistedLanguage]);

  const setLang = useCallback((newLang: LocaleKey) => {
    if (
      currentLanguageRef.current === newLang
      && pendingSelectionRevisionRef.current === null
    ) {
      return Promise.resolve();
    }

    languageRevisionRef.current += 1;
    const selectionRevision = languageRevisionRef.current;
    currentLanguageRef.current = newLang;
    pendingSelectionRevisionRef.current = selectionRevision;
    setLangState(newLang);
    setLanguageHydrated(true);
    return saveLanguageQueueRef.current?.({
      language: newLang,
      revision: selectionRevision,
    }) ?? Promise.resolve();
  }, []);

  const t = useCallback((key: string, params?: Record<string, string | number>): string => {
    const [namespace, ...rest] = key.split('.');
    const msgKey = rest.join('.');
    const message = messages[lang]?.[namespace]?.[msgKey] || key;
    if (!params) return message;
    return message.replace(/\{(\w+)\}/g, (_, paramKey) => String(params[paramKey] ?? `{${paramKey}}`));
  }, [lang]);

  const value = useMemo(
    () => ({
      t,
      lang,
      languageHydrated,
      setLang,
      captureLanguageHydration,
      hydratePersistedLanguage,
    }),
    [
      t,
      lang,
      languageHydrated,
      setLang,
      captureLanguageHydration,
      hydratePersistedLanguage,
    ],
  );

  return (
    <LocaleContext.Provider value={value}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  const context = useContext(LocaleContext);
  if (!context) throw new Error('useLocale must be used within LocaleProvider');
  return context;
}

export type { LocaleKey };
