import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { JevBenchmarkMetadata, JevSettings } from "./settings.js";

export interface ModelSelectionGuides {
  selectionEnabled: boolean;
  /** Evaluation instructions sent to Jev. Candidate detail stays in Choice criteria. */
  selectionGuide: string;
  /** Text substituted into the parent-facing tool description. */
  parentGuide: string;
  candidatesTable: string;
  warning?: string;
}

export function loadModelSelectionGuides(
  config: JevSettings,
  agentDir: string = getAgentDir(),
): ModelSelectionGuides {
  const manualPath = join(agentDir, "model-selection-guide.md");
  const autoPath = join(agentDir, "model-selection-auto-guide.md");
  const manual = readGuide(manualPath);
  const auto = readGuide(autoPath);
  const candidatesTable = formatModelCandidates(config);
  const benchmarkMetadata = formatBenchmarkMetadata(config.benchmark);
  const manualForParent = appendMetadataOnce(
    manual?.replaceAll("{{modelCandidates}}", candidatesTable) ?? "",
    benchmarkMetadata,
  );
  const selectionGuide = appendMetadataOnce(
    manual?.replaceAll(
      "{{modelCandidates}}",
      structuredCriteriaReference(config.benchmark),
    ) ?? "",
    benchmarkMetadata,
  );

  if (!config.enabled) {
    return {
      selectionEnabled: false,
      selectionGuide,
      parentGuide: manualForParent,
      candidatesTable,
    };
  }

  const missing = [
    ...(manual === undefined ? ["model-selection-guide.md"] : []),
    ...(auto === undefined ? ["model-selection-auto-guide.md"] : []),
  ];
  if (missing.length > 0) {
    return {
      selectionEnabled: false,
      selectionGuide,
      parentGuide: manualForParent,
      candidatesTable,
      warning: `Jev model selection unavailable: missing or empty ${missing.join(" and ")} in ${agentDir}; parent selection required.`,
    };
  }

  return {
    selectionEnabled: true,
    selectionGuide,
    parentGuide: appendMetadataOnce(
      auto!.replaceAll("{{modelCandidates}}", candidatesTable),
      benchmarkMetadata,
    ),
    candidatesTable,
  };
}

export function formatModelCandidates(config: JevSettings): string {
  const rows = [
    "| Model | Effort | Description | Score (%) | 95% CI (pp) | Min/task | Steps/task | USD/task |",
    "|---|---|---|---:|---:|---:|---:|---:|",
    ...config.candidates.map(candidate => {
      const benchmark = candidate.benchmark;
      return `| ${cell(candidate.model)} | ${cell(candidate.effort)} | ${cell(candidate.description ?? "")} | ${number(benchmark?.scorePercent)} | ${number(benchmark?.scoreCi95HalfWidthPp)} | ${number(benchmark?.minutesPerTask)} | ${number(benchmark?.stepsPerTask)} | ${number(benchmark?.usdPerTask)} |`;
    }),
  ];
  const metadata = formatBenchmarkMetadata(config.benchmark);
  return metadata ? `${rows.join("\n")}\n\n${metadata}` : rows.join("\n");
}

function readGuide(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const guide = readFileSync(path, "utf8").trim();
    return guide || undefined;
  } catch {
    return undefined;
  }
}

function structuredCriteriaReference(metadata: JevBenchmarkMetadata | undefined): string {
  const reference = "Candidate model, effort, description, and per-candidate benchmark fields are provided in the structured Choice criteria.";
  const benchmark = formatBenchmarkMetadata(metadata);
  return benchmark ? `${reference}\n\n${benchmark}` : reference;
}

function appendMetadataOnce(guide: string, metadata: string): string {
  if (!metadata || guide.includes(metadata)) return guide;
  return guide ? `${guide}\n\n${metadata}` : metadata;
}

function formatBenchmarkMetadata(metadata: JevBenchmarkMetadata | undefined): string {
  if (metadata === undefined) return "";
  const fields = [
    ["Benchmark", metadata.name],
    ["Source", metadata.url],
    ["Date", metadata.date],
    ["Conditions", metadata.conditions],
    ["Notes", metadata.notes],
    ["Price correction", metadata.priceCorrectionUrl],
    ["Price checked", metadata.priceCheckedAt],
  ].filter((entry): entry is [string, string] => entry[1] !== undefined);
  return fields.map(([label, value]) => `- ${label}: ${value}`).join("\n");
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function number(value: number | undefined): string {
  return value === undefined ? "—" : String(value);
}
