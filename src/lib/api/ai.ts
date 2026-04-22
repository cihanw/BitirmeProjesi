/**
 * ai.ts — Phase 7: Mobile client for /api/ai/edit.
 *
 * Usage:
 *   import { editPhotoWithAI } from '@/src/lib/api/ai';
 *   const { url } = await editPhotoWithAI({ prompt: 'Make the sky dramatic', imageUri: 'file://...' });
 */

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL?.trim();

export interface AIEditRequest {
  /** Natural-language editing instruction */
  prompt: string;
  /** Base64 data-URI of the photo (data:image/jpeg;base64,...) */
  imageUri: string;
}

export interface AIEditResult {
  /** Base64 data-URI of the AI-edited image (data:image/png;base64,...) */
  b64: string;
  creditsRemaining: number;
}

export class AIError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'not_configured'
      | 'rate_limited'
      | 'content_policy'
      | 'quota_exceeded'
      | 'unauthorized'
      | 'network_error'
      | 'unknown',
    public readonly creditsRemaining?: number,
  ) {
    super(message);
    this.name = 'AIError';
  }
}

export async function editPhotoWithAI(
  request: AIEditRequest,
  authToken?: string,
): Promise<AIEditResult> {
  if (!BACKEND_URL) {
    throw new AIError(
      'Backend is not configured. Set EXPO_PUBLIC_BACKEND_URL in your .env.',
      'not_configured',
    );
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  let response: Response;

  try {
    response = await fetch(`${BACKEND_URL}/api/ai/edit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt: request.prompt,
        image_uri: request.imageUri,
      }),
    });
  } catch {
    throw new AIError(
      'Could not reach the backend. Make sure the server is running.',
      'network_error',
    );
  }

  if (response.ok) {
    const data = await response.json();
    return {
      b64: data.b64,
      creditsRemaining: data.credits_remaining ?? 0,
    };
  }

  let errorData: Record<string, unknown> = {};
  try { errorData = await response.json(); } catch { /* ignore */ }

  const detail = errorData['detail'];

  if (response.status === 401) {
    throw new AIError('You must be logged in to use AI editing.', 'unauthorized');
  }
  if (response.status === 402) {
    throw new AIError('Gemini quota exceeded. Please check the server billing settings.', 'quota_exceeded');
  }
  if (response.status === 429) {
    const inner = typeof detail === 'object' && detail !== null ? (detail as Record<string, unknown>) : {};
    const remaining = typeof inner['credits_remaining'] === 'number' ? inner['credits_remaining'] : 0;
    throw new AIError(
      typeof inner['message'] === 'string' ? inner['message'] : 'You have used all your AI edits for this hour.',
      'rate_limited',
      remaining,
    );
  }
  if (response.status === 400) {
    const msg = typeof detail === 'string' ? detail : 'Your prompt was rejected by the content safety filter.';
    throw new AIError(msg, 'content_policy');
  }

  throw new AIError(
    typeof detail === 'string' ? detail : `Unexpected error (HTTP ${response.status})`,
    'unknown',
  );
}
