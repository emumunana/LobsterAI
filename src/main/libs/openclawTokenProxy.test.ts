import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
}));

import {
  __openClawTokenProxyTestUtils,
  consumeRecentOpenClawTokenProxyQuotaError,
} from './openclawTokenProxy';

const testUtils = __openClawTokenProxyTestUtils;

beforeEach(() => {
  consumeRecentOpenClawTokenProxyQuotaError();
});

test('extracts LobsterAI monthly quota error from proxy SSE packet', () => {
  const packet = [
    'event: error',
    'data: {"type":"error","error":{"type":"proxy_error","message":"本月积分已用完","code":40202}}',
  ].join('\n');

  expect(testUtils.extractQuotaErrorFromProxySSEPacket(packet)).toEqual({
    message: '本月积分已用完',
    code: 40202,
  });
});

test('ignores generic HTTP 402 without LobsterAI quota code or message', () => {
  const packet = [
    'event: error',
    'data: {"error":{"message":"Request failed with status 402"}}',
  ].join('\n');

  expect(testUtils.extractQuotaErrorFromProxySSEPacket(packet)).toBeNull();
});

test('scans split SSE chunks and stores a recent quota error', () => {
  const now = 1_000;
  let buffer = testUtils.scanProxySSEBufferForQuotaError(
    'event: error\ndata: {"type":"error","error":{"message":"本月',
    now,
  );

  buffer = testUtils.scanProxySSEBufferForQuotaError(
    `${buffer}积分已用完","code":40202}}\n\n`,
    now + 1,
  );

  expect(buffer).toBe('');
  expect(consumeRecentOpenClawTokenProxyQuotaError(now + 2)).toEqual({
    message: '本月积分已用完',
    code: 40202,
    capturedAt: now + 1,
  });
});

test('expires stale remembered quota errors', () => {
  testUtils.rememberQuotaError({ message: '本月积分已用完', code: 40202 }, 1_000);

  expect(consumeRecentOpenClawTokenProxyQuotaError(32_000)).toBeNull();
});
