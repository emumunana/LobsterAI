import { expect, test } from 'vitest';

import type { Artifact } from '../../types/artifact';
import type { RootState } from '..';
import artifactReducer, { selectSessionArtifacts, setSessionArtifacts } from './artifactSlice';

const makeVideoArtifact = (id: string, filePath: string): Artifact => ({
  id,
  messageId: `message-${id}`,
  sessionId: 'session-1',
  type: 'video',
  title: 'generated-video-20260522-171920-1.mp4',
  content: '',
  fileName: 'generated-video-20260522-171920-1.mp4',
  filePath,
  createdAt: 1,
});

test('setSessionArtifacts dedupes generated videos by file path', () => {
  const state = artifactReducer(undefined, setSessionArtifacts({
    sessionId: 'session-1',
    artifacts: [
      makeVideoArtifact('video-file-url', 'file:///Users/admin/work/test0522/generated-video-20260522-171920-1.mp4'),
      makeVideoArtifact('video-local-path', '/Users/admin/work/test0522/generated-video-20260522-171920-1.mp4'),
    ],
  }));

  expect(state.artifactsBySession['session-1']).toHaveLength(1);
  expect(state.artifactsBySession['session-1'][0].id).toBe('video-local-path');
});

test('selectSessionArtifacts hides duplicate generated videos from stale state', () => {
  const rootState = {
    artifact: {
      artifactsBySession: {
        'session-1': [
          makeVideoArtifact('video-a', '/Users/admin/work/test0522/generated-video-20260522-171920-1.mp4'),
          makeVideoArtifact('video-b', '/Users/admin/work/test0522/generated-video-20260522-171920-1.mp4'),
        ],
      },
      previewTabsBySession: {},
      activePreviewTabIdBySession: {},
      selectedArtifactId: null,
      isPanelOpen: false,
      panelWidth: 560,
    },
  } as unknown as RootState;

  expect(selectSessionArtifacts(rootState, 'session-1')).toHaveLength(1);
});
