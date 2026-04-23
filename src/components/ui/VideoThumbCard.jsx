export default function VideoThumbCard({ setNumber, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Play set ${setNumber} video`}
      className="group relative w-24 aspect-video rounded-lg overflow-hidden bg-black/85 hover:bg-black active:scale-95 transition"
      style={{
        border: '1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)',
      }}
    >
      <span
        className="absolute inset-0 flex items-center justify-center"
        aria-hidden="true"
      >
        <span
          className="w-8 h-8 rounded-full flex items-center justify-center shadow"
          style={{ background: 'color-mix(in srgb, var(--color-accent) 90%, transparent)' }}
        >
          <svg className="w-4 h-4 text-ink-900 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
        </span>
      </span>
      <span
        className="absolute left-1.5 bottom-1 sl-mono text-[9px] font-semibold text-white/90"
        style={{ textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}
      >
        SET {setNumber}
      </span>
    </button>
  );
}
