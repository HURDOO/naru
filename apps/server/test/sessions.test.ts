import { describe, expect, it } from "vitest";
import { LoginRateLimiter, SessionStore } from "../src/sessions.js";

describe("SessionStore", () => {
  it("expires sessions by idle and absolute lifetime and deletes them on logout", () => {
    const sessions = new SessionStore("a-session-secret-that-is-long-enough", 1_000, 100);
    const idle = sessions.create(0);
    expect(sessions.count(50)).toBe(1);
    expect(sessions.get(idle.token, 99)).toBeDefined();
    expect(sessions.get(idle.token, 200)).toBeUndefined();
    expect(sessions.count(200)).toBe(0);

    const absolute = sessions.create(0);
    expect(sessions.get(absolute.token, 90)).toBeDefined();
    expect(sessions.get(absolute.token, 180)).toBeDefined();
    expect(sessions.get(absolute.token, 1_000)).toBeUndefined();

    const loggedOut = sessions.create(0);
    sessions.delete(loggedOut.token);
    expect(sessions.get(loggedOut.token, 1)).toBeUndefined();
  });
});

describe("LoginRateLimiter", () => {
  it("blocks repeated failures until the window passes", () => {
    const limiter = new LoginRateLimiter(2, 1_000);
    limiter.recordFailure("client", 0);
    limiter.recordFailure("client", 10);
    expect(limiter.canAttempt("client", 11)).toBe(false);
    expect(limiter.canAttempt("client", 1_011)).toBe(true);
  });
});
