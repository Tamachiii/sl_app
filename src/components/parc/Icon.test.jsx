import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Icon, { ICONS } from './Icon';

const iconsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../design/parc/icons');
const files = readdirSync(iconsDir).filter((name) => name.endsWith('.svg'));

describe('Icon', () => {
  it('carries every icon of design/parc/icons, with the same path, and no other', () => {
    expect(Object.keys(ICONS).sort()).toEqual(files.map((name) => name.replace(/\.svg$/, '')).sort());
    for (const file of files) {
      const d = /\sd="([^"]+)"/.exec(readFileSync(resolve(iconsDir, file), 'utf8'))[1];
      expect(ICONS[file.replace(/\.svg$/, '')].d, file).toBe(d);
    }
  });

  it('is drawn in currentColor and hidden from assistive technology', () => {
    const { container } = render(<Icon name="check" size={18} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('stroke', 'currentColor');
    expect(svg).toHaveAttribute('width', '18');
    expect(svg.querySelector('path')).toHaveAttribute('stroke-width', '2');
  });

  it('fills the play icon instead of stroking it', () => {
    const { container } = render(<Icon name="play" />);
    expect(container.querySelector('svg')).toHaveAttribute('fill', 'currentColor');
  });

  it('draws nothing for a name it does not know', () => {
    const { container } = render(<Icon name="nope" />);
    expect(container).toBeEmptyDOMElement();
  });
});
