import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SlotProgress from './SlotProgress';

// Live finding N12: a set the athlete added counted as one of the planned
// sets — "3/3 done" when one of the three prescribed sets was never done.

const set = (set_number, overrides = {}) => ({
  id: `log-${set_number}`,
  set_number,
  done: false,
  failed: false,
  skipped: false,
  rpe: null,
  is_student_added: false,
  ...overrides,
});

// The read-out line: "n/planned done …".
const summary = () => screen.getByText(/\/\d+ done/).closest('span');

describe('<SlotProgress />', () => {
  it('renders nothing before a set is logged', () => {
    const { container } = render(<SlotProgress logs={[]} plannedSets={3} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('counts the prescribed sets against the plan, and the extra ones apart', () => {
    render(
      <SlotProgress
        plannedSets={3}
        logs={[
          set(1, { done: true, rpe: 8 }),
          set(2, { done: true, rpe: 9 }),
          set(3),
          set(4, { done: true, rpe: 9, is_student_added: true }),
        ]}
      />,
    );
    expect(summary()).toHaveTextContent('2/3 done');
    expect(summary()).toHaveTextContent('+1 extra');
    expect(summary()).toHaveTextContent('2/3 RPE');
    expect(summary()).not.toHaveTextContent('3/3');
  });

  it('says nothing about extras when there are none done', () => {
    render(
      <SlotProgress
        plannedSets={2}
        logs={[set(1, { done: true }), set(2, { done: true }), set(3, { is_student_added: true })]}
      />,
    );
    expect(summary()).toHaveTextContent('2/2 done');
    expect(summary()).not.toHaveTextContent(/extra/);
  });

  it('keeps the "+Set n" pill of an extra set', () => {
    render(
      <SlotProgress
        plannedSets={1}
        logs={[set(1, { done: true }), set(2, { done: true, is_student_added: true })]}
      />,
    );
    expect(screen.getByText('Set 1')).toBeInTheDocument();
    expect(screen.getByText('+Set 2')).toBeInTheDocument();
    expect(screen.getByTitle('+Set 2: done (no RPE)')).toBeInTheDocument();
  });

  it('counts failed and skipped sets, extras included', () => {
    render(
      <SlotProgress
        plannedSets={2}
        logs={[set(1, { failed: true }), set(2, { skipped: true }), set(3, { failed: true, is_student_added: true })]}
      />,
    );
    expect(summary()).toHaveTextContent('0/2 done');
    expect(summary()).toHaveTextContent('2 failed');
    expect(summary()).toHaveTextContent('1 skipped');
  });
});
