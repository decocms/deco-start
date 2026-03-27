/**
 * Terminal color utilities — keeps output readable without adding dependencies.
 */

const isColorSupported =
  typeof process !== "undefined" &&
  process.stdout?.isTTY &&
  !process.env.NO_COLOR;

function wrap(code: number, resetCode: number) {
  return (text: string) =>
    isColorSupported ? `\x1b[${code}m${text}\x1b[${resetCode}m` : text;
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const cyan = wrap(36, 39);
export const gray = wrap(90, 39);

export const icons = {
  success: isColorSupported ? "\x1b[32m✓\x1b[0m" : "[OK]",
  error: isColorSupported ? "\x1b[31m✗\x1b[0m" : "[FAIL]",
  warning: isColorSupported ? "\x1b[33m⚠\x1b[0m" : "[WARN]",
  info: isColorSupported ? "\x1b[34mℹ\x1b[0m" : "[INFO]",
  arrow: isColorSupported ? "\x1b[36m→\x1b[0m" : "->",
  bullet: isColorSupported ? "\x1b[90m•\x1b[0m" : "-",
};

export function banner(text: string) {
  const line = "═".repeat(58);
  console.log(`\n${cyan(`╔${line}╗`)}`);
  console.log(`${cyan("║")}  ${bold(text.padEnd(56))}${cyan("║")}`);
  console.log(`${cyan(`╚${line}╝`)}`);
}

export function phase(name: string) {
  console.log(`\n${bold(blue(`━━━ ${name} ━━━`))}\n`);
}

export function stat(label: string, value: string | number) {
  console.log(`  ${gray(label + ":")} ${bold(String(value))}`);
}
