// A stand-in for `supabase.from()` that keeps the one server behaviour a plain
// `mockResolvedValue` hides: PostgREST never answers a request with more than
// its `max_rows` (1000 in production), whatever `.limit()` the client sends,
// and it reports nothing when it cuts. A hook that reads a growing table in one
// request passes any test whose mock hands back the whole fixture; against this
// fake it gets the first 1000 rows, as it does in production.
//
//   const db = fakePostgrest({
//     students: [{ id: 'st-1' }],
//     set_logs: rows,                       // an array: the rows of the table
//     session_confirmations: { count: 12 }, // a response: { rows, count, error }
//     slot_deviations: (request) => […],    // a function of the request
//   });
//   supabase.from.mockImplementation(db.from);
//   …
//   expect(db.requestsTo('set_logs')).toHaveLength(2);
//
// What it does with a request:
//   - `.order(column)` sorts, `.gt()` / `.lt()` on a column of the row filter,
//     `.limit(n)` and `maxRows` cut — the three things paging depends on;
//   - every other filter (`.eq`, `.is`, `.in`, `.neq`, …) is RECORDED, not
//     applied: the fixture is taken to be what the WHERE clause lets through,
//     and a test asserts the filter on `request.filters`;
//   - `.maybeSingle()` resolves to the first row or null; `.single()` to the
//     row when there is exactly one, and to a PGRST116 error otherwise;
//   - `select(…, { head: true })` resolves to `{ count }` with no rows, the
//     count being the response's `count`, or the number of rows — never cut,
//     as a server-side count is not.
//
// Each awaited request is pushed to `requests` as
//   { table, select, options, filters: [[op, column, value], …], order, limit }

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const RECORDED_FILTERS = ['eq', 'neq', 'is', 'in', 'gt', 'gte', 'lt', 'lte', 'not', 'or'];

export function fakePostgrest(tables, { maxRows = 1000 } = {}) {
  const requests = [];

  function from(table) {
    const request = { table, select: null, options: null, filters: [], order: null, limit: null };

    const respond = () => {
      let source = tables[table];
      if (typeof source === 'function') source = source(request);
      const response = Array.isArray(source) ? { rows: source } : source || { rows: [] };
      if (response.error) return { data: null, count: null, error: response.error };

      let rows = [...(response.rows || [])];
      if (request.options?.head) {
        return { data: null, count: response.count ?? rows.length, error: null };
      }
      if (request.order) {
        const { column, ascending } = request.order;
        rows.sort((a, b) => (ascending ? 1 : -1) * compare(a[column], b[column]));
      }
      for (const [op, column, value] of request.filters) {
        if (op === 'gt') rows = rows.filter((r) => compare(r[column], value) > 0);
        if (op === 'lt') rows = rows.filter((r) => compare(r[column], value) < 0);
      }
      rows = rows.slice(0, Math.min(request.limit ?? Infinity, maxRows));
      return { data: rows, count: response.count ?? null, error: null };
    };

    const settle = () => {
      requests.push(request);
      return Promise.resolve(respond());
    };

    const builder = {
      select(columns, options) {
        request.select = columns;
        request.options = options || null;
        return builder;
      },
      order(column, { ascending = true } = {}) {
        request.order = { column, ascending };
        return builder;
      },
      limit(n) {
        request.limit = n;
        return builder;
      },
      maybeSingle: () => settle().then((res) => ({ ...res, data: res.data ? res.data[0] ?? null : null })),
      single: () =>
        settle().then((res) => {
          if (res.error) return res;
          if (res.data.length !== 1) {
            return {
              data: null,
              count: null,
              error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
            };
          }
          return { ...res, data: res.data[0] };
        }),
      then: (resolve, reject) => settle().then(resolve, reject),
    };
    for (const op of RECORDED_FILTERS) {
      builder[op] = (column, value) => {
        request.filters.push([op, column, value]);
        return builder;
      };
    }
    return builder;
  }

  return {
    from,
    requests,
    requestsTo: (table) => requests.filter((r) => r.table === table),
  };
}
