import {
  CLASSIFIER_API_BASE,
  CLASSIFIER_API_KEY,
  CLASSIFIER_MODEL,
} from './config.js';
import { logger } from './logger.js';

interface ClassifierResponse {
  continuation: boolean;
  confidence: number;
}

const CLASSIFIER_TIMEOUT_MS = 10000;
const CONFIDENCE_THRESHOLD = 0.85;

const SYSTEM_PROMPT = `You are a task boundary detector. Given a conversation history and a new message, determine whether the new message is a CONTINUATION of the previous task or the START of a new, unrelated task.

Respond with a JSON object only, no other text:
{"continuation": true/false, "confidence": 0.0-1.0}

Guidelines:
- continuation=true: follow-up questions, clarifications, related requests, corrections
- continuation=false: completely new topic, different task domain, explicit "new task" language
- Be conservative: when in doubt, mark as continuation
- confidence: how sure you are (0.85+ means high confidence)`;

export function isClassifierEnabled(): boolean {
  return !!(CLASSIFIER_API_BASE && CLASSIFIER_API_KEY);
}

/**
 * Call the classifier API to determine if a new message starts a new task.
 * Returns the raw classification result. On error, defaults to continuation.
 */
export async function classifyTaskBoundary(
  recentHistory: string,
  newMessage: string,
): Promise<ClassifierResponse> {
  if (!isClassifierEnabled()) {
    return { continuation: true, confidence: 1.0 };
  }

  const userPrompt = `Previous conversation:\n${recentHistory || '(no history)'}\n\nNew message:\n${newMessage}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      CLASSIFIER_TIMEOUT_MS,
    );

    const response = await fetch(
      `${CLASSIFIER_API_BASE}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CLASSIFIER_API_KEY}`,
        },
        body: JSON.stringify({
          model: CLASSIFIER_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0,
          max_tokens: 50,
        }),
        signal: controller.signal,
      },
    );

    clearTimeout(timeout);

    if (!response.ok) {
      logger.warn(
        { status: response.status },
        'Classifier API returned non-OK status',
      );
      return { continuation: true, confidence: 1.0 };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      logger.warn('Classifier returned empty content');
      return { continuation: true, confidence: 1.0 };
    }

    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn({ content }, 'Classifier response has no JSON');
      return { continuation: true, confidence: 1.0 };
    }

    const parsed = JSON.parse(jsonMatch[0]) as ClassifierResponse;
    if (typeof parsed.continuation !== 'boolean' || typeof parsed.confidence !== 'number') {
      logger.warn({ parsed }, 'Classifier returned invalid shape');
      return { continuation: true, confidence: 1.0 };
    }

    return parsed;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      logger.warn('Classifier API timed out');
    } else {
      logger.warn({ err }, 'Classifier API error');
    }
    return { continuation: true, confidence: 1.0 };
  }
}

/**
 * Determine if we should rotate the session for a new task.
 * Only returns true when the classifier is confident it's a new task.
 */
export async function shouldRotateForNewTask(
  recentHistory: string,
  newMessage: string,
): Promise<boolean> {
  const result = await classifyTaskBoundary(recentHistory, newMessage);
  const shouldRotate =
    !result.continuation && result.confidence >= CONFIDENCE_THRESHOLD;

  if (shouldRotate) {
    logger.info(
      { confidence: result.confidence },
      'Classifier detected new task, recommending rotation',
    );
  }

  return shouldRotate;
}
