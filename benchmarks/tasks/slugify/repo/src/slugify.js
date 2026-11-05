/**
 * Turn a title into a URL slug.
 *
 * - lower case, ASCII only (accents removed: "Crème" -> "creme")
 * - runs of anything that is not a letter or digit become a single "-"
 * - no leading or trailing "-"
 * - optional maxLength cuts at a word boundary and never leaves a trailing "-"
 *
 * @param {string} text
 * @param {{ maxLength?: number }} [options]
 * @returns {string}
 */
export function slugify(text, options = {}) {
  throw new Error("not implemented");
}
