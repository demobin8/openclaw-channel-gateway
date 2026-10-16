/**
 * Generate skills/ocg/SKILL.md from src/skill-template.ts (the same content
 * `ocg skill show` prints).  Runs as part of prepublishOnly so the npm package
 * ships a fetchable SKILL.md (techdesign Q3).
 *
 * Run manually: npx tsx scripts/generate-skill.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSkillMarkdown } from "../src/skill-template.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version?: string };
const version = typeof pkg.version === "string" ? pkg.version : "0.0.0";

const targetDir = join(repoRoot, "skills", "ocg");
mkdirSync(targetDir, { recursive: true });
const file = join(targetDir, "SKILL.md");
writeFileSync(file, buildSkillMarkdown(version), "utf8");
console.log(`[ocg] wrote ${file} (v${version})`);
