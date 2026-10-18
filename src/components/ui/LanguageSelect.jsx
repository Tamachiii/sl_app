import { useI18n } from '../../hooks/useI18n';
import { SegmentedControl } from '../parc';

/**
 * The language of the app, as a Parc segmented control: each language named
 * in its own language (« Français », « Deutsch »), the one in use pressed.
 */
export default function LanguageSelect({ label }) {
  const { lang, setLang, languages, t } = useI18n();
  return (
    <SegmentedControl
      label={label}
      value={lang}
      onChange={setLang}
      options={languages.map((code) => ({ value: code, label: t(`parcMenu.${code}`) }))}
      ariaLabel={t('common.language')}
    />
  );
}
