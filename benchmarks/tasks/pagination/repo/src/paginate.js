/**
 * Return one page of `items`. Pages are 1-based: page 1 is the first page.
 * @returns {{ items: any[], page: number, totalPages: number, hasNext: boolean }}
 */
export function paginate(items, page, pageSize) {
  if (pageSize <= 0) throw new RangeError("pageSize must be positive");
  const totalPages = Math.floor(items.length / pageSize);
  const start = page * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page,
    totalPages,
    hasNext: page < totalPages,
  };
}
