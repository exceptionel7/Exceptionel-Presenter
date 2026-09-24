/**
 * EXCEPTIONEL PRESENTER — dependency-free runtime validation.
 *
 * Every IPC payload crossing from a renderer into the main process passes through here
 * before it can touch SQLite or the filesystem (docs/ARCHITECTURE.md §4). TypeScript
 * types vanish at runtime; a compromised or buggy renderer can send anything.
 *
 * Hand-rolled rather than zod because src/shared must stay dependency-free so it can be
 * unit-tested without a package install. The API is deliberately zod-shaped so swapping
 * to zod later is mechanical.
 */

export interface Invalid {
  ok: false;
  /** Dotted path to the offending field, e.g. "sections.2.lyrics". */
  path: string;
  message: string;
}
export interface Valid<T> {
  ok: true;
  value: T;
}
export type Result<T> = Valid<T> | Invalid;

export const ok = <T>(value: T): Valid<T> => ({ ok: true, value });
export const fail = (path: string, message: string): Invalid => ({ ok: false, path, message });

export interface Validator<T> {
  /** `path` is the dotted location of this value, for error reporting. */
  parse(input: unknown, path?: string): Result<T>;
}

/**
 * Throwing form, for main-process code paths where an invalid payload is a bug.
 *
 * Note the explicit field assignment rather than a `readonly path` constructor
 * parameter property: parameter properties are not erasable syntax, so they break
 * `node --experimental-strip-types`. `erasableSyntaxOnly` in the tsconfigs enforces this
 * project-wide at compile time.
 */
export class ValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'ValidationError';
    this.path = path;
  }
}

export function parseOrThrow<T>(validator: Validator<T>, input: unknown): T {
  const r = validator.parse(input);
  if (!r.ok) throw new ValidationError(r.path, r.message);
  return r.value;
}

const join = (path: string, key: string | number): string =>
  path ? `${path}.${key}` : String(key);

// ── primitives ──────────────────────────────────────────────────────────────────

export interface StringOptions {
  min?: number;
  max?: number;
  pattern?: RegExp;
  /** Collapse surrounding whitespace before validating. Default true. */
  trim?: boolean;
}

export function vString(options: StringOptions = {}): Validator<string> {
  const { min = 0, max = 10_000, pattern, trim = true } = options;
  return {
    parse(input, path = '') {
      if (typeof input !== 'string') return fail(path, `expected string, got ${typeName(input)}`);
      const value = trim ? input.trim() : input;
      if (value.length < min) return fail(path, `must be at least ${min} character(s)`);
      if (value.length > max) return fail(path, `must be at most ${max} character(s)`);
      if (pattern && !pattern.test(value)) return fail(path, `does not match ${String(pattern)}`);
      return ok(value);
    },
  };
}

export function vInt(options: { min?: number; max?: number } = {}): Validator<number> {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = options;
  return {
    parse(input, path = '') {
      if (typeof input !== 'number' || !Number.isFinite(input))
        return fail(path, `expected a finite number, got ${typeName(input)}`);
      if (!Number.isInteger(input)) return fail(path, 'expected an integer');
      if (input < min) return fail(path, `must be >= ${min}`);
      if (input > max) return fail(path, `must be <= ${max}`);
      return ok(input);
    },
  };
}

export function vNumber(options: { min?: number; max?: number } = {}): Validator<number> {
  const { min = -Infinity, max = Infinity } = options;
  return {
    parse(input, path = '') {
      if (typeof input !== 'number' || !Number.isFinite(input))
        return fail(path, `expected a finite number, got ${typeName(input)}`);
      if (input < min) return fail(path, `must be >= ${min}`);
      if (input > max) return fail(path, `must be <= ${max}`);
      return ok(input);
    },
  };
}

export const vBoolean = (): Validator<boolean> => ({
  parse(input, path = '') {
    return typeof input === 'boolean' ? ok(input) : fail(path, `expected boolean, got ${typeName(input)}`);
  },
});

/** No payload. Rejects anything other than undefined/null so typos surface loudly. */
export const vVoid = (): Validator<void> => ({
  parse(input, path = '') {
    return input === undefined || input === null
      ? ok(undefined as void)
      : fail(path, 'expected no payload');
  },
});

/** Accept anything — only for genuinely opaque blobs. Use sparingly and comment why. */
export const vUnknown = (): Validator<unknown> => ({ parse: (input) => ok(input) });

export function vLiteral<const T extends string | number | boolean>(literal: T): Validator<T> {
  return {
    parse(input, path = '') {
      return input === literal ? ok(literal) : fail(path, `expected ${JSON.stringify(literal)}`);
    },
  };
}

export function vEnum<const T extends readonly string[]>(values: T): Validator<T[number]> {
  return {
    parse(input, path = '') {
      if (typeof input !== 'string') return fail(path, `expected one of ${values.join(' | ')}`);
      return values.includes(input)
        ? ok(input as T[number])
        : fail(path, `expected one of ${values.join(' | ')}, got "${input}"`);
    },
  };
}

