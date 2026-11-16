import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { Prisma } from "@prisma/client";
import { isDbUnavailable, sendDbUnavailable } from "../../src/utils/db-errors";

const known = (code: string) => new Prisma.PrismaClientKnownRequestError("boom", { code, clientVersion: "test" });

describe("isDbUnavailable", () => {
  it("treats unreachable / timed-out database errors as unavailable", () => {
    for (const code of ["P1001", "P1002", "P1008", "P1017", "P2024", "P2028"]) {
      expect(isDbUnavailable(known(code))).toBe(true);
    }
    expect(isDbUnavailable(new Prisma.PrismaClientInitializationError("down", "test"))).toBe(true);
  });

  it("leaves real request errors alone", () => {
    expect(isDbUnavailable(known("P2002"))).toBe(false); // unique constraint
    expect(isDbUnavailable(known("P2025"))).toBe(false); // record not found
    expect(isDbUnavailable(new Error("nope"))).toBe(false);
    expect(isDbUnavailable(null)).toBe(false);
  });
});

describe("sendDbUnavailable", () => {
  it("replies 503 in the API's error shape, with Retry-After and the retryable flag", async () => {
    const app = Fastify();
    app.get("/x", (_req, reply) => sendDbUnavailable(reply, { retryable: true }));
    const res = await app.inject({ method: "GET", url: "/x" });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("3");
    expect(res.json()).toMatchObject({ data: null, error: { code: "SERVICE_UNAVAILABLE", retryable: true } });
    await app.close();
  });
});
