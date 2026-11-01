import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTelegramError, isRetryableTelegramError } from '../src/services/telegramErrors.ts';

test('classifies Telegram rate limits and retry_after values', () => {
  const info = classifyTelegramError({
    response: { error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } },
  });
  assert.equal(info.kind, 'rate_limit');
  assert.equal(info.retryAfterSeconds, 7);
  assert.equal(isRetryableTelegramError(info), true);
});

test('distinguishes blocked users from invalid chat identifiers', () => {
  assert.equal(classifyTelegramError({ response: { error_code: 403, description: 'bot was blocked by the user' } }).kind, 'blocked');
  assert.equal(classifyTelegramError({ response: { error_code: 400, description: 'chat not found' } }).kind, 'invalid_chat');
});

test('does not retry permanent Telegram errors', () => {
  assert.equal(isRetryableTelegramError(classifyTelegramError({ response: { error_code: 400, description: 'message is too long' } })), false);
  assert.equal(isRetryableTelegramError(classifyTelegramError(new Error('ETIMEDOUT'))), true);
});

test('classifies Telegram connection resets and server errors as retryable', () => {
  assert.equal(classifyTelegramError(new Error('read ECONNRESET')).kind, 'timeout');
  assert.equal(classifyTelegramError(new Error('connect ENETUNREACH')).kind, 'network');
  assert.equal(classifyTelegramError({ response: { error_code: 502, description: 'Bad Gateway' } }).kind, 'network');
});
