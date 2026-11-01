// The Node adapter behind node's own server: `http.IncomingMessage` and
// `http.ServerResponse` fit the shapes the adapter reads and writes, so its
// documented uses compile in a strict consumer without a cast. Checked in
// its own program (tsconfig.node.json, Node's types on), so the main
// consumer program keeps no Node global a browser consumer lacks.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { toNodeHandler, nodeRequest, writeNodeResponse, type HttpDispatcher, type NodeRequestLike, type NodeResponseLike } from '@jarenjs/contract/node';
import { sealContinuation, openContinuation } from '@jarenjs/contract/continuation-node';
import { hmacSha256Matches } from '@jarenjs/contract/auth-node';

declare const dispatcher: HttpDispatcher;
declare const req: IncomingMessage;
declare const res: ServerResponse;

// the adapter's documented use
const server: Server = createServer(toNodeHandler(dispatcher));
// node's own request and response, as the structural shapes
const request: NodeRequestLike = req;
const response: NodeResponseLike = res;
// a framework route that dispatches itself (Fastify's `req.raw` and
// `reply.raw`), then writes with the adapter's own writer
const incoming = nodeRequest(dispatcher, req, res);
void dispatcher.dispatch(incoming).then((answer) => writeNodeResponse(res, answer, { from: incoming }));
// a response double whose `writeHead` takes read-only lists still fits
const double: NodeResponseLike = {
  writeHead: (status: number, headers?: Record<string, string | readonly string[]>) => [status, headers],
  end: () => undefined,
  on: () => undefined,
};
// node:crypto's Buffer keys fit the Node-side continuation and signature helpers
const token = sealContinuation({ after: 1 }, { scope: 'tenant', query: 'q', order: ['id'], now: 0, keyId: 'k1', key: randomBytes(32), expiresAt: 1000 });
const opened: unknown = openContinuation(token, { scope: 'tenant', query: 'q', order: ['id'], now: () => 0, getKey: () => randomBytes(32) });
const signed: boolean = hmacSha256Matches(randomBytes(32), 'body', createHmac('sha256', 'key').digest());
void [server, request, response, double, opened, signed];
