import { useNavigate } from 'react-router-dom';
import ThemeToggle from '../ui/ThemeToggle';
import LanguageSelect from '../ui/LanguageSelect';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';

export default function Header({ title, showBack = false, actions }) {
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const { t } = useI18n();

  return (
    <header className="sticky top-0 z-10 bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3">
      {showBack && (
        <button
          onClick={() => navigate(-1)}
          className="text-gray-600 -ml-1 p-1"
          aria-label={t('common.back')}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      )}
      <h1 className="text-lg font-semibold text-gray-900 flex-1 truncate">{title}</h1>
      <div className="flex items-center gap-2">
        {actions}
        <LanguageSelect />
        <ThemeToggle />
        {signOut && (
          <button
            onClick={signOut}
            aria-label={t('common.signOut')}
            className="p-1 text-gray-400 hover:text-gray-600"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        )}
      </div>
    </header>
  );
}
