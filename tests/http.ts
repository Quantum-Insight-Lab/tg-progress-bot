import { request } from 'node:http';

export function httpStatus(port: number, method: string, path: string, body: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode ?? 0));
    });
    req.once('error', reject);
    req.end(body);
  });
}

export function httpExchange(
  port: number,
  method: string,
  path: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      void (async () => {
        for await (const chunk of res) chunks.push(Buffer.from(chunk));
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      })().catch(reject);
    });
    req.once('error', reject);
    req.end(body);
  });
}
