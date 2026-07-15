import { describe, expect, test } from 'vitest';

import {
  classifyServerModelCatalogChange,
  parseServerModelCatalogResponse,
  ServerModelCatalogChange,
  type ServerModelCatalogEntry,
} from './serverModelCatalog';

const model = (
  overrides: Partial<ServerModelCatalogEntry> = {},
): ServerModelCatalogEntry => ({
  modelId: 'model-a',
  modelName: 'Model A',
  provider: 'provider-a',
  apiFormat: 'openai-completions',
  supportsImage: false,
  supportsThinking: true,
  contextWindow: 128_000,
  explicitContextCache: false,
  costMultiplier: 1,
  description: 'Default description',
  accessible: true,
  ...overrides,
});

describe('parseServerModelCatalogResponse', () => {
  test('parses runtime and renderer metadata', () => {
    expect(parseServerModelCatalogResponse({ code: 0, data: [model()] })).toEqual([model()]);
  });

  test('rejects an empty catalog', () => {
    expect(() => parseServerModelCatalogResponse({ code: 0, data: [] }))
      .toThrow('empty model catalog');
  });

  test('rejects duplicate model ids', () => {
    expect(() => parseServerModelCatalogResponse({ code: 0, data: [model(), model()] }))
      .toThrow('duplicate modelId');
  });
});

describe('classifyServerModelCatalogChange', () => {
  test('ignores ordering differences', () => {
    const first = model();
    const second = model({ modelId: 'model-b', modelName: 'Model B' });
    expect(classifyServerModelCatalogChange([first, second], [second, first]))
      .toBe(ServerModelCatalogChange.None);
  });

  test('classifies descriptive metadata as UI-only', () => {
    expect(classifyServerModelCatalogChange(
      [model()],
      [model({ description: 'Updated description', costMultiplier: 2 })],
    )).toBe(ServerModelCatalogChange.UiOnly);
  });

  test('classifies a description-only field as UI-only when cost metadata is absent', () => {
    const previous = model({ costMultiplier: undefined, description: undefined });
    delete previous.costMultiplier;
    delete previous.description;
    const next = { ...previous, description: 'New description' };

    expect(classifyServerModelCatalogChange([previous], [next]))
      .toBe(ServerModelCatalogChange.UiOnly);
  });

  test('classifies allowlist metadata as a runtime change', () => {
    expect(classifyServerModelCatalogChange(
      [model()],
      [model({ supportsImage: true })],
    )).toBe(ServerModelCatalogChange.Runtime);
  });
});
