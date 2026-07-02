import { beforeEach, describe, expect, test, vi } from 'vitest';

const { registeredHandlers } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    }),
  },
}));

import { IpcChannel as ScheduledTaskIpc } from '../../../scheduledTask/constants';
import type { CronJobService } from '../../../scheduledTask/cronJobService';
import { OpenClawEnginePhase } from '../../../shared/openclawEngine/constants';
import { registerScheduledTaskHandlers, type ScheduledTaskHandlerDeps } from './handlers';

function makeDeps(enginePhase: OpenClawEnginePhase = OpenClawEnginePhase.Running) {
  let gatewayClient: unknown = null;
  const cronJobService = {
    listJobs: vi.fn(async () => []),
    listAllRuns: vi.fn(async () => []),
  };
  const adapter = {
    getGatewayClient: vi.fn(() => gatewayClient),
    getEngineStatusSnapshot: vi.fn(() => ({ phase: enginePhase })),
    connectGatewayIfNeeded: vi.fn(async () => {
      gatewayClient = {};
    }),
    fetchSessionByKey: vi.fn(async () => null),
  };
  const deps: ScheduledTaskHandlerDeps = {
    getCronJobService: () => cronJobService as unknown as CronJobService,
    getIMGatewayManager: () => null,
    getOpenClawRuntimeAdapter: () => adapter,
  };

  return { adapter, cronJobService, deps };
}

beforeEach(() => {
  registeredHandlers.clear();
});

describe('registerScheduledTaskHandlers', () => {
  test('connects the gateway client before listing scheduled tasks', async () => {
    const { adapter, cronJobService, deps } = makeDeps();
    registerScheduledTaskHandlers(deps);

    const handler = registeredHandlers.get(ScheduledTaskIpc.List);
    expect(handler).toBeDefined();

    const result = await handler?.();

    expect(adapter.connectGatewayIfNeeded).toHaveBeenCalledTimes(1);
    expect(cronJobService.listJobs).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, ready: true, tasks: [] });
  });

  test('connects the gateway client before listing scheduled task history', async () => {
    const { adapter, cronJobService, deps } = makeDeps();
    registerScheduledTaskHandlers(deps);

    const handler = registeredHandlers.get(ScheduledTaskIpc.ListAllRuns);
    expect(handler).toBeDefined();

    const result = await handler?.(undefined, 20, 0);

    expect(adapter.connectGatewayIfNeeded).toHaveBeenCalledTimes(1);
    expect(cronJobService.listAllRuns).toHaveBeenCalledWith(20, 0, undefined);
    expect(result).toEqual({ success: true, ready: true, runs: [] });
  });

  test('reports not-ready without blocking while the engine is still starting', async () => {
    const { adapter, cronJobService, deps } = makeDeps(OpenClawEnginePhase.Starting);
    registerScheduledTaskHandlers(deps);

    const handler = registeredHandlers.get(ScheduledTaskIpc.List);
    const result = await handler?.();

    expect(adapter.connectGatewayIfNeeded).not.toHaveBeenCalled();
    expect(cronJobService.listJobs).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, ready: false, tasks: [] });
  });
});
