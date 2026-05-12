// Story 18-1e + 18-1f: prompt assembly + skill asset staging helpers. The
// sandbox runner calls these at boot. We deliberately ship tiny inline
// helpers rather than reusing the api parser; the sandbox does not depend on
// api source.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

import type { LoadedSkill, ManagerClient } from "./sdk.js";

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** Strip a leading `--- ... ---` YAML frontmatter block, if any. */
export function stripFrontmatter(body: string): string {
  return body.replace(FRONTMATTER_RE, "");
}

/**
 * Build a Level 2 disclosure block: one `# Skill: name@version` heading per
 * loaded skill, followed by its body with the frontmatter stripped. Allowlist
 * only skills (body null) are skipped silently.
 */
export function buildSkillsContext(skills: LoadedSkill[]): string {
  let out = "";
  for (const s of skills) {
    if (!s.body) continue;
    const stripped = stripFrontmatter(s.body);
    out += `\n\n# Skill: ${s.name}@${s.version}\n\n${stripped}`;
  }
  return out;
}

/**
 * Story 18-1f stage helper: for each skill with `assetsRef`, list the
 * attached files and write them into `<workdir>/<skill-name>/<relpath>`. The
 * agent then invokes them by relative path (eg `python3
 * wordfence-fetch/scripts/fetch_nvd.py`).
 *
 * Failures per file are swallowed and logged so a single bad asset cannot
 * block the whole run. Returns the count of staged files.
 */
export async function stageSkillAssets(opts: {
  client: ManagerClient;
  skills: LoadedSkill[];
  workdir: string;
  log?: (level: string, message: string, extras?: Record<string, unknown>) => void;
}): Promise<number> {
  let staged = 0;
  const safeBase = resolvePath(opts.workdir);
  for (const skill of opts.skills) {
    if (!skill.assetsRef) continue;
    let items: Array<{ path: string; sizeBytes: number }> = [];
    try {
      items = await opts.client.listSkillAssets({ name: skill.name, version: skill.version });
    } catch (e) {
      opts.log?.("warn", "stage: listSkillAssets failed", {
        skill: `${skill.name}@${skill.version}`,
        err: (e as Error).message,
      });
      continue;
    }
    for (const it of items) {
      const targetRel = join(skill.name, it.path);
      const target = resolvePath(opts.workdir, targetRel);
      // Defence in depth: refuse any path that escapes the workdir.
      if (!target.startsWith(`${safeBase}/`) && target !== safeBase) {
        opts.log?.("warn", "stage: refusing path traversal", { path: targetRel });
        continue;
      }
      try {
        const buf = await opts.client.loadSkillAsset({
          name: skill.name,
          version: skill.version,
          path: it.path,
        });
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, buf);
        staged++;
        opts.log?.("info", "stage: wrote asset", {
          skill: `${skill.name}@${skill.version}`,
          path: targetRel,
          bytes: buf.length,
        });
      } catch (e) {
        opts.log?.("warn", "stage: asset fetch failed", {
          skill: `${skill.name}@${skill.version}`,
          path: it.path,
          err: (e as Error).message,
        });
      }
    }
  }
  return staged;
}

/** @deprecated kept for back-compat; use `stageSkillAssets` instead. */
export async function fetchAssetsForSkill(
  _skill: LoadedSkill,
  _client: Pick<ManagerClient, "loadSkillAsset">,
): Promise<void> {
  /* no-op */
}
