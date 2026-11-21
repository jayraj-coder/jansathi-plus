import { Platform } from 'react-native';

export type Language = 'en' | 'hi' | 'gu';
export type DocumentRecord = {
  id: string; title: string; filename: string; file_type: string; mime_type: string;
  size: number; created_at: string; status: 'completed' | 'needs_ocr' | 'no_text';
  language: string; extraction: string; overview: string; text?: string;
};
export type ChatResponse = { answer: string; provider: string; sources: string[] };

const baseUrl = (process.env.EXPO_PUBLIC_API_URL || (Platform.OS === 'android'
  ? 'http://10.0.2.2:8000' : 'http://127.0.0.1:8000')).replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message: string, public status?: number) { super(message); this.name = 'ApiError'; }
}

function documentResponse(value: any): DocumentRecord {
  if (!value || typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.filename !== 'string' ||
      typeof value.file_type !== 'string' || typeof value.status !== 'string' || typeof value.overview !== 'string') {
    throw new ApiError('The server returned an invalid document response.', 502);
  }
  return value as DocumentRecord;
}
function chatResponse(value: any): ChatResponse {
  if (!value || typeof value.answer !== 'string' || typeof value.provider !== 'string' || !Array.isArray(value.sources)) {
    throw new ApiError('The server returned an invalid answer response.', 502);
  }
  return value as ChatResponse;
}

async function jsonRequest<T>(path: string, guestId: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...options, headers: { 'X-Guest-Id': guestId, ...(options.headers || {}) },
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    throw new ApiError(error instanceof Error && error.name === 'TimeoutError'
      ? 'The server took too long to respond. Please try again.'
      : 'Could not reach JanSathi. Check your network and API address.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.detail || `Request failed (${response.status}).`, response.status);
  return data as T;
}

export const api = {
  health: () => fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()),
  documents: async (guestId: string) => {
    const value = await jsonRequest<any>('/api/documents', guestId);
    if (!Array.isArray(value)) throw new ApiError('The server returned an invalid document list.', 502);
    return value.map(documentResponse);
  },
  upload(guestId: string, uri: string, name: string, mime: string, progress: (loaded: number, total: number) => void, uploaded: () => void) {
    return new Promise<DocumentRecord>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', `${baseUrl}/api/documents`);
      request.timeout = 180_000;
      request.setRequestHeader('X-Guest-Id', guestId);
      request.upload.onprogress = event => progress(event.loaded, event.lengthComputable ? event.total : 0);
      request.upload.onload = uploaded;
      request.onerror = () => reject(new ApiError('Upload failed. Check your network and try again.'));
      request.ontimeout = () => reject(new ApiError('Upload timed out. Please retry.'));
      request.onabort = () => reject(new ApiError('Upload was cancelled.'));
      request.onload = () => {
        let data: any;
        try { data = JSON.parse(request.responseText); } catch { data = {}; }
        if (request.status >= 200 && request.status < 300) {
          try { resolve(documentResponse(data)); } catch (error) { reject(error); }
        }
        else reject(new ApiError(data.detail || `Upload failed (${request.status}).`, request.status));
      };
      const form = new FormData();
      form.append('file', { uri, name, type: mime } as any);
      request.send(form);
    });
  },
  detail: async (guestId: string, id: string) => documentResponse(await jsonRequest<any>(`/api/documents/${encodeURIComponent(id)}`, guestId)),
  chat: (guestId: string, message: string, documentId: string, language: Language) =>
    jsonRequest<any>('/api/chat', guestId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, document_id: documentId, language }) }).then(chatResponse),
  overview: (guestId: string, documentId: string, language: Language) =>
    jsonRequest<any>('/api/chat', guestId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      message: 'Explain this document in a short, plain-language overview. State what it is about and mention dates, actions, requirements, or warnings only when the document explicitly contains them. If a category is absent, say it is not stated. Do not add outside information or infer government eligibility.',
      document_id: documentId, language,
    }) }).then(chatResponse),
};

export function getApiBaseUrl() { return baseUrl; }
