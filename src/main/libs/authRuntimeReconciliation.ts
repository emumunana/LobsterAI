import {
  AuthRuntimeErrorCode,
  AuthRuntimePhase,
  type AuthRuntimeState,
  type AuthRuntimeTrigger,
  createInitialAuthRuntimeState,
} from '../../shared/auth/constants';
import type { ServerModelMetadata } from './claudeSettings';
import {
  getServerModelRuntimeFingerprint,
  type ServerModelCatalogEntry,
} from './serverModelCatalog';

export interface AuthRuntimeApplyResult {
  success: boolean;
  error?: string;
  errorCode?: AuthRuntimeErrorCode;
}

export interface AuthRuntimeReconciliationResult {
  success: boolean;
  generation: number;
  models?: ServerModelCatalogEntry[];
  stale?: boolean;
  error?: string;
  errorCode?: AuthRuntimeErrorCode;
}

interface AuthRuntimeReconciliationDeps {
  fetchModels: () => Promise<ServerModelCatalogEntry[]>;
  getCachedModels: () => ServerModelMetadata[];
  updateCachedModels: (models: ServerModelCatalogEntry[]) => void;
  applyRuntimeConfig: (options: {
    generation: number;
    runtimeCatalogChanged: boolean;
  }) => Promise<AuthRuntimeApplyResult>;
  onStateChange?: (state: AuthRuntimeState) => void;
  now?: () => number;
}

type ActiveReconciliation = {
  generation: number;
  promise: Promise<AuthRuntimeReconciliationResult>;
};

export class AuthRuntimeReconciliation {
  private readonly deps: AuthRuntimeReconciliationDeps;
  private state = createInitialAuthRuntimeState();
  private active: ActiveReconciliation | null = null;
  private generation = 0;

  constructor(deps: AuthRuntimeReconciliationDeps) {
    this.deps = deps;
  }

  getState(): AuthRuntimeState {
    return { ...this.state };
  }

  getActivePromise(): Promise<AuthRuntimeReconciliationResult> | null {
    return this.active?.promise ?? null;
  }

  start(trigger: AuthRuntimeTrigger): ActiveReconciliation {
    const generation = ++this.generation;
    const startedAt = this.now();
    this.setState({
      generation,
      phase: AuthRuntimePhase.LoadingModels,
      trigger,
      startedAt,
      completedAt: null,
      modelCount: 0,
      errorCode: null,
      error: null,
      canRetry: false,
    });

    const promise = this.run(generation, trigger, startedAt).finally(() => {
      if (this.active?.generation === generation) {
        this.active = null;
      }
    });
    this.active = { generation, promise };
    return this.active;
  }

  cancel(): void {
    ++this.generation;
    this.active = null;
    this.setState(createInitialAuthRuntimeState());
  }

  private async run(
    generation: number,
    trigger: AuthRuntimeTrigger,
    startedAt: number,
  ): Promise<AuthRuntimeReconciliationResult> {
    let models: ServerModelCatalogEntry[];
    try {
      models = await this.deps.fetchModels();
    } catch (error) {
      return this.fail(
        generation,
        trigger,
        startedAt,
        AuthRuntimeErrorCode.ModelsFetchFailed,
        error,
      );
    }

    if (!this.isCurrent(generation)) {
      return { success: false, generation, stale: true };
    }

    const runtimeCatalogChanged = getServerModelRuntimeFingerprint(this.deps.getCachedModels())
      !== getServerModelRuntimeFingerprint(models);
    this.deps.updateCachedModels(models);
    this.setState({
      generation,
      phase: AuthRuntimePhase.ApplyingConfig,
      trigger,
      startedAt,
      completedAt: null,
      modelCount: models.length,
      errorCode: null,
      error: null,
      canRetry: false,
    });

    await Promise.resolve();
    if (!this.isCurrent(generation)) {
      return { success: false, generation, stale: true };
    }
    this.setState({
      ...this.state,
      phase: AuthRuntimePhase.RestartingGateway,
    });

    let applyResult: AuthRuntimeApplyResult;
    try {
      applyResult = await this.deps.applyRuntimeConfig({
        generation,
        runtimeCatalogChanged,
      });
    } catch (error) {
      return this.fail(
        generation,
        trigger,
        startedAt,
        AuthRuntimeErrorCode.ConfigApplyFailed,
        error,
        models,
      );
    }

    if (!this.isCurrent(generation)) {
      return { success: false, generation, stale: true };
    }
    if (!applyResult.success) {
      return this.fail(
        generation,
        trigger,
        startedAt,
        applyResult.errorCode ?? AuthRuntimeErrorCode.ConfigApplyFailed,
        applyResult.error || 'OpenClaw runtime reconciliation failed.',
        models,
      );
    }

    this.setState({
      generation,
      phase: AuthRuntimePhase.Ready,
      trigger,
      startedAt,
      completedAt: this.now(),
      modelCount: models.length,
      errorCode: null,
      error: null,
      canRetry: false,
    });
    return { success: true, generation, models };
  }

  private fail(
    generation: number,
    trigger: AuthRuntimeTrigger,
    startedAt: number,
    errorCode: AuthRuntimeErrorCode,
    error: unknown,
    models?: ServerModelCatalogEntry[],
  ): AuthRuntimeReconciliationResult {
    const message = error instanceof Error ? error.message : String(error);
    if (this.isCurrent(generation)) {
      this.setState({
        generation,
        phase: AuthRuntimePhase.Failed,
        trigger,
        startedAt,
        completedAt: this.now(),
        modelCount: models?.length ?? 0,
        errorCode,
        error: message,
        canRetry: true,
      });
    }
    return {
      success: false,
      generation,
      models,
      error: message,
      errorCode,
      stale: !this.isCurrent(generation),
    };
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private setState(state: AuthRuntimeState): void {
    this.state = { ...state };
    this.deps.onStateChange?.(this.getState());
  }
}
