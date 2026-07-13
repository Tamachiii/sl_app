import { Component } from 'react';
import { reportError } from '../../lib/errorReporter';
import { useI18n } from '../../hooks/useI18n';

class ErrorBoundaryInner extends Component {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
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

  render() {
    const { t } = this.props;
    if (this.state.hasError) {
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

export default function ErrorBoundary({ children }) {
  const { t } = useI18n();
  return <ErrorBoundaryInner t={t}>{children}</ErrorBoundaryInner>;
}
