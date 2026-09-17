/**
 * Desktop notification for the events an operator must learn about while away
 * from the terminal. The in-session message is the record; this is the tap on
 * the shoulder, and a run that halts after hours is the case it exists for.
 *
 * The channel is the terminal's own notification escape sequence, the one the
 * agent CLI already uses for "ready for input": OSC 777 for most emulators,
 * OSC 99 for Kitty, a toast for Windows Terminal. Best-effort in every branch:
 * a terminal that ignores the sequence prints nothing, and a failure to write
 * never reaches the caller.
 */

import { execFile } from "node:child_process";

/** Terminals interpret the sequence up to the delimiter, so the parts are escaped. */
function sanitize(text: string): string {
  return text.replace(/[\x00-\x1f\x7f;]/g, " ").trim();
}

function windowsToastScript(title: string, body: string): string {
  const type = "Windows.UI.Notifications";
  const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
  const template = `[${type}.ToastTemplateType]::ToastText01`;
  const toast = `[${type}.ToastNotification]::new($xml)`;
  const escaped = body.replaceAll("'", "''");
  return [
    `${mgr} > $null`,
    `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
    `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${escaped}')) > $null`,
    `[${type}.ToastNotificationManager]::CreateToastNotifier('${title.replaceAll("'", "''")}').Show(${toast})`,
  ].join("; ");
}

/**
 * The escape sequence for the terminal in `env`, or null when the platform
 * wants a subprocess instead. Pure, so the choice is testable without a
 * terminal.
 */
export function notificationSequence(title: string, body: string, env: NodeJS.ProcessEnv): string | null {
  if (env.WT_SESSION) return null;
  const t = sanitize(title);
  const b = sanitize(body);
  if (env.KITTY_WINDOW_ID) {
    return `\x1b]99;i=1:d=0;${t}\x1b\\` + `\x1b]99;i=1:p=body;${b}\x1b\\`;
  }
  return `\x1b]777;notify;${t};${b}\x07`;
}

export interface PushNotifyDeps {
  execFile?: (file: string, args: string[], callback: () => void) => void;
}

/** Fire a desktop notification. Never throws. */
export function pushNotify(
  title: string,
  body: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: PushNotifyDeps = {},
): void {
  try {
    const sequence = notificationSequence(title, body, env);
    if (sequence === null) {
      // Never search the working directory or PATH for a notification executable.
      (deps.execFile ?? execFile)(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        ["-NoProfile", "-Command", windowsToastScript(title, body)],
        () => {},
      );
      return;
    }
    process.stdout.write(sequence);
  } catch {
    // A notification is never a reason for the loop to fail.
  }
}
