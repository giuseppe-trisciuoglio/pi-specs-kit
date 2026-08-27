/**
 * Interactive model selector for a role, built like the agent's own model
 * picker: a search box narrowing a windowed list, the configured model marked
 * and listed first, and a detail line for the highlighted entry. It draws on
 * the terminal UI, so the caller falls back to the dialog based picker
 * wherever there is no terminal to draw on.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, Text, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import {
  AUTO,
  VISIBLE_MODELS,
  counterText,
  filterModels,
  listWindow,
  modelDetail,
  modelValue,
  orderModels,
  type ModelEntry,
} from "./model-list.ts";

export type ModelChoice =
  | { kind: "picked"; value: string }
  | { kind: "cancelled" }
  /** No terminal to draw on: the caller decides what to show instead. */
  | { kind: "unsupported" };

export interface ModelSelectorOptions {
  role: string;
  models: readonly ModelEntry[];
  /** Model configured for the role, as "provider/id" or "auto". */
  current: string;
}

/** The auto entry is part of the list, so it is reachable like any model. */
const AUTO_ENTRY: ModelEntry = { provider: "", id: AUTO, name: "chosen by the agent CLI at every spawn" };

function entryValue(model: ModelEntry): string {
  return model === AUTO_ENTRY ? AUTO : modelValue(model);
}

/** Full width rule framing the selector, redrawn on every resize. */
function border(theme: Theme): Component {
  return {
    render: (width: number): string[] => [theme.fg("border", "─".repeat(Math.max(1, width)))],
    invalidate: (): void => {},
  };
}

/**
 * The selector is composed rather than subclassed: it owns a container of
 * toolkit components and forwards rendering to it, which keeps the keyboard
 * handling and the list geometry in one readable place.
 */
function buildSelector(
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  opts: ModelSelectorOptions,
  done: (choice: string | null) => void,
): Component & { focused: boolean } {
  const all = [AUTO_ENTRY, ...orderModels(opts.models, opts.current)];
  let matches = all;
  let selected = Math.max(0, all.findIndex((model) => entryValue(model) === opts.current));

  const root = new Container();
  const list = new Container();
  const search = new Input();

  root.addChild(border(theme));
  root.addChild(new Spacer(1));
  root.addChild(new Text(theme.fg("accent", theme.bold(`Model for ${opts.role}`)), 1, 0));
  root.addChild(new Text(theme.fg("muted", "Type to search, enter selects, escape keeps the current one."), 1, 0));
  root.addChild(new Spacer(1));
  root.addChild(search);
  root.addChild(new Spacer(1));
  root.addChild(list);
  root.addChild(new Spacer(1));
  root.addChild(border(theme));

  function render(): void {
    list.clear();
    if (matches.length === 0) {
      list.addChild(new Text(theme.fg("warning", "  No matching model"), 1, 0));
      return;
    }
    const { start, end } = listWindow(selected, matches.length, VISIBLE_MODELS);
    for (let i = start; i < end; i++) {
      const model = matches[i];
      const isSelected = i === selected;
      const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
      const label = isSelected ? theme.fg("accent", model.id) : model.id;
      const badge = model.provider === "" ? "" : " " + theme.fg("muted", `[${model.provider}]`);
      const check = entryValue(model) === opts.current ? theme.fg("success", " ✓") : "";
      list.addChild(new Text(`${prefix}${label}${badge}${check}`, 1, 0));
    }
    if (end - start < matches.length) {
      list.addChild(new Text(theme.fg("dim", `  ${counterText(selected, matches.length)}`), 1, 0));
    }
    list.addChild(new Spacer(1));
    list.addChild(new Text(theme.fg("muted", `  ${modelDetail(matches[selected])}`), 1, 0));
  }

  function move(delta: number): void {
    if (matches.length === 0) return;
    selected = (selected + delta + matches.length) % matches.length;
    render();
  }

  render();

  let focused = false;
  return {
    get focused(): boolean {
      return focused;
    },
    set focused(value: boolean) {
      focused = value;
      search.focused = value;
    },
    render: (width: number): string[] => root.render(width),
    invalidate: (): void => root.invalidate(),
    handleInput: (data: string): void => {
      if (keybindings.matches(data, "tui.select.up")) move(-1);
      else if (keybindings.matches(data, "tui.select.down")) move(1);
      else if (keybindings.matches(data, "tui.select.cancel")) done(null);
      else if (keybindings.matches(data, "tui.select.confirm")) {
        const model = matches[selected];
        done(model ? entryValue(model) : null);
      } else {
        search.handleInput(data);
        // Every keystroke re-narrows the list and puts the cursor back on the
        // first match, so a query typed in full never lands on a stale row.
        matches = filterModels(all, search.getValue());
        selected = 0;
        render();
      }
      tui.requestRender();
    },
  };
}

/**
 * Show the selector and return the chosen model. Cancelling keeps the model
 * configured for the role, which is why there is no explicit keep entry.
 */
export async function openModelSelector(
  ctx: ExtensionCommandContext,
  opts: ModelSelectorOptions,
): Promise<ModelChoice> {
  if (ctx.mode !== "tui") return { kind: "unsupported" };
  const picked = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) =>
    buildSelector(tui, theme, keybindings, opts, done),
  );
  return picked ? { kind: "picked", value: picked } : { kind: "cancelled" };
}
