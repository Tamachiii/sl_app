import { useNavigate } from 'react-router-dom';
import ThemeToggle from '../ui/ThemeToggle';

export default function Header({ title, showBack = false, actions }) {
  const navigate = useNavigate();

  return (
    <header className="sticky top-0 z-10 bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3">
      {showBack && (
        <button
          onClick={() => navigate(-1)}
          className="text-gray-600 -ml-1 p-1"
          aria-label="Go back"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      )}
      <h1 className="text-lg font-semibold text-gray-900 flex-1 truncate">{title}</h1>
      <div className="flex items-center gap-2">
        {actions}
        <ThemeToggle />
      </div>
    </header>
  );
}
