import { describe, expect, it } from "vitest";
import { hashPassword, validatePasswordHash, verifyPassword } from "../src/password.js";

describe("password hashing", () => {
  it("verifies the password without accepting a different value", async () => {
    const hash = await hashPassword("correct horse battery staple", {
      N: 1024,
      salt: Buffer.alloc(16, 7),
    });

    await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", hash)).resolves.toBe(false);
  });

  it("rejects malformed hashes", async () => {
    await expect(verifyPassword("anything", "not-a-hash")).resolves.toBe(false);
  });

  it("rejects weak or malformed hashes as startup configuration", () => {
    const payload = [
      Buffer.alloc(16, 1).toString("base64url"),
      Buffer.alloc(64, 2).toString("base64url"),
    ];
    const strong = ["scrypt", "32768", "8", "1", ...payload].join("$");
    const weak = ["scrypt", "1024", "8", "1", ...payload].join("$");

    expect(() => validatePasswordHash(strong)).not.toThrow();
    expect(() => validatePasswordHash(weak)).toThrow(/weaker than the Naru minimum/);
    expect(() => validatePasswordHash("scrypt$32768$8$1$bad$bad")).toThrow(/payload is invalid/);
  });
});
