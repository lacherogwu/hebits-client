import { expect, test } from 'vitest';
import { VERSION } from '../src/index.js';

test('the package exports something and the toolchain runs', () => {
  expect(VERSION).toBe('0.1.0');
});
