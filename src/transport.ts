/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import http from 'node:http';
import assert from 'node:assert';
import crypto from 'node:crypto';

import debug from 'debug';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
// @ts-ignore - StreamableHTTPServerTransport is not exported in the SDK types
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { AddressInfo } from 'node:net';
import type { Server } from './server.js';
import type { Connection } from './connection.js';

interface Session {
  transport: SSEServerTransport;
  connection: Connection;
  lastSeen: number;
}

export async function startStdioTransport(server: Server) {
  await server.createConnection(new StdioServerTransport());
}

const testDebug = debug('pw:mcp:test');

// Session locking mechanism
const sessionLocks = new Map<string, boolean>();

// Custom SSE transport that allows setting a specific session ID
class ReattachableSSEServerTransport extends SSEServerTransport {
  constructor(endpoint: string, response: http.ServerResponse, sessionId?: string) {
    super(endpoint, response);
    if (sessionId) {
      // Override the sessionId if provided
      (this as any)._sessionId = sessionId;
    }
  }

  get sessionId(): string {
    return (this as any)._sessionId || super.sessionId;
  }
}

async function handleSSE(server: Server, req: http.IncomingMessage, res: http.ServerResponse, url: URL, sessions: Map<string, Session>) {
  if (req.method === 'POST') {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      res.statusCode = 400;
      return res.end('Missing sessionId');
    }

    const session = sessions.get(sessionId);
    if (!session) {
      res.statusCode = 404;
      return res.end('Session not found');
    }

    session.lastSeen = Date.now();
    return await session.transport.handlePostMessage(req, res);
  } else if (req.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId');

    if (sessionId && sessions.has(sessionId)) {
      // Check if session is being reattached
      if (sessionLocks.get(sessionId)) {
        res.statusCode = 423; // Locked
        return res.end('Session is currently being reattached');
      }

      // Lock the session
      sessionLocks.set(sessionId, true);

      try {
        // Reattach to existing session
        const session = sessions.get(sessionId)!;
        session.lastSeen = Date.now();
        testDebug(`reattached SSE session: ${sessionId}`);
        // eslint-disable-next-line no-console
        console.log(`Reattached session: ${sessionId}`);

        // Update the transport's response stream with the same session ID
        const transport = new ReattachableSSEServerTransport('/sse', res, sessionId);
        session.transport = transport;

        res.on('close', () => {
          testDebug(`client disconnected from session: ${sessionId}`);
        });
      } finally {
        // Unlock the session
        sessionLocks.delete(sessionId);
      }
      return;
    }

    // Create new session
    const transport = new ReattachableSSEServerTransport('/sse', res);
    const connection = await server.createConnection(transport);
    const session: Session = {
      transport,
      connection,
      lastSeen: Date.now()
    };

    sessions.set(transport.sessionId, session);
    testDebug(`create SSE session: ${transport.sessionId}`);
    // eslint-disable-next-line no-console
    console.log(`New session: ${transport.sessionId}`);

    res.on('close', () => {
      testDebug(`client disconnected from session: ${transport.sessionId}`);
    });
    return;
  }

  res.statusCode = 405;
  res.end('Method not allowed');
}

async function handleStreamable(server: Server, req: http.IncomingMessage, res: http.ServerResponse, sessions: Map<string, StreamableHTTPServerTransport>) {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId) {
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.statusCode = 404;
      res.end('Session not found');
      return;
    }
    return await transport.handleRequest(req, res);
  }

  if (req.method === 'POST') {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        sessions.set(sessionId, transport);
      }
    });
    transport.onclose = () => {
      if (transport.sessionId)
        sessions.delete(transport.sessionId);
    };
    await server.createConnection(transport);
    await transport.handleRequest(req, res);
    return;
  }

  res.statusCode = 400;
  res.end('Invalid request');
}

export async function startHttpServer(config: { host?: string, port?: number }): Promise<http.Server> {
  const { host, port } = config;
  const httpServer = http.createServer();
  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(port, host, () => {
      resolve();
      httpServer.removeListener('error', reject);
    });
  });
  return httpServer;
}

export function startHttpTransport(httpServer: http.Server, mcpServer: Server) {
  const sseSessions = new Map<string, Session>();
  const streamableSessions = new Map<string, StreamableHTTPServerTransport>();

  // Session cleanup mechanism
  const SESSION_TTL = 30 * 60 * 1000; // 30 minutes
  const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutes

  const cleanupSessions = () => {
    const now = Date.now();
    for (const [sessionId, session] of sseSessions) {
      // Skip sessions that are being reattached
      if (sessionLocks.get(sessionId)) {
        testDebug(`skipping cleanup for session being reattached: ${sessionId}`);
        continue;
      }

      if (now - session.lastSeen > SESSION_TTL) {
        testDebug(`cleaning up idle session: ${sessionId}`);
        // eslint-disable-next-line no-console
        console.log(`Closed idle session: ${sessionId}`);
        sseSessions.delete(sessionId);
        sessionLocks.delete(sessionId);
        // eslint-disable-next-line no-console
        void session.connection.close().catch(e => console.error(e));
      }
    }
  };

  const cleanupInterval = setInterval(cleanupSessions, CLEANUP_INTERVAL);

  httpServer.on('request', async (req, res) => {
    const url = new URL(`http://localhost${req.url}`);
    if (url.pathname.startsWith('/mcp'))
      await handleStreamable(mcpServer, req, res, streamableSessions);
    else
      await handleSSE(mcpServer, req, res, url, sseSessions);
  });

  httpServer.on('close', () => {
    clearInterval(cleanupInterval);
  });

  const url = httpAddressToString(httpServer.address());
  const message = [
    `Listening on ${url}`,
    'Put this in your client config:',
    JSON.stringify({
      'mcpServers': {
        'playwright': {
          'url': `${url}/sse`
        }
      }
    }, undefined, 2),
    'If your client supports streamable HTTP, you can use the /mcp endpoint instead.',
  ].join('\n');
    // eslint-disable-next-line no-console
  console.error(message);
}

export function httpAddressToString(address: string | AddressInfo | null): string {
  assert(address, 'Could not bind server socket');
  if (typeof address === 'string')
    return address;
  const resolvedPort = address.port;
  let resolvedHost = address.family === 'IPv4' ? address.address : `[${address.address}]`;
  if (resolvedHost === '0.0.0.0' || resolvedHost === '[::]')
    resolvedHost = 'localhost';
  return `http://${resolvedHost}:${resolvedPort}`;
}
