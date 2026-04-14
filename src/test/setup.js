import '@testing-library/jest-dom';
import { vi } from 'vitest';

// jsdom lacks HTMLDialogElement.showModal / close — polyfill so <Dialog> mounts
if (typeof HTMLDialogElement !== 'undefined') {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = vi.fn(function () {
      this.open = true;
    });
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = vi.fn(function () {
      this.open = false;
    });
  }
}

// jsdom lacks matchMedia — polyfill for ThemeProvider
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
