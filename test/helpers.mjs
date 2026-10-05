import { readFileSync } from 'node:fs';

export const fixture = (name) => JSON.parse(readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8'));
export const projectFile = (name) => readFileSync(new URL('../' + name, import.meta.url), 'utf8');

export const jsonResponse = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fetch() that answers from a recorded session of real JSON-RPC exchanges. */
export function replay(recorded, { drop = () => false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const request = JSON.parse(init.body);
    calls.push({ url, request, headers: init.headers });
    const match = recorded.exchanges.find(
      (item) => item.method === request.method && JSON.stringify(item.params) === JSON.stringify(request.params) && !drop(item),
    );
    if (!match) {
      return jsonResponse({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: `not recorded: ${request.method}` } });
    }
    return jsonResponse({ ...match.response, id: request.id });
  };
  return { fetchImpl, calls };
}

/** Options that make the client instant in tests: no throttle, no real sleeping. */
export const fast = { minIntervalMs: 0, sleep: async () => {}, userAgent: 'test-agent' };
