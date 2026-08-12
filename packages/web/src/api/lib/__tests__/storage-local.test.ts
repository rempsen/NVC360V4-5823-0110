/**
 * Storage fallback (local disk) contract.
 *
 * The S3 path is env-gated (`S3_BUCKET` + keys) and is exercised live against
 * the real bucket; these tests lock the behaviour every deploy without S3 creds
 * relies on: round-trip of bytes + content type, key flattening, missing-object
 * = null, and idempotent delete. They also guard the Bun.S3Client migration
 * from regressing the shared shape (`{ key, url }` / `{ body, contentType }`).
 */
import { describe, expect, it } from "bun:test";
import { putObject, deleteObject, getObjectBody, storageMode } from "../storage";

const uniq = () => `zz-test/${crypto.randomUUID()}.png`;

describe("storage local fallback", () => {
  it("runs in local mode when S3 is not configured", () => {
    // The test suite is intentionally run WITHOUT the root .env, so no S3 creds.
    expect(storageMode).toBe(process.env.S3_BUCKET ? "s3" : "local");
  });

  it("round-trips bytes and content type", async () => {
    if (storageMode !== "local") return;
    const key = uniq();
    const body = new TextEncoder().encode("probe-bytes");
    const stored = await putObject(key, body, "image/png");
    expect(stored.key).toBe(key);
    // local URLs are flattened under /uploads/ — no nested dirs to create
    expect(stored.url).toBe(`/uploads/${key.replace(/\//g, "_")}`);
    expect(stored.url).not.toContain("zz-test/");

    const got = await getObjectBody(key);
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got!.body)).toBe("probe-bytes");
    expect(got!.contentType).toBe("image/png");

    await deleteObject(key);
    expect(await getObjectBody(key)).toBeNull();
  });

  it("returns null for a missing object instead of throwing", async () => {
    if (storageMode !== "local") return;
    expect(await getObjectBody(uniq())).toBeNull();
  });

  it("delete is idempotent and never throws", async () => {
    if (storageMode !== "local") return;
    const key = uniq();
    await deleteObject(key);
    await putObject(key, new Uint8Array([1, 2, 3]), "application/pdf");
    await deleteObject(key);
    await deleteObject(key);
    expect(await getObjectBody(key)).toBeNull();
  });
});
