// Shared paging helpers. The response shape ({ content, page, size, totalElements, totalPages })
// matches the Java/Spring version, so the same frontend works with both backends.

/** "id" | "id,asc" | "id,desc" -> SQL. Only whitelisted values reach this function (see schemas.js). */
function orderBy(sort) {
  if (sort === 'id,desc') {
    return 'ORDER BY id DESC';
  }
  return 'ORDER BY id ASC';
}

/** Rounds a distance to 2 decimals, e.g. 3.14159 -> 3.14. */
function roundTo2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Builds one page of results.
 * rows   = database rows for this page, total = number of rows in the whole table,
 * mapRow = function that turns one database row into the JSON object the API returns.
 */
function toPage(rows, total, paging, mapRow) {
  const content = [];
  for (const row of rows) {
    content.push(mapRow(row));
  }
  return {
    content: content,
    page: paging.page,
    size: paging.size,
    totalElements: total,
    totalPages: Math.ceil(total / paging.size), // e.g. 45 rows, 20 per page -> 3 pages
  };
}

module.exports = { orderBy, toPage, roundTo2 };