// ── combinators ─────────────────────────────────────────────────────────────────

export function vNullable<T>(inner: Validator<T>): Validator<T | null> {
  return {
    parse(input, path = '') {
      return input === null ? ok(null) : inner.parse(input, path);
    },
  };
}

export function vOptional<T>(inner: Validator<T>): Validator<T | undefined> {
  return {
    parse(input, path = '') {
      return input === undefined ? ok(undefined) : inner.parse(input, path);
    },
  };
}

export function vDefault<T>(inner: Validator<T>, fallback: () => T): Validator<T> {
  return {
    parse(input, path = '') {
      return input === undefined || input === null ? ok(fallback()) : inner.parse(input, path);
    },
  };
}

export function vArray<T>(
  inner: Validator<T>,
  options: { min?: number; max?: number } = {},
): Validator<T[]> {
  const { min = 0, max = 10_000 } = options;
  return {
    parse(input, path = '') {
      if (!Array.isArray(input)) return fail(path, `expected array, got ${typeName(input)}`);
      if (input.length < min) return fail(path, `expected at least ${min} item(s)`);
      if (input.length > max) return fail(path, `expected at most ${max} item(s)`);
      const out: T[] = [];
      for (let i = 0; i < input.length; i++) {
        const r = inner.parse(input[i], join(path, i));
        if (!r.ok) return r;
        out.push(r.value);
      }
      return ok(out);
    },
  };
}

type Shape = Record<string, Validator<unknown>>;
type Infer<S extends Shape> = { [K in keyof S]: S[K] extends Validator<infer U> ? U : never };

/**
 * Object validator. Unknown keys are **dropped**, not merged — that is the whole point
 * of validating at the boundary. A renderer cannot smuggle an extra `isAdmin` or
 * `absPath` field into a repository write by attaching it to a legitimate payload.
 */
export function vObject<S extends Shape>(shape: S): Validator<Infer<S>> {
  const keys = Object.keys(shape);
  return {
    parse(input, path = '') {
      if (typeof input !== 'object' || input === null || Array.isArray(input))
        return fail(path, `expected object, got ${typeName(input)}`);
      const source = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        const r = shape[key]!.parse(source[key], join(path, key));
        if (!r.ok) return r;
        // Preserve exactOptionalPropertyTypes: omit rather than set undefined.
        if (r.value !== undefined) out[key] = r.value;
      }
      return ok(out as Infer<S>);
    },
  };
}

/** Discriminated union on a string tag — the pattern used by every IPC intent. */
export function vTagged<K extends string, M extends Record<string, Validator<unknown>>>(
  tagKey: K,
  members: M,
): Validator<{ [T in keyof M]: M[T] extends Validator<infer U> ? U : never }[keyof M]> {
  const tags = Object.keys(members);
  return {
    parse(input, path = '') {
      if (typeof input !== 'object' || input === null)
        return fail(path, `expected object, got ${typeName(input)}`);
      const tag = (input as Record<string, unknown>)[tagKey];
      if (typeof tag !== 'string' || !tags.includes(tag))
        return fail(join(path, tagKey), `expected one of ${tags.join(' | ')}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return members[tag]!.parse(input, path) as any;
    },
  };
}

// ── domain-specific validators ──────────────────────────────────────────────────

/**
 * Entity ids. Restricted to a safe alphabet because ids reach SQLite, window names,
 * and (for media) filenames. Rejecting exotic input here means downstream code never
 * has to wonder.
 */
export const vId = (): Validator<string> => vString({ min: 1, max: 64, pattern: /^[A-Za-z0-9_-]+$/ });

/** ISO-8601 date, date-only form. Stored as TEXT in SQLite for sortability. */
export const vDateOnly = (): Validator<string> => ({
  parse(input, path = '') {
    const r = vString({ min: 10, max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ }).parse(input, path);
    if (!r.ok) return fail(path, 'expected a date as YYYY-MM-DD');
    // Reject 2026-02-31: round-trip through Date and compare.
    const [y, m, d] = r.value.split('-').map(Number) as [number, number, number];
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d)
      return fail(path, `"${r.value}" is not a real calendar date`);
    return ok(r.value);
  },
});

export const vHexColor = (): Validator<string> =>
  vString({ min: 4, max: 9, pattern: /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/ });

/**
 * Keyboard accelerator, Electron syntax ("CommandOrControl+Shift+B", "ArrowLeft", "F").
 * Validated so a corrupt shortcuts table cannot crash globalShortcut registration.
 */
export const vAccelerator = (): Validator<string> =>
  vString({ min: 1, max: 64, pattern: /^(?:[A-Za-z0-9]+\+)*[A-Za-z0-9]+$/ });

function typeName(input: unknown): string {
  if (input === null) return 'null';
  if (Array.isArray(input)) return 'array';
  return typeof input;
}
