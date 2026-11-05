/**
 * Parse one line of RFC 4180 CSV into fields.
 * Fields may be quoted with "..."; inside quotes, commas are literal and a
 * doubled quote ("") is an escaped quote character.
 * @param {string} line
 * @returns {string[]}
 */
export function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      fields.push(field);
      field = "";
    } else field += ch;
  }
  fields.push(field);
  return fields;
}

/** Parse a whole document (one record per line, no embedded newlines). */
export function parseCsv(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map(parseCsvLine);
}
