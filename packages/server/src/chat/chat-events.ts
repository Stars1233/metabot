import type * as http from 'node:http';
import type { ChatLiveEvent } from './chat-types.js';

/** Lightweight in-process SSE hub for personal chat clients. */
export class ChatEventHub {
  private readonly listeners = new Set<(event: ChatLiveEvent) => void>();

  publish(event: ChatLiveEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* closed clients are harmless */
      }
    }
  }

  stream(req: http.IncomingMessage, res: http.ServerResponse, conversationId: string, _userRef: string): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    const listener = (event: ChatLiveEvent) => {
      if (event.conversationId === conversationId) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    this.listeners.add(listener);
    const close = () => this.listeners.delete(listener);
    req.on('close', close);
    res.on('close', close);
  }
}
