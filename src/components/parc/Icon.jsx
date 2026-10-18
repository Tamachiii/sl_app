// The 22 icons of the Parc design system (design/parc/icons/), a 2px stroke in
// a 24px box, drawn in `currentColor`: the colour of the text around them,
// `ink-2` at rest and `blue` when active. Generated from the SVG files; a
// new icon is added there first, then here with the same path.
export const ICONS = {
  'athletes': { d: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z' },
  'check': { d: 'M5 13l4 4L19 7' },
  'chevron-down': { d: 'M19 9l-7 7-7-7' },
  'chevron-left': { d: 'M15 19l-7-7 7-7' },
  'chevron-right': { d: 'M9 5l7 7-7 7' },
  'chevron-up': { d: 'M5 15l7-7 7 7' },
  'clock': { d: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
  'close': { d: 'M6 6l12 12M18 6L6 18' },
  'drag': { d: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01', strokeWidth: 3 },
  'library': { d: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253' },
  'messages': { d: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z' },
  'more': { d: 'M5 12h.01M12 12h.01M19 12h.01', strokeWidth: 3 },
  'note': { d: 'M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z' },
  'play': { d: 'M8 5v14l11-7z', filled: true },
  'plus': { d: 'M12 5v14M5 12h14' },
  'search': { d: 'M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z' },
  'send': { d: 'M12 19l9 2-9-18-9 18 9-2zm0 0v-8' },
  'sessions': { d: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4' },
  'skip': { d: 'M13 5l7 7-7 7M5 5l7 7-7 7' },
  'stats': { d: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
  'swap': { d: 'M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4' },
  'video': { d: 'M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z' },
};

/**
 * One icon of the set. Decorative: it is hidden from assistive technology,
 * and the button or link that holds it carries the name (`aria-label`).
 * `size` follows design/parc/README.md: 24 in the tab bar, 22 in a round
 * button, 16 to 18 in a row.
 */
export default function Icon({ name, size = 24, className, strokeWidth }) {
  const icon = ICONS[name];
  if (!icon) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={icon.filled ? 'currentColor' : 'none'}
      stroke={icon.filled ? 'none' : 'currentColor'}
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={icon.filled ? undefined : strokeWidth ?? icon.strokeWidth ?? 2}
        d={icon.d}
      />
    </svg>
  );
}
