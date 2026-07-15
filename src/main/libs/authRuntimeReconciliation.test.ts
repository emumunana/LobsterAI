import { describe, expect, test, vi } from 'vitest';

import {
  AuthRuntimeErrorCode,
  AuthRuntimePhase,
  AuthRuntimeTrigger,
} from '../../shared/auth/constants';
import { AuthRuntimeReconciliation } from './authRuntimeReconciliation';
import type { ServerModelCatalogEntry } from './serverModelCatalog';

const model = (modelId: string): ServerModelCatalogEntry => ({
  modelId,
  modelName: modelId,
  provider: 'provider',
  apiFormat: 'openai-completions',
  accessible: true,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('AuthRuntimeReconciliation', () => {
  test('waits for models before updating config and completes one apply', async () => {
    const models = deferred<ServerModelCatalogEntry[]>();
    const events: string[] = [];
    const applyRuntimeConfig = vi.fn(async () => {
      events.push('apply');
      return { success: true };
    });
    const reconciliation = new AuthRuntimeReconciliation({
      fetchModels: async () => models.promise,
      getCachedModels: () => [],
      updateCachedModels: () => events.push('cache'),
      applyRuntimeConfig,
      onStateChange: state => events.push(state.phase),
    });

    const active = reconciliation.start(AuthRuntimeTrigger.Login);
    expect(reconciliation.getActivePromise()).toBe(active.promise);
    expect(applyRuntimeConfig).not.toHaveBeenCalled();

    models.resolve([model('model-a')]);
    await expect(active.promise).resolves.toMatchObject({ success: true });

    expect(events).toEqual([
      AuthRuntimePhase.LoadingModels,
      'cache',
      AuthRuntimePhase.ApplyingConfig,
      AuthRuntimePhase.RestartingGateway,
      'apply',
      AuthRuntimePhase.Ready,
    ]);
    expect(applyRuntimeConfig).toHaveBeenCalledTimes(1);
  });

  test('ignores a stale generation that finishes after a newer login', async () => {
    const firstModels = deferred<ServerModelCatalogEntry[]>();
    const secondModels = deferred<ServerModelCatalogEntry[]>();
    const fetchModels = vi.fn()
      .mockImplementationOnce(async () => firstModels.promise)
      .mockImplementationOnce(async () => secondModels.promise);
    const appliedModels: string[][] = [];
    let cachedModels: ServerModelCatalogEntry[] = [];
    const reconciliation = new AuthRuntimeReconciliation({
      fetchModels,
      getCachedModels: () => cachedModels,
      updateCachedModels: models => {
        cachedModels = models;
        appliedModels.push(models.map(entry => entry.modelId));
      },
      applyRuntimeConfig: async () => ({ success: true }),
    });

    const first = reconciliation.start(AuthRuntimeTrigger.Login);
    const second = reconciliation.start(AuthRuntimeTrigger.Login);
    secondModels.resolve([model('new-model')]);
    await expect(second.promise).resolves.toMatchObject({ success: true });
    firstModels.resolve([model('old-model')]);
    await expect(first.promise).resolves.toMatchObject({ stale: true });

    expect(appliedModels).toEqual([['new-model']]);
    expect(reconciliation.getState()).toMatchObject({
      generation: second.generation,
      phase: AuthRuntimePhase.Ready,
    });
  });

  test('does not apply config when model loading fails', async () => {
    const applyRuntimeConfig = vi.fn(async () => ({ success: true }));
    const reconciliation = new AuthRuntimeReconciliation({
      fetchModels: async () => {
        throw new Error('network down');
      },
      getCachedModels: () => [],
      updateCachedModels: vi.fn(),
      applyRuntimeConfig,
    });

    await expect(reconciliation.start(AuthRuntimeTrigger.Login).promise).resolves.toMatchObject({
      success: false,
      errorCode: AuthRuntimeErrorCode.ModelsFetchFailed,
    });
    expect(applyRuntimeConfig).not.toHaveBeenCalled();
    expect(reconciliation.getState()).toMatchObject({
      phase: AuthRuntimePhase.Failed,
      canRetry: true,
    });
  });

  test('surfaces config application failure without declaring ready', async () => {
    const reconciliation = new AuthRuntimeReconciliation({
      fetchModels: async () => [model('model-a')],
      getCachedModels: () => [],
      updateCachedModels: vi.fn(),
      applyRuntimeConfig: async () => ({
        success: false,
        error: 'gateway restart failed',
        errorCode: AuthRuntimeErrorCode.GatewayRestartFailed,
      }),
    });

    await expect(reconciliation.start(AuthRuntimeTrigger.Login).promise).resolves.toMatchObject({
      success: false,
      errorCode: AuthRuntimeErrorCode.GatewayRestartFailed,
    });
    expect(reconciliation.getState().phase).toBe(AuthRuntimePhase.Failed);
  });
});
