import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedDatabase, createRuntimeLogin, type IsolatedDatabase, type RuntimeLogin } from './support/database.js';
import { buildDist, runNode, runtimeEnv, writePrincipals, type Dist } from './support/dist.js';

// B6: erro de listen (porta ocupada) → exit(1) com mensagem fixa, sem stack trace. O main exige login de runtime
// (autoverificação de privilégios antes do listen, etapa 2.5); como superuser recusa subir.
let dist: Dist;
let db: IsolatedDatabase;
let rt: RuntimeLogin;
let blocker: Server;
let busyPort = 0;

beforeAll(async () => {
  dist = buildDist('risk-main-listen');
  writePrincipals(dist.work);
  db = await createIsolatedDatabase();
  rt = await createRuntimeLogin(db);
  blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  busyPort = (blocker.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => blocker.close(() => { resolve(); }));
  await rt.drop();
  await db.drop();
  dist.cleanup();
});

const mainEnv = (databaseUrl: string) =>
  runtimeEnv({ RISK_DATABASE_URL: databaseUrl, RISK_HTTP_PORT: String(busyPort), RISK_PRINCIPALS_FILE: `${dist.work}/principals.json` });

describe('main: erro de listen', () => {
  it('porta ocupada em 127.0.0.1 → exit 1, mensagem fixa, sem stack trace nem detalhes do erro', async () => {
    const r = await runNode(dist.httpMain, [], mainEnv(rt.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('falha ao iniciar o servidor HTTP\n');
    expect(r.stderr).not.toMatch(/EADDRINUSE|\bat .*\(|node:|Error:|\.js:\d+/);
    expect(r.stdout).not.toContain('http.listening');
  });
});

describe('main: autoverificação de privilégios', () => {
  it('conectado como superuser → exit 1 com a mensagem de privilégios, sem stack, sem credencial, sem listen', async () => {
    const r = await runNode(dist.httpMain, [], mainEnv(db.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('privilégios do usuário de runtime excedem o mínimo ou não puderam ser verificados; servidor não iniciado\n');
    expect(r.stderr).not.toMatch(/\bat .*\(|node:|Error:|\.js:\d+|SUPERUSER|postgres:\/\//);
    expect(r.stderr).not.toContain(new URL(db.url).password);
    expect(r.stdout).not.toContain('http.listening');
  });

  it('banco inalcançável → também exit 1 com a mesma mensagem fixa (inspeção falha fechada)', async () => {
    const dead = new URL(rt.url);
    dead.port = '1';
    const r = await runNode(dist.httpMain, [], mainEnv(dead.toString()));
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('privilégios do usuário de runtime excedem o mínimo ou não puderam ser verificados; servidor não iniciado\n');
    expect(r.stderr).not.toContain(new URL(rt.url).password);
  });
});
