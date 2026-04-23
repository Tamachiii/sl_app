import { useSetVideoSignedUrl } from '../../hooks/useSetVideo';
import Spinner from './Spinner';

export default function VideoPlayer({ storagePath, className = '' }) {
  const { data: url, isLoading, error } = useSetVideoSignedUrl(storagePath);

  if (isLoading) {
    return (
      <div className={`flex items-center justify-center aspect-video bg-ink-100 rounded-lg ${className}`}>
        <Spinner />
      </div>
    );
  }
  if (error || !url) {
    return (
      <div className={`flex items-center justify-center aspect-video bg-ink-100 rounded-lg sl-mono text-[11px] text-ink-400 ${className}`}>
        Video unavailable
      </div>
    );
  }
  return (
    <video
      key={url}
      src={url}
      controls
      playsInline
      preload="metadata"
      className={`w-full rounded-lg bg-black ${className}`}
    />
  );
}
