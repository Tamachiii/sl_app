import { useEffect, useRef, useState } from 'react';
import { useSetVideoSignedUrl } from '../../hooks/useSetVideo';
import Spinner from './Spinner';

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const SPEEDS = [0.25, 0.5, 1];

export default function VideoPlayer({ storagePath, className = '' }) {
  const { data: url, isLoading, error } = useSetVideoSignedUrl(storagePath);
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => setCurrent(v.currentTime);
    const onMeta = () => setDuration(v.duration || 0);
    const onEnded = () => setPlaying(false);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('ended', onEnded);
    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('ended', onEnded);
    };
  }, [url]);

  useEffect(() => {
    const v = videoRef.current;
    if (v) v.playbackRate = rate;
  }, [rate, url]);

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  }

  function onSeek(e) {
    const v = videoRef.current;
    if (!v) return;
    const next = Number(e.target.value);
    v.currentTime = next;
    setCurrent(next);
  }

  function cycleSpeed() {
    const idx = SPEEDS.indexOf(rate);
    setRate(SPEEDS[(idx + 1) % SPEEDS.length]);
  }

  function goFullscreen() {
    const v = videoRef.current;
    const container = containerRef.current;
    if (v?.webkitEnterFullscreen) {
      v.webkitEnterFullscreen();
      return;
    }
    if (container?.requestFullscreen) container.requestFullscreen();
  }

  if (isLoading) {
    return (
      <div className={`flex items-center justify-center aspect-video bg-ink-900 rounded-lg ${className}`}>
        <Spinner />
      </div>
    );
  }
  if (error || !url) {
    return (
      <div className={`flex items-center justify-center aspect-video bg-ink-900 rounded-lg sl-mono text-[11px] text-ink-300 ${className}`}>
        Video unavailable
      </div>
    );
  }

  const progress = duration > 0 ? (current / duration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      className={`relative rounded-lg overflow-hidden bg-black group select-none inline-block max-w-full ${className}`}
    >
      <video
        ref={videoRef}
        key={url}
        src={url}
        playsInline
        preload="metadata"
        onClick={togglePlay}
        className="block max-h-[85vh] max-w-full cursor-pointer"
      />

      <button
        type="button"
        onClick={togglePlay}
        aria-label={playing ? 'Pause' : 'Play'}
        className={`absolute inset-0 flex items-center justify-center transition-opacity ${
          playing ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'
        }`}
      >
        <span
          className="w-16 h-16 rounded-full flex items-center justify-center shadow-lg"
          style={{ background: 'color-mix(in srgb, var(--color-accent) 90%, transparent)' }}
        >
          {playing ? (
            <svg className="w-7 h-7 text-ink-900" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
            </svg>
          ) : (
            <svg className="w-7 h-7 text-ink-900 ml-1" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </span>
      </button>

      <div
        className="absolute left-0 right-0 bottom-0 px-3 pt-6 pb-2 flex items-center gap-2"
        style={{
          background:
            'linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.3) 60%, rgba(0,0,0,0) 100%)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? 'Pause' : 'Play'}
          className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-white/20 hover:bg-white/30 text-white"
        >
          {playing ? (
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5 ml-0.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        <span className="sl-mono text-[11px] text-white tabular-nums shrink-0">
          {formatTime(current)} / {formatTime(duration)}
        </span>

        <div className="flex-1 relative h-7 flex items-center">
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 rounded-full bg-white/25" />
          <div
            className="absolute left-0 top-1/2 -translate-y-1/2 h-1 rounded-full pointer-events-none"
            style={{ width: `${progress}%`, background: 'var(--color-accent)' }}
          />
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.01}
            value={current}
            onChange={onSeek}
            aria-label="Seek"
            className="absolute inset-0 w-full h-full appearance-none bg-transparent cursor-pointer video-scrub"
          />
        </div>

        <button
          type="button"
          onClick={cycleSpeed}
          aria-label={`Playback speed ${rate}x`}
          className="shrink-0 sl-mono text-[10px] font-semibold text-ink-900 rounded px-2 py-1 tabular-nums"
          style={{ background: 'var(--color-accent)' }}
        >
          {rate}×
        </button>

        <button
          type="button"
          onClick={goFullscreen}
          aria-label="Fullscreen"
          className="shrink-0 w-7 h-7 rounded flex items-center justify-center bg-white/20 hover:bg-white/30 text-white"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" />
          </svg>
        </button>
      </div>
    </div>
  );
}
