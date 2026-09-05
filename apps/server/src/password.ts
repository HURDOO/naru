import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
const defaultParameters = { N: 32768, r: 8, p: 1 } as const;
const keyLength = 64;

interface ParsedPasswordHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  expected: Buffer;
}

export interface PasswordHashOptions {
  N?: number;
  r?: number;
  p?: number;
  salt?: Uint8Array;
}

export async function hashPassword(
  password: string,
  options: PasswordHashOptions = {},
): Promise<string> {
  if (password.length < 12) {
    throw new Error("Password must contain at least 12 characters.");
  }

  const N = options.N ?? defaultParameters.N;
  const r = options.r ?? defaultParameters.r;
  const p = options.p ?? defaultParameters.p;
  validateParameters(N, r, p);
  const salt = Buffer.from(options.salt ?? randomBytes(16));
  const derived = await deriveKey(password, salt, keyLength, {
    N,
    r,
    p,
    maxmem: 128 * 1024 * 1024,
  });

  return [
    "scrypt",
    String(N),
    String(r),
    String(p),
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, serialized: string): Promise<boolean> {
  try {
    const parsed = parsePasswordHash(serialized);
    const actual = await deriveKey(password, parsed.salt, parsed.expected.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: 128 * 1024 * 1024,
    });
    return timingSafeEqual(actual, parsed.expected);
  } catch {
    return false;
  }
}

export function validatePasswordHash(serialized: string): void {
  const parsed = parsePasswordHash(serialized);
  if (parsed.N < defaultParameters.N || parsed.r < defaultParameters.r) {
    throw new Error("Password hash parameters are weaker than the Naru minimum.");
  }
}

function deriveKey(
  password: string,
  salt: Buffer,
  length: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function validateParameters(N: number, r: number, p: number): void {
  const powerOfTwo = N > 1 && (N & (N - 1)) === 0;
  if (!powerOfTwo || N < 1024 || N > 262144 || r < 1 || r > 32 || p < 1 || p > 8) {
    throw new Error("Invalid scrypt parameters.");
  }
}

function parsePasswordHash(serialized: string): ParsedPasswordHash {
  const parts = serialized.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    throw new Error("Password hash format is invalid.");
  }

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    throw new Error("Password hash parameters are invalid.");
  }
  validateParameters(N, r, p);

  const encodedSalt = parts[4] ?? "";
  const encodedExpected = parts[5] ?? "";
  const salt = Buffer.from(encodedSalt, "base64url");
  const expected = Buffer.from(encodedExpected, "base64url");
  if (
    salt.length < 16 ||
    expected.length !== keyLength ||
    salt.toString("base64url") !== encodedSalt ||
    expected.toString("base64url") !== encodedExpected
  ) {
    throw new Error("Password hash payload is invalid.");
  }
  return { N, r, p, salt, expected };
}
