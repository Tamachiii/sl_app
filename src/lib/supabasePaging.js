// Reading EVERY row a PostgREST query matches.
//
// PostgREST answers one request with at most `db-max-rows` rows — 1000 on this
// project, the Supabase default — and says nothing when it cuts: the response
// is a plain 200 holding the first rows it found. A client `.limit(20000)` does
// not lift that ceiling, it can only lower it. So a read whose result can grow
// past one page has to ask again until the server has nothing left, which is
// what `fetchAllRows` does.
//
// It pages by KEYSET, not by offset: every request is ordered on a unique
// column and the next one starts strictly after the last key received
// (`order=id.asc&id=gt.<last>&limit=1000`). An offset walks positions, so a row
// inserted or deleted between two requests shifts every later position and a
// row is read twice or not at all; a keyset walks values, which do not move.

/**
 * Rows asked for per request. It must NOT exceed the project's API "Max rows"
 * setting: the loop ends on a page shorter than this, and a server that caps
 * lower would make every page look like the last one.
 */
export const PAGE_SIZE = 1000;

/**
 * Every row of a query, as one array in key order.
 *
 * `buildQuery` returns a NEW supabase query each time it is called — table,
 * select and filters, and nothing that positions the read: no `.order()`, no
 * `.limit()`, no `.range()`. The select must include the key column.
 *
 *   const logs = await fetchAllRows(() =>
 *     supabase.from('set_logs').select('id, done, …').eq('done', true)
 *   );
 *
 * Options (a bare number is read as `pageSize`):
 *   - pageSize   rows per request (default PAGE_SIZE)
 *   - column     the key the read walks (default 'id'). It must be UNIQUE and
 *                NOT NULL among the rows the query matches, or rows that share
 *                a key across a page boundary are lost.
 *   - ascending  direction of the walk (default true)
 *
 * The order of the result is the key's, which for a uuid means nothing: a
 * caller that needs rows by date sorts them itself.
 *
 * Throws the PostgREST error of the first page that fails — a partial result
 * is never returned.
 */
export async function fetchAllRows(buildQuery, options) {
  const {
    pageSize = PAGE_SIZE,
    column = 'id',
    ascending = true,
  } = typeof options === 'number' ? { pageSize: options } : options || {};

  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`fetchAllRows: pageSize must be a positive integer, got ${pageSize}`);
  }

  const rows = [];
  const seen = new Set();
  let cursor;
  let started = false;

  for (;;) {
    let query = buildQuery();
    if (started) query = ascending ? query.gt(column, cursor) : query.lt(column, cursor);
    const { data, error } = await query.order(column, { ascending }).limit(pageSize);
    if (error) throw error;

    const page = data || [];
    let fresh = 0;
    for (const row of page) {
      const key = row?.[column];
      // Checked on every page, the first included: a select that forgets the
      // key would otherwise work until the day a read needs its second page.
      if (key === undefined || key === null) {
        throw new Error(`fetchAllRows: a row has no "${column}" — the select must include it`);
      }
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
      fresh += 1;
    }

    // A short page is the end. A FULL page never is, even when it happens to
    // hold the last rows: the only way to know is to ask for what follows.
    if (page.length < pageSize) return rows;

    // A full page that brought nothing new means the cursor is not moving
    // (the key is not unique, or the server ignored the filter). Stopping
    // quietly here would be the truncation this function exists to prevent.
    if (fresh === 0) {
      throw new Error(`fetchAllRows: a full page added no new "${column}" — the read cannot advance`);
    }

    cursor = page[page.length - 1][column];
    started = true;
  }
}
