import { io } from 'socket.io-client';

const devApiUrl = `${window.location.protocol}//${window.location.hostname}:3001`;

const socketUrl = import.meta.env.PROD
  ? window.location.origin
  : devApiUrl;

export const socket = io(socketUrl, {
  transports: ['websocket', 'polling']
});

export const apiBase = import.meta.env.PROD
  ? ''
  : devApiUrl;

export async function api(path, options = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(json.error || `Request failed: ${res.status}`);
  }

  return json;
}
