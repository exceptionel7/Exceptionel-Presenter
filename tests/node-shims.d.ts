/**
 * Minimal ambient declarations for `node:test` / `node:assert`.
 *
 * WHY THIS EXISTS: this sandbox has no network, so `@types/node` cannot be installed
 * (see docs/ENVIRONMENT.md). These shims let `tsc --noEmit` typecheck the test suite
 * here. Once you run `npm install` locally, `@types/node` supersedes this file and it
 * should be deleted.
 */
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
}
declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    match(value: string, regExp: RegExp, message?: string): void;
    doesNotMatch(value: string, regExp: RegExp, message?: string): void;
    throws(
      fn: () => unknown,
      expected?: RegExp | ((e: unknown) => boolean) | string,
      message?: string,
    ): void;
    doesNotThrow(fn: () => unknown, message?: string): void;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}

declare module 'node:sqlite' {
  export interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }
  export class StatementSync {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): StatementResultingChanges;
    iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>;
    setReadBigInts(enabled: boolean): void;
  }
  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean; enableForeignKeyConstraints?: boolean });
    open(): void;
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}

declare module 'node:fs' {
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function readFileSync(path: string, encoding: string): string;
  export function readdirSync(path: string): string[];
  export function writeFileSync(
    path: string,
    data: string | Uint8Array,
    options?: string | { encoding?: string; mode?: number },
  ): void;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string, ext?: string): string;
  export function extname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function relative(from: string, to: string): string;
  export const sep: string;
}

declare module 'node:os' {
  export function tmpdir(): string;
  export function platform(): string;
  export function networkInterfaces(): Record<
    string,
    { address: string; family: string | number; internal: boolean; netmask?: string }[] | undefined
  >;
}

declare module 'node:crypto' {
  export function randomUUID(): string;
  export function randomBytes(size: number): { toString(encoding: string): string };
  export function createHash(algorithm: string): {
    update(data: string): { digest(encoding: string): string };
  };

  export interface KeyObject {
    export(options: { format: 'der'; type: 'spki' | 'pkcs8' }): Uint8Array;
    export(options: { format: 'pem'; type: 'spki' | 'pkcs8' | 'sec1' }): string | Buffer;
  }
  export function generateKeyPairSync(
    type: 'ec',
    options: { namedCurve: string },
  ): { publicKey: KeyObject; privateKey: KeyObject };
  export function createPublicKey(key: string | KeyObject): KeyObject;
  export function createPrivateKey(key: string | KeyObject): KeyObject;
  export function sign(
    algorithm: string,
    data: Uint8Array,
    key: KeyObject | string,
  ): Uint8Array;
  export class X509Certificate {
    constructor(pem: string | Uint8Array);
    readonly subject: string;
    readonly issuer: string;
    readonly subjectAltName: string | undefined;
    readonly validFrom: string;
    readonly validTo: string;
    readonly fingerprint256: string;
    readonly serialNumber: string;
    readonly keyUsage: string[] | undefined;
    readonly ca: boolean;
    readonly publicKey: KeyObject;
    verify(key: KeyObject): boolean;
  }
}

declare module 'node:https' {
  export interface ServerResponseLike {
    writeHead(status: number, headers?: Record<string, string>): void;
    end(body?: string | Uint8Array): void;
    write(chunk: string | Uint8Array): boolean;
    setHeader(name: string, value: string): void;
    readonly writableEnded: boolean;
  }
  export interface IncomingMessageLike {
    readonly url: string | undefined;
    readonly method: string | undefined;
    readonly headers: Record<string, string | string[] | undefined>;
    on(event: string, listener: (...args: never[]) => void): void;
    setEncoding(encoding: string): void;
  }
  export interface Server {
    listen(port: number, host?: string): void;
    close(callback?: () => void): void;
    address(): { port: number; address: string } | string | null;
    on(event: string, listener: (...args: never[]) => void): void;
    readonly listening: boolean;
  }
  export function createServer(
    options: { cert: string; key: string },
    handler?: (request: IncomingMessageLike, response: ServerResponseLike) => void,
  ): Server;
}

declare module 'node:tls' {
  export interface TlsSocket {
    readonly authorized: boolean;
    getPeerCertificate(): Record<string, unknown>;
    getProtocol(): string | null;
    end(): void;
    on(event: string, listener: (...args: never[]) => void): void;
  }
  export function connect(options: {
    host: string;
    port: number;
    rejectUnauthorized?: boolean;
    servername?: string;
  }): TlsSocket;
}

declare module 'node:events' {
  export function once(emitter: unknown, event: string): Promise<unknown[]>;
}

declare const Buffer: {
  from(data: Uint8Array | string, encoding?: string): { toString(encoding: string): string };
};
type Buffer = { toString(encoding?: string): string };

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

declare const process: {
  platform: string;
  env: Record<string, string | undefined>;
  versions: Record<string, string>;
  cwd(): string;
  exit(code?: number): never;
};
