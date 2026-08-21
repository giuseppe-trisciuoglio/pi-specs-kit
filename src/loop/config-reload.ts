/**
 * Mid-run configuration reload. The loop re-reads the yaml file before every
 * phase so an operator edit applies to the next phase instead of the next
 * run. The swap mutates the one config object every loop module already
 * holds: keeping the identity stable means no read site can keep stale values
 * by accident. The structural anchors resolved at start — the root paths, the
 * specs directory, the active spec — stay frozen: the spec dir, the fix plan
 * and the ledger path were computed from them, and moving them mid-run would
 * split one run across two roots. A file that does not load keeps the last
 * loaded values with a warning: an editor saving halfway must never be the
 * reason a run dies.
 */

import { access } from "node:fs/promises";
import { loadSpecsKitConfig, type SpecsKitConfig } from "../config/specs-kit-config.ts";

export interface ConfigReloadDeps {
  /**
   * Config loader, injectable so tests pin what the file returns. Null means
   * "nothing to reload": the run keeps its current values in silence.
   */
  load: (projectRoot: string, configPath?: string) => Promise<SpecsKitConfig | null>;
  notify: (message: string, type: "info" | "warning" | "error") => void;
  /** Called after each successful swap, e.g. to re-apply the run ceilings. */
  onReloaded?: (config: SpecsKitConfig) => void;
}

/**
 * The default reload source: the file the start config was loaded from, when
 * it exists. A missing file is not the all-default config — it is the
 * absence of anything to reload: swapping the defaults in would clobber the
 * values the run started with, and a file deleted mid-run must not reset a
 * running loop either. When the operator creates the file, the next reload
 * picks it up.
 */
export async function loadConfigIfPresent(
  projectRoot: string,
  configPath?: string,
): Promise<SpecsKitConfig | null> {
  const probe = await loadSpecsKitConfig(projectRoot, configPath);
  try {
    await access(probe.configPath);
  } catch {
    return null;
  }
  return probe;
}

export class ConfigReloader {
  readonly #config: SpecsKitConfig;
  readonly #deps: ConfigReloadDeps;

  constructor(config: SpecsKitConfig, deps: ConfigReloadDeps) {
    this.#config = config;
    this.#deps = deps;
  }

  /**
   * Re-read the file and swap the behavioral sections in place. Best-effort:
   * a load failure keeps the current values and warns, it never throws.
   */
  async refresh(): Promise<void> {
    let fresh: SpecsKitConfig | null;
    try {
      fresh = await this.#deps.load(this.#config.projectRoot, this.#config.configPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#deps.notify(
        `[specs-kit] config reload failed: ${message}; keeping the last loaded values`,
        "warning",
      );
      return;
    }
    if (fresh === null) return;
    const config = this.#config;
    config.version = fresh.version;
    config.mode = fresh.mode;
    config.pollIntervalMs = fresh.pollIntervalMs;
    config.roles = fresh.roles;
    config.reviewPanel = fresh.reviewPanel;
    config.run = fresh.run;
    config.git = fresh.git;
    config.hooks = fresh.hooks;
    config.knowledgeBase = fresh.knowledgeBase;
    config.prompts = fresh.prompts;
    this.#deps.onReloaded?.(config);
  }
}
