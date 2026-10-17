import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import VideoPlayer from './VideoPlayer';
import { I18nProvider } from '../../hooks/useI18n';

// The player of a set's video, in the coach's review: its own controls over
// the video, each a 44px target named in the app's language.
let mockUrl = { data: 'https://cdn.example/v/set-1.mp4', isLoading: false, error: null };
vi.mock('../../hooks/useSetVideo', () => ({
  useSetVideoSignedUrl: () => mockUrl,
}));

let play;
let pause;
beforeEach(() => {
  mockUrl = { data: 'https://cdn.example/v/set-1.mp4', isLoading: false, error: null };
  // jsdom has no media playback: the element's own methods are stubbed, and
  // its events fired by the test.
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem('sl_app_lang');
});

const video = (container) => container.querySelector('video');
// The control bar's button; the other one of the same name covers the video.
const barButton = (name) => screen.getAllByRole('button', { name }).at(-1);

describe('<VideoPlayer />', () => {
  it('shows a spinner while the address of the video is read', () => {
    mockUrl = { data: undefined, isLoading: true, error: null };
    render(<VideoPlayer storagePath="a/b/c.mp4" />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it.each([
    ['the read failed', { data: undefined, isLoading: false, error: new Error('nope') }],
    ['there is no address', { data: null, isLoading: false, error: null }],
  ])('says the video is unavailable when %s', (_label, state) => {
    mockUrl = state;
    const { container } = render(<VideoPlayer storagePath="a/b/c.mp4" />);
    expect(screen.getByText('Video unavailable')).toBeInTheDocument();
    expect(video(container)).toBeNull();
  });

  it('plays and pauses, and says which it would do', () => {
    const { container } = render(<VideoPlayer storagePath="a/b/c.mp4" />);
    expect(video(container)).toHaveAttribute('src', 'https://cdn.example/v/set-1.mp4');
    expect(screen.getAllByRole('button', { name: 'Play' })).toHaveLength(2);

    fireEvent.click(barButton('Play'));
    expect(play).toHaveBeenCalledTimes(1);
    act(() => {
      video(container).dispatchEvent(new Event('play'));
    });
    expect(screen.getAllByRole('button', { name: 'Pause' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument();

    // A paused element says so through `paused`, which jsdom keeps true.
    Object.defineProperty(video(container), 'paused', { configurable: true, get: () => false });
    fireEvent.click(barButton('Pause'));
    expect(pause).toHaveBeenCalledTimes(1);
    act(() => {
      video(container).dispatchEvent(new Event('pause'));
    });
    expect(screen.getAllByRole('button', { name: 'Play' })).toHaveLength(2);
  });

  it('moves to the position the slider is put at, and shows the time', () => {
    const { container } = render(<VideoPlayer storagePath="a/b/c.mp4" />);
    const v = video(container);
    Object.defineProperty(v, 'duration', { configurable: true, get: () => 75 });
    act(() => {
      v.dispatchEvent(new Event('loadedmetadata'));
    });
    const slider = screen.getByRole('slider', { name: 'Position in the video' });
    expect(slider).toHaveAttribute('max', '75');
    fireEvent.change(slider, { target: { value: '30' } });
    expect(v.currentTime).toBe(30);
    expect(screen.getByText('0:30 / 1:15')).toBeInTheDocument();
  });

  it('turns through the speeds: 1×, then 0.25×, 0.5× and back', () => {
    const { container } = render(<VideoPlayer storagePath="a/b/c.mp4" />);
    const v = video(container);
    expect(screen.getByRole('button', { name: 'Speed 1×' })).toHaveTextContent('1×');
    fireEvent.click(screen.getByRole('button', { name: 'Speed 1×' }));
    expect(v.playbackRate).toBe(0.25);
    fireEvent.click(screen.getByRole('button', { name: 'Speed 0.25×' }));
    expect(v.playbackRate).toBe(0.5);
    fireEvent.click(screen.getByRole('button', { name: 'Speed 0.5×' }));
    expect(v.playbackRate).toBe(1);
    expect(screen.getByRole('button', { name: 'Speed 1×' })).toBeInTheDocument();
  });

  it('goes full screen: the video itself on iOS, the player elsewhere', () => {
    const { container } = render(<VideoPlayer storagePath="a/b/c.mp4" />);
    const requestFullscreen = vi.fn();
    container.firstChild.requestFullscreen = requestFullscreen;
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(requestFullscreen).toHaveBeenCalledTimes(1);

    const webkitEnterFullscreen = vi.fn();
    video(container).webkitEnterFullscreen = webkitEnterFullscreen;
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(webkitEnterFullscreen).toHaveBeenCalledTimes(1);
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it('gives every control of the bar a 44px target', () => {
    render(<VideoPlayer storagePath="a/b/c.mp4" />);
    for (const name of ['Play', 'Full screen']) {
      expect(barButton(name)).toHaveClass('h-11', 'w-11');
    }
    expect(screen.getByRole('button', { name: 'Speed 1×' })).toHaveClass('h-11', 'min-w-11');
    expect(screen.getByRole('slider', { name: 'Position in the video' })).toHaveStyle({ height: '44px' });
  });

  it('names its controls in the language of the app', () => {
    localStorage.setItem('sl_app_lang', 'fr');
    render(
      <I18nProvider>
        <VideoPlayer storagePath="a/b/c.mp4" />
      </I18nProvider>,
    );
    expect(screen.getAllByRole('button', { name: 'Lire' })).toHaveLength(2);
    expect(screen.getByRole('slider', { name: 'Position dans la vidéo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Plein écran' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Vitesse 1×' })).toBeInTheDocument();
  });

  // A number goes through lib/i18n/format.js with the app's language
  // (CLAUDE.md): in French a quarter is "0,25".
  it('writes the speed as the language of the app writes a number', () => {
    localStorage.setItem('sl_app_lang', 'fr');
    render(
      <I18nProvider>
        <VideoPlayer storagePath="a/b/c.mp4" />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Vitesse 1×' }));
    const speed = screen.getByRole('button', { name: 'Vitesse 0,25×' });
    expect(speed).toHaveTextContent('0,25×');
  });
});
