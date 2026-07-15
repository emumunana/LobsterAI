import type { ServerModelMetadata } from './claudeSettings';

export interface ServerModelCatalogEntry extends ServerModelMetadata {
  modelName: string;
  provider: string;
  apiFormat: string;
  costMultiplier?: number;
  description?: string;
  accessible?: boolean;
  restrictionHint?: string;
}

export const ServerModelCatalogChange = {
  None: 'none',
  UiOnly: 'ui_only',
  Runtime: 'runtime',
} as const;

export type ServerModelCatalogChange =
  typeof ServerModelCatalogChange[keyof typeof ServerModelCatalogChange];

const readRequiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Server model ${field} is missing.`);
  }
  return value.trim();
};

const readOptionalString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

const readOptionalNumber = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

const readOptionalBoolean = (value: unknown): boolean | undefined => (
  typeof value === 'boolean' ? value : undefined
);

const parseServerModelEntry = (value: unknown): ServerModelCatalogEntry => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Server model entry must be an object.');
  }
  const source = value as Record<string, unknown>;
  return {
    modelId: readRequiredString(source.modelId, 'modelId'),
    modelName: readRequiredString(source.modelName, 'modelName'),
    provider: readRequiredString(source.provider, 'provider'),
    apiFormat: readRequiredString(source.apiFormat, 'apiFormat'),
    supportsImage: readOptionalBoolean(source.supportsImage),
    supportsThinking: readOptionalBoolean(source.supportsThinking),
    explicitContextCache: readOptionalBoolean(source.explicitContextCache),
    contextWindow: readOptionalNumber(source.contextWindow),
    costMultiplier: readOptionalNumber(source.costMultiplier),
    description: readOptionalString(source.description),
    accessible: readOptionalBoolean(source.accessible),
    restrictionHint: readOptionalString(source.restrictionHint),
  };
};

export function parseServerModelCatalogResponse(value: unknown): ServerModelCatalogEntry[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Server model response must be an object.');
  }
  const response = value as { code?: unknown; message?: unknown; data?: unknown };
  if (response.code !== 0) {
    throw new Error(readOptionalString(response.message) || 'Server rejected the model catalog request.');
  }
  if (!Array.isArray(response.data) || response.data.length === 0) {
    throw new Error('Server returned an empty model catalog.');
  }

  const models = response.data.map(parseServerModelEntry);
  const modelIds = new Set<string>();
  for (const model of models) {
    if (modelIds.has(model.modelId)) {
      throw new Error(`Server model catalog contains duplicate modelId: ${model.modelId}`);
    }
    modelIds.add(model.modelId);
  }
  return models;
}

export async function fetchServerModelCatalog(options: {
  url: string;
  fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>;
  requestOptions?: RequestInit;
}): Promise<ServerModelCatalogEntry[]> {
  const response = await options.fetchWithAuth(options.url, options.requestOptions);
  if (!response.ok) {
    throw new Error(`Server model request failed: HTTP ${response.status}`);
  }
  return parseServerModelCatalogResponse(await response.json());
}

const stableSerialize = (models: ServerModelMetadata[], includeUiMetadata: boolean): string => (
  JSON.stringify(
    models
      .map((model) => ({
        modelId: model.modelId,
        modelName: model.modelName,
        provider: model.provider,
        apiFormat: model.apiFormat,
        supportsImage: model.supportsImage,
        supportsThinking: model.supportsThinking,
        contextWindow: model.contextWindow,
        explicitContextCache: model.explicitContextCache,
        ...(includeUiMetadata
          ? {
            costMultiplier: (model as ServerModelCatalogEntry).costMultiplier,
            description: (model as ServerModelCatalogEntry).description,
            accessible: (model as ServerModelCatalogEntry).accessible,
            restrictionHint: (model as ServerModelCatalogEntry).restrictionHint,
          }
          : {}),
      }))
      .sort((a, b) => a.modelId.localeCompare(b.modelId)),
  )
);

export const getServerModelRuntimeFingerprint = (models: ServerModelMetadata[]): string => (
  stableSerialize(models, false)
);

export const getServerModelUiFingerprint = (models: ServerModelCatalogEntry[]): string => (
  stableSerialize(models, true)
);

export function classifyServerModelCatalogChange(
  previous: ServerModelCatalogEntry[],
  next: ServerModelCatalogEntry[],
): ServerModelCatalogChange {
  if (getServerModelRuntimeFingerprint(previous) !== getServerModelRuntimeFingerprint(next)) {
    return ServerModelCatalogChange.Runtime;
  }
  if (getServerModelUiFingerprint(previous) !== getServerModelUiFingerprint(next)) {
    return ServerModelCatalogChange.UiOnly;
  }
  return ServerModelCatalogChange.None;
}
