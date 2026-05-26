import { describe, expect, it, vi } from "vitest";
import { Scheduler } from "../../src/compiler/scheduler";

describe("Scheduler", () => {
  it("coalesces multiple enqueues into a single flush", async () => {
    const flush = vi.fn(async () => {
      /* noop */
    });
    const sch = new Scheduler(flush);

    await Promise.all([
      sch.enqueue("/a.ts", "1"),
      sch.enqueue("/b.ts", "2"),
      sch.enqueue("/c.ts", "3"),
    ]);

    expect(flush).toHaveBeenCalledTimes(1);
    const batch = flush.mock.calls[0][0] as Map<string, string>;
    expect([...batch.entries()].sort()).toEqual([
      ["/a.ts", "1"],
      ["/b.ts", "2"],
      ["/c.ts", "3"],
    ]);
  });

  it("keeps only the latest content for a file within a single batch", async () => {
    const flush = vi.fn(async () => {
      /* noop */
    });
    const sch = new Scheduler(flush);

    await Promise.all([
      sch.enqueue("/a.ts", "v1"),
      sch.enqueue("/a.ts", "v2"),
      sch.enqueue("/a.ts", "v3"),
    ]);

    expect(flush).toHaveBeenCalledTimes(1);
    const batch = flush.mock.calls[0][0] as Map<string, string>;
    expect(batch.get("/a.ts")).toBe("v3");
  });

  it("runs separate flushes for sequential bursts", async () => {
    const flush = vi.fn(async () => {
      /* noop */
    });
    const sch = new Scheduler(flush);

    await sch.enqueue("/a.ts", "1");
    await sch.enqueue("/b.ts", "2");

    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("propagates errors from flush", async () => {
    const flush = vi.fn(async () => {
      throw new Error("boom");
    });
    const sch = new Scheduler(flush);

    await expect(sch.enqueue("/a.ts", "v")).rejects.toThrow(/boom/);
  });
});
