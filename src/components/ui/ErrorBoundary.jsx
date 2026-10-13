import { Component } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { reportError } from '../../lib/errorReporter';
import { chunkRecovery, isChunkLoadError } from '../../lib/chunkRecovery';
import { writesAreSafe } from '../../lib/pendingWrites';
import { useI18n } from '../../hooks/useI18n';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';

class ErrorBoundaryInner extends Component {
  // The app's query client, when a provider is above: "Reload" waits for the
  // writes it would drop. Read from the context and not through a hook, so
  // that a boundary mounted without one still draws.
  static contextType = QueryClientContext;

  state = { hasError: false, error: null, reloadAsked: false };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // A file of the app that did not load is a deploy this page slept
    // through, or a network that is not there — not a crash, and nothing the
    // list of errors can teach: the way on is a reload (lib/chunkRecovery).
    if (isChunkLoadError(error)) return;
    // The dev-coach's feedback loop for crashes on students' phones.
    reportError(error, error?.message);
    if (info?.componentStack) {
      reportError({ message: 'componentStack', stack: info.componentStack });
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  handleHome = () => {
    // Escape the crashing subtree entirely — "Try again" re-renders the same
    // tree and often re-crashes; a hard route change to the role home doesn't.
    if (typeof window !== 'undefined') {
      window.location.assign(`${import.meta.env.BASE_URL}#/`);
      window.location.reload();
    }
  };

  handleReload = async () => {
    this.setState({ reloadAsked: true });
    // The person's choice, like "Update": it waits for the writes a reload
    // would drop, and not for ever. Past that wait the reload goes ahead — on
    // this screen there is nothing else left to do.
    if (this.context) await writesAreSafe(this.context);
    this.props.recovery.reloadNow();
  };

  renderMissingFile() {
    const { t, online, recovery } = this.props;
    // `isReloading`: the page already reloads by itself (lib/chunkRecovery) and
    // this screen is what shows until the browser gets there.
    const reloading = this.state.reloadAsked || recovery.isReloading();
    let body = online ? t('chunkRecovery.body') : t('chunkRecovery.offlineBody');
    if (reloading) body = t('chunkRecovery.reloading');
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] p-6 text-center">
        <h2 className="sl-display text-[18px] text-gray-900 mb-2">
          {online ? t('chunkRecovery.title') : t('chunkRecovery.offlineTitle')}
        </h2>
        <p role="status" className="text-[13px] text-ink-500 mb-4 max-w-md">
          {body}
        </p>
        {/* No "Try again": React.lazy keeps a failed import for good, and the
            same tree would fail on the same file. */}
        <button
          type="button"
          onClick={this.handleReload}
          disabled={this.state.reloadAsked}
          className="sl-btn-primary text-[13px] min-h-[44px]"
          style={{ padding: '10px 16px' }}
        >
          {t('chunkRecovery.reload')}
        </button>
      </div>
    );
  }

  render() {
    const { t } = this.props;
    if (this.state.hasError) {
      if (isChunkLoadError(this.state.error)) return this.renderMissingFile();
      return (
        <div className="flex flex-col items-center justify-center min-h-[50vh] p-6 text-center">
          <h2 className="sl-display text-[18px] text-gray-900 mb-2">
            {t('errorBoundary.title')}
          </h2>
          <p className="text-[13px] text-ink-500 mb-4 max-w-md">
            {t('errorBoundary.body')}
          </p>
          <div className="flex gap-2">
            <button
              onClick={this.handleReset}
              className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200"
            >
              {t('errorBoundary.tryAgain')}
            </button>
            <button
              onClick={this.handleHome}
              className="sl-btn-primary text-[12px]"
              style={{ padding: '8px 14px' }}
            >
              {t('errorBoundary.goHome')}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * `recovery` is a prop for the tests; the app uses the one of lib/chunkRecovery.
 */
export default function ErrorBoundary({ children, recovery = chunkRecovery }) {
  const { t } = useI18n();
  const online = useOnlineStatus();
  return (
    <ErrorBoundaryInner t={t} online={online} recovery={recovery}>
      {children}
    </ErrorBoundaryInner>
  );
}
