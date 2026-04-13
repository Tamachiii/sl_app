import { NavLink } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';

function NavItem({ to, label, icon }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex flex-col items-center gap-0.5 py-2 px-3 text-xs font-medium transition-colors ${
          isActive ? 'text-primary' : 'text-gray-400'
        }`
      }
    >
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}

const HomeIcon = (
  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4" />
  </svg>
);

const LibraryIcon = (
  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
  </svg>
);

const ProfileIcon = (
  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
  </svg>
);

export default function BottomNav() {
  const { role, signOut } = useAuth();

  if (role === 'coach') {
    return (
      <nav aria-label="Main navigation" className="sticky bottom-0 bg-white border-t border-gray-200 flex justify-around">
        <NavItem to="/coach" label="Students" icon={HomeIcon} />
        <NavItem to="/coach/exercises" label="Library" icon={LibraryIcon} />
        <button
          onClick={signOut}
          aria-label="Sign out"
          className="flex flex-col items-center gap-0.5 py-2 px-3 text-xs font-medium text-gray-400"
        >
          {ProfileIcon}
          <span>Logout</span>
        </button>
      </nav>
    );
  }

  return (
    <nav aria-label="Main navigation" className="sticky bottom-0 bg-white border-t border-gray-200 flex justify-around">
      <NavItem to="/student" label="Home" icon={HomeIcon} />
      <button
        onClick={signOut}
        aria-label="Sign out"
        className="flex flex-col items-center gap-0.5 py-2 px-3 text-xs font-medium text-gray-400"
      >
        {ProfileIcon}
        <span>Logout</span>
      </button>
    </nav>
  );
}
