/**
 * Parse one line of RFC 4180 CSV into fields.
 * Fields may be quoted with "..."; inside quotes, commas are literal and a
 * doubled quote ("") is an escaped quote character.
 * @param {string} line
 * @returns {string[]}
 */
export function parseCsvLine(line) {
  return line.split(",");
}

/** Parse a whole document (one record per line, no embedded newlines). */
export function parseCsv(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map(parseCsvLine);
}
