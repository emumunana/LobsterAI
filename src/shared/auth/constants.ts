export const AuthIpcChannel = {
  Login: 'auth:login',
  Exchange: 'auth:exchange',
  GetUser: 'auth:getUser',
  GetQuota: 'auth:getQuota',
  Logout: 'auth:logout',
  RefreshToken: 'auth:refreshToken',
  GetAccessToken: 'auth:getAccessToken',
  GetModels: 'auth:getModels',
  GetRuntimeState: 'auth:getRuntimeState',
  RetryRuntimeReconciliation: 'auth:retryRuntimeReconciliation',
  RuntimeStateChanged: 'auth:runtimeStateChanged',
  QuotaChanged: 'auth:quotaChanged',
  Callback: 'auth:callback',
  GetPricingCatalog: 'auth:getPricingCatalog',
  GetPendingCallback: 'auth:getPendingCallback',
} as const;

export type AuthIpcChannel = typeof AuthIpcChannel[keyof typeof AuthIpcChannel];

export const AuthSubscriptionStatus = {
  Active: 'active',
  Free: 'free',
} as const;

export type AuthSubscriptionStatus = typeof AuthSubscriptionStatus[keyof typeof AuthSubscriptionStatus];

export const AuthRuntimePhase = {
  Idle: 'idle',
  LoadingModels: 'loading_models',
  ApplyingConfig: 'applying_config',
  RestartingGateway: 'restarting_gateway',
  Ready: 'ready',
  Failed: 'failed',
} as const;

export type AuthRuntimePhase = typeof AuthRuntimePhase[keyof typeof AuthRuntimePhase];

export const AuthRuntimeErrorCode = {
  ModelsFetchFailed: 'models_fetch_failed',
  ConfigApplyFailed: 'config_apply_failed',
  GatewayRestartFailed: 'gateway_restart_failed',
} as const;

export type AuthRuntimeErrorCode = typeof AuthRuntimeErrorCode[keyof typeof AuthRuntimeErrorCode];

export const AuthRuntimeTrigger = {
  Login: 'login',
  Retry: 'retry',
  AllowlistRecovery: 'allowlist_recovery',
} as const;

export type AuthRuntimeTrigger = typeof AuthRuntimeTrigger[keyof typeof AuthRuntimeTrigger];

export interface AuthRuntimeState {
  generation: number;
  phase: AuthRuntimePhase;
  trigger: AuthRuntimeTrigger | null;
  startedAt: number | null;
  completedAt: number | null;
  modelCount: number;
  errorCode: AuthRuntimeErrorCode | null;
  error: string | null;
  canRetry: boolean;
}

export const createInitialAuthRuntimeState = (): AuthRuntimeState => ({
  generation: 0,
  phase: AuthRuntimePhase.Idle,
  trigger: null,
  startedAt: null,
  completedAt: null,
  modelCount: 0,
  errorCode: null,
  error: null,
  canRetry: false,
});
