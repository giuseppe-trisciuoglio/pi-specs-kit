/**
 * Surface a message to the operator in any mode: in interactive/RPC it goes
 * through the notify channel; in print/json mode (where UI methods are
 * no-ops) it falls back to stdout so the response is still observable.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export function report(ctx: ExtensionCommandContext, message: string): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, "info");
    return;
  }
  process.stdout.write(`${message}\n`);
}
