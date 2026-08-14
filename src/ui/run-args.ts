/**
 * Argument parsing for the slash commands. Kept apart from the extension
 * factory so it stays testable without loading the pi runtime modules.
 */

export interface RunArgs {
  spec?: string;
  fromTask?: string;
  toTask?: string;
  phase?: string;
  resume: boolean;
  force: boolean;
}

/** Parse the space-separated tokens of /specs-kit-run; unknown tokens are ignored. */
export function parseRunArgs(args: string): RunArgs {
  const parsed: RunArgs = { resume: false, force: false };
  const tokens = args.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--resume") parsed.resume = true;
    else if (token === "--force") parsed.force = true;
    else if (token === "--spec") parsed.spec = tokens[++i];
    else if (token === "--from-task") parsed.fromTask = tokens[++i];
    else if (token === "--to-task") parsed.toTask = tokens[++i];
    else if (token === "--phase") parsed.phase = tokens[++i];
  }
  return parsed;
}
