import { expect, test } from 'vitest';
import { ApiError, HebitsError, LoginExpiredError, NotATorrentError, RateLimitedError } from '../src/errors';

test('every error is a HebitsError and an Error', () => {
  for (const e of [
    new LoginExpiredError('cookie rejected'),
    new RateLimitedError('slow down'),
    new ApiError('bad status'),
    new NotATorrentError('got HTML'),
  ]) {
    expect(e).toBeInstanceOf(HebitsError);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBeTruthy();
  }
});

test('each error carries its own name, so logs are readable', () => {
  expect(new LoginExpiredError('x').name).toBe('LoginExpiredError');
  expect(new ApiError('x').name).toBe('ApiError');
});

test('a cause can be attached and survives', () => {
  const cause = new Error('socket hang up');
  expect(new ApiError('wrapped', { cause }).cause).toBe(cause);
});

test('errors are distinguishable by class, which is how consumers branch', () => {
  const e: HebitsError = new LoginExpiredError('x');
  expect(e instanceof LoginExpiredError).toBe(true);
  expect(e instanceof RateLimitedError).toBe(false);
});
