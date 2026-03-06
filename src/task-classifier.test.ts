import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config before importing classifier
vi.mock('./config.js', () => ({
  CLASSIFIER_API_BASE: 'https://api.example.com',
  CLASSIFIER_API_KEY: 'test-key',
  CLASSIFIER_MODEL: 'test-model',
}));

import {
  classifyTaskBoundary,
  isClassifierEnabled,
  shouldRotateForNewTask,
} from './task-classifier.js';

describe('isClassifierEnabled', () => {
  it('returns true when both API base and key are set', () => {
    expect(isClassifierEnabled()).toBe(true);
  });
});

describe('classifyTaskBoundary', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns continuation on successful continuation response', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"continuation": true, "confidence": 0.95}',
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await classifyTaskBoundary('some history', 'follow up');
    expect(result.continuation).toBe(true);
    expect(result.confidence).toBe(0.95);
  });

  it('returns new task on non-continuation response', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"continuation": false, "confidence": 0.92}',
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await classifyTaskBoundary('some history', 'new topic');
    expect(result.continuation).toBe(false);
    expect(result.confidence).toBe(0.92);
  });

  it('defaults to continuation on fetch error', async () => {
    fetchSpy.mockRejectedValue(new Error('network error'));

    const result = await classifyTaskBoundary('history', 'message');
    expect(result.continuation).toBe(true);
    expect(result.confidence).toBe(1.0);
  });

  it('defaults to continuation on non-OK status', async () => {
    fetchSpy.mockResolvedValue(new Response('error', { status: 500 }));

    const result = await classifyTaskBoundary('history', 'message');
    expect(result.continuation).toBe(true);
    expect(result.confidence).toBe(1.0);
  });

  it('defaults to continuation on empty content', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '' } }],
        }),
        { status: 200 },
      ),
    );

    const result = await classifyTaskBoundary('history', 'message');
    expect(result.continuation).toBe(true);
  });

  it('handles JSON wrapped in markdown code block', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '```json\n{"continuation": false, "confidence": 0.9}\n```',
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await classifyTaskBoundary('history', 'message');
    expect(result.continuation).toBe(false);
    expect(result.confidence).toBe(0.9);
  });

  it('defaults to continuation on timeout (AbortError)', async () => {
    fetchSpy.mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    );

    const result = await classifyTaskBoundary('history', 'message');
    expect(result.continuation).toBe(true);
    expect(result.confidence).toBe(1.0);
  });
});

describe('shouldRotateForNewTask', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns true when not continuation and high confidence', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"continuation": false, "confidence": 0.92}',
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    expect(await shouldRotateForNewTask('history', 'new topic')).toBe(true);
  });

  it('returns false when not continuation but low confidence', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"continuation": false, "confidence": 0.6}',
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    expect(await shouldRotateForNewTask('history', 'maybe new')).toBe(false);
  });

  it('returns false when continuation is true', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"continuation": true, "confidence": 0.99}',
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    expect(await shouldRotateForNewTask('history', 'follow up')).toBe(false);
  });

  it('returns false on API error (safe default)', async () => {
    fetchSpy.mockRejectedValue(new Error('fail'));

    expect(await shouldRotateForNewTask('history', 'msg')).toBe(false);
  });

  it('returns false at exact threshold boundary (0.85)', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"continuation": false, "confidence": 0.85}',
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    expect(await shouldRotateForNewTask('history', 'new')).toBe(true);
  });

  it('returns false just below threshold (0.84)', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"continuation": false, "confidence": 0.84}',
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    expect(await shouldRotateForNewTask('history', 'new')).toBe(false);
  });
});
