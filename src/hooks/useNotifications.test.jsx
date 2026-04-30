import { describe, it, expect } from 'vitest';
import { describeNotification, formatNotificationStamp } from './useNotifications';

describe('describeNotification', () => {
  it('maps a session_completed payload to copy + a coach review path', () => {
    const result = describeNotification({
      kind: 'session_completed',
      payload: {
        session_id: 'sess-1',
        session_title: 'Upper 1',
        student_row_id: 'srow-1',
        student_name: 'Alice',
      },
    });
    expect(result.i18nKey).toBe('notifications.sessionCompleted');
    expect(result.params).toEqual({ student: 'Alice', session: 'Upper 1' });
    expect(result.path).toBe('/coach/student/srow-1/session/sess-1/review');
  });

  it('returns null path when payload lacks the ids needed for the link', () => {
    const result = describeNotification({
      kind: 'session_completed',
      payload: { student_name: 'Alice' },
    });
    expect(result.path).toBeNull();
  });

  it('falls back to an unknown-kind message for new event types', () => {
    const result = describeNotification({
      kind: 'goal_achieved',
      payload: { something: 'else' },
    });
    expect(result.i18nKey).toBe('notifications.unknown');
    expect(result.params).toEqual({ kind: 'goal_achieved' });
    expect(result.path).toBeNull();
  });

  it('handles missing input defensively', () => {
    expect(describeNotification(null).i18nKey).toBe('notifications.unknown');
    expect(describeNotification(undefined).path).toBeNull();
  });
});

describe('formatNotificationStamp', () => {
  it('returns empty string for missing input', () => {
    expect(formatNotificationStamp(null)).toBe('');
  });

  it('renders an HH:MM time for same-day timestamps', () => {
    const today = new Date();
    today.setHours(9, 5, 0, 0);
    const out = formatNotificationStamp(today.toISOString(), 'en');
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });
});
