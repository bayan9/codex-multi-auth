import { expect, it, vi } from "vitest";
import { applyClientAttestation, parseAttestableRequestBody } from "../lib/request/client-attestation.js";

it("keeps attested turn metadata header ASCII-safe", () => {
  vi.stubEnv("CODEX_MULTI_AUTH_CLIENT_ATTESTATION", "positive");
  const headers = new Headers({"x-codex-turn-metadata": '{"label":"\\u4e2d"}'});
  applyClientAttestation({}, headers);
  const value = headers.get("x-codex-turn-metadata")!;
  expect(value).toContain("\\u4e2d");
  expect([...value].every(char => char.charCodeAt(0) < 128)).toBe(true);
});


it("preserves escaped user strings and exact numbers through attestation", () => {
  const payload = parseAttestableRequestBody(Buffer.from('{"model":"shared","input":"\\u005f\\u005fcma_raw_number_0","\\u005f\\u005fcma_raw_number_1":1,"client_metadata":{"limit":9007199254740993},"enum":[0,0,0],"sandbox":9007199254740993,"maximum":9007199254740993,"ratio":1.2300e+4}'))!;
  applyClientAttestation(payload.body, new Headers());
  const serialized = payload.serialize().toString();
  expect(JSON.parse(serialized).input).toBe("__cma_raw_number_0");
  expect(JSON.parse(serialized).__cma_raw_number_1).toBe(1);
  expect(serialized).toContain('"client_metadata":{"limit":9007199254740993');
  expect(serialized).toContain('"enum":[0,0,0]');
  expect(serialized).toContain('"sandbox":9007199254740993');
  expect(serialized).toContain('"maximum":9007199254740993');
  expect(serialized).toContain('"ratio":1.2300e+4');
});


it("preserves deeply nested unrelated client metadata", () => {
  const nested = "[".repeat(5000) + "0" + "]".repeat(5000);
  const payload = parseAttestableRequestBody(Buffer.from(
    `{"model":"shared","client_metadata":{"extra":${nested}}}`,
  ))!;
  applyClientAttestation(payload.body, new Headers());
  const serialized = payload.serialize().toString();
  expect(serialized).toContain(`"extra":${nested}`);
});

it("handles many duplicate unrelated members without member allocation growth", () => {
  const duplicates = `"x":0,`.repeat(200_000);
  const payload = parseAttestableRequestBody(Buffer.from(`{${duplicates}"model":"shared"}`))!;
  applyClientAttestation(payload.body, new Headers());
  expect(payload.serialize().toString()).toContain(duplicates);
}, 1_000);


it("rejects client metadata above the attestation match limit", () => {
  const duplicates = `"sandbox":"attested",`.repeat(1_025);
  expect(parseAttestableRequestBody(Buffer.from(
    `{"model":"shared","client_metadata":{"thread_id":"keep",${duplicates}"extra":1}}`,
  ))).toBeNull();
});
