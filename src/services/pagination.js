// Shared paging helpers. The response shape ({ content, page, size, totalElements, totalPages })
// matches the Java/Spring version, so the same frontend works with both backends.

/** "id" | "id,asc" | "id,desc" -> SQL. Only whitelisted values reach this function (see schemas.js). */
function orderBy(sort) {
  return sort === 'id,desc' ? 'ORDER BY id DESC' : 'ORDER BY id ASC';
}

function toPage(rows, total, { page, size }, mapRow) {
  return {
    content: rows.map(mapRow),
    page,
    size,
    totalElements: total,
    totalPages: Math.ceil(total / size),
  };
}

module.exports = { orderBy, toPage };
