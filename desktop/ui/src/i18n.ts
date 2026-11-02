/** Picks the UI language and builds the translator the panel expects, without DSH's locale service. */
import { en, zh } from '../../../src/client/locales.ts'
import type { T } from '../../../src/client/text.ts'

export type Language = 'en' | 'zh'
const KEY = 'superagent-language'

/** A saved choice, otherwise the browser's language. */
export function pickLanguage(): Language {
  try { const saved = localStorage.getItem(KEY); if (saved === 'en' || saved === 'zh') return saved } catch { /* Then follow the browser. */ }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}
export function saveLanguage(language: Language): void {
  try { localStorage.setItem(KEY, language) } catch { /* The choice then lasts until reload. */ }
}
/** A translator over one dictionary, filling `{name}` placeholders; an unknown key is returned as it is. */
export function makeT(language: Language): T {
  const dictionary: Record<string, string> = language === 'zh' ? zh : en
  return ((key: string, params?: Record<string, unknown>) => {
    const template = dictionary[key] ?? key
    return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
  }) as T
}
