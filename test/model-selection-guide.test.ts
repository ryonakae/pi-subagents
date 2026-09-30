import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadModelSelectionGuides } from "../src/model-selection-guide.js";
import type { JevSettings } from "../src/settings.js";

const config = (enabled: boolean): JevSettings => ({
  enabled,
  provider: "typesafe",
  model: "jev-1.13.0",
  timeoutMs: 5000,
  minConfidence: 0.7,
  maxRequestBytes: 65_536,
  candidates: [{
    model: "anthropic/claude-sonnet-4-6",
    effort: "high",
    description: "Complex implementation",
    benchmark: { scorePercent: 72.4, minutesPerTask: 8.2, usdPerTask: 0.42 },
  }],
  benchmark: { name: "DeepSWE", date: "2026-09-01", notes: "Reference only" },
});

describe("model selection guides", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("uses the auto parent guide when enabled and expands the candidate table once", () => {
    dir = mkdtempSync(join(tmpdir(), "pi-jev-guides-"));
    writeFileSync(join(dir, "model-selection-guide.md"), "CRITERIA\n{{modelCandidates}}\n{{modelSelectionGuide}}");
    writeFileSync(join(dir, "model-selection-auto-guide.md"), "AUTO: omit model and thinking");

    const guides = loadModelSelectionGuides(config(true), dir);

    expect(guides.selectionEnabled).toBe(true);
    expect(guides.parentGuide).toContain("AUTO: omit model and thinking");
    expect(guides.parentGuide).toContain("DeepSWE");
    expect(guides.parentGuide).toContain("2026-09-01");
    expect(guides.selectionGuide).toContain("CRITERIA");
    expect(guides.selectionGuide).toContain("structured Choice criteria");
    expect(guides.selectionGuide).not.toContain("anthropic/claude-sonnet-4-6");
    expect(guides.selectionGuide).toContain("DeepSWE");
    expect(guides.selectionGuide.match(/- Benchmark: DeepSWE/g)).toHaveLength(1);
    expect(guides.selectionGuide).toContain("{{modelSelectionGuide}}");
    expect(guides.candidatesTable).toContain("anthropic/claude-sonnet-4-6");
    expect(guides.candidatesTable).toContain("72.4");
  });

  it("uses the manual guide while disabled without requiring the auto guide", () => {
    dir = mkdtempSync(join(tmpdir(), "pi-jev-guides-"));
    writeFileSync(join(dir, "model-selection-guide.md"), "MANUAL\n{{modelCandidates}}");

    const guides = loadModelSelectionGuides(config(false), dir);

    expect(guides.selectionEnabled).toBe(false);
    expect(guides.parentGuide).toContain("MANUAL");
    expect(guides.warning).toBeUndefined();
  });

  it("disables selection with a warning when an enabled guide is missing", () => {
    dir = mkdtempSync(join(tmpdir(), "pi-jev-guides-"));
    writeFileSync(join(dir, "model-selection-guide.md"), "MANUAL");

    const guides = loadModelSelectionGuides(config(true), dir);

    expect(guides.selectionEnabled).toBe(false);
    expect(guides.warning).toContain("model-selection-auto-guide.md");
    expect(guides.parentGuide).toContain("MANUAL");
    expect(guides.parentGuide).toContain("DeepSWE");
  });
});
