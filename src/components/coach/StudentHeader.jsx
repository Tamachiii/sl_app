function initialsOf(fullName) {
  return (fullName || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * Athlete identity, pinned above the page: avatar + name, nothing else.
 *
 * This used to be a whole tab (StudentProfileSection) holding an avatar, the
 * word "Student", a join date and two links — context and shortcuts, never a
 * destination. As a header it costs no tab and the coach can see WHO they are
 * programming for from anywhere on the page, which is exactly when it matters.
 *
 * Everything that was not the name has been stripped: the "View sessions" /
 * "Message" pills (destinations the coach nav already reaches) and the
 * "coaching since" date (a fact nobody programs against). The header answers
 * one question — who am I writing this for — and the sheet below owns the rest.
 *
 * Deliberately carries no week strip either: that data comes from the
 * active-program summary query, so it would contradict the sheet below whenever
 * the coach is editing a non-active block.
 */
export default function StudentHeader({ student }) {
  const fullName = student.profile?.full_name || 'Student';

  return (
    <div className="flex items-center gap-3">
      <div
        className="w-11 h-11 rounded-full flex items-center justify-center sl-display text-[15px] shrink-0"
        style={{
          background: 'color-mix(in srgb, var(--color-accent) 15%, transparent)',
          color: 'var(--color-accent)',
          border: '1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)',
        }}
        aria-hidden="true"
      >
        {initialsOf(fullName) || '—'}
      </div>

      <h2 className="sl-display text-[19px] md:text-[21px] text-gray-900 leading-tight truncate min-w-0 flex-1">
        {fullName}
      </h2>
    </div>
  );
}
