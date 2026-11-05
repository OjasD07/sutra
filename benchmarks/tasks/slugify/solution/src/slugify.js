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
  let slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const max = options.maxLength;
  if (max !== undefined && slug.length > max) {
    const cut = slug.slice(0, max + 1);
    const boundary = cut.lastIndexOf("-");
    slug = (boundary > 0 ? cut.slice(0, boundary) : slug.slice(0, max)).replace(/-+$/, "");
  }
  return slug;
}
