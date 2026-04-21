import { useI18n } from '../../hooks/useI18n';

const LABELS = { en: 'EN', fr: 'FR', de: 'DE' };

export default function LanguageSelect() {
  const { lang, setLang, languages, t } = useI18n();
  return (
    <div className="inline-flex items-center gap-1" role="group" aria-label={t('common.language')}>
      {languages.map((code) => {
        const active = code === lang;
        return (
          <button
            key={code}
            type="button"
            onClick={() => setLang(code)}
            aria-pressed={active}
            className={`sl-mono text-[10px] font-semibold tracking-widest rounded-md px-2 py-1 transition-colors ${
              active
                ? 'text-ink-900 dark:text-ink-0'
                : 'text-ink-400 hover:text-ink-700'
            }`}
            style={
              active
                ? {
                    background: 'color-mix(in srgb, var(--color-accent) 22%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--color-accent) 55%, transparent)',
                  }
                : { border: '1px solid transparent' }
            }
          >
            {LABELS[code] ?? code.toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}
