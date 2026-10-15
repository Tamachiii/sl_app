import { describe, it, expect } from 'vitest';
import { returnPathFor, loginState } from './returnPath';

describe('returnPathFor', () => {
  it('returns to a page of the role that signed in, query included', () => {
    expect(returnPathFor('coach', '/coach/students/a1/s/s1')).toBe('/coach/students/a1/s/s1');
    expect(returnPathFor('coach', '/coach/students/a1?program=p2')).toBe('/coach/students/a1?program=p2');
    expect(returnPathFor('student', '/student/session/s1')).toBe('/student/session/s1');
  });

  it("goes home for another role's page", () => {
    expect(returnPathFor('coach', '/student/session/s1')).toBe('/coach');
    expect(returnPathFor('student', '/coach/students/a1')).toBe('/student');
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a non-string', { pathname: '/coach/students' }],
    ['the root', '/'],
    ['the login page', '/login'],
    ['the bare role path', '/coach'],
    ['a prefix that is not a segment', '/coachX/students'],
    ['a protocol-relative URL', '//evil.example/coach/students'],
    ['an absolute URL', 'https://evil.example/coach/students'],
    ['a relative path', 'coach/students'],
  ])('goes home for %s', (_label, from) => {
    expect(returnPathFor('coach', from)).toBe('/coach');
  });
});

describe('loginState', () => {
  it('carries the path and the query', () => {
    expect(loginState({ pathname: '/coach/students/a1', search: '?program=p2' })).toEqual({
      from: '/coach/students/a1?program=p2',
    });
    expect(loginState({ pathname: '/student', search: '' })).toEqual({ from: '/student' });
  });
});
