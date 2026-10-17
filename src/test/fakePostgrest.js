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
//   - `.order(column)` sorts — several calls sort by the first, then the next,
//     as PostgREST does —, `.gt()` / `.lt()` on a column of the row filter,
//     `.range(from, to)` skips and cuts, `.limit(n)` and `maxRows` cut — the
//     things paging depends on;
//   - every other filter (`.eq`, `.is`, `.in`, `.neq`, `.not`, …) is RECORDED
//     with every argument it was given, not applied: the fixture is taken to
//     be what the WHERE clause lets through, and a test asserts the filter on
//     `request.filters` (or a table function applies it);
//   - `.maybeSingle()` resolves to the first row or null; `.single()` to the
//     row when there is exactly one, and to a PGRST116 error otherwise;
//   - `select(…, { head: true })` resolves to `{ count }` with no rows, the
//     count being the response's `count`, or the number of rows — never cut,
//     as a server-side count is not;
//   - `.abortSignal(signal)` is accepted and changes nothing.
//
// Each awaited request is pushed to `requests` as
//   { table, select, options, filters: [[op, column, value], …], order, limit }
// plus `orders` (every `.order()`, in the order they were called; `order` is
// the last of them) and `range` ({ from, to }) when the request has them.

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
      const orders = request.orders || [];
      if (orders.length) {
        rows.sort((a, b) => {
          for (const { column, ascending } of orders) {
            const order = compare(a[column], b[column]);
            if (order !== 0) return ascending ? order : -order;
          }
          return 0;
        });
      }
      for (const [op, column, value] of request.filters) {
        if (op === 'gt') rows = rows.filter((r) => compare(r[column], value) > 0);
        if (op === 'lt') rows = rows.filter((r) => compare(r[column], value) < 0);
      }
      if (request.range) rows = rows.slice(request.range.from, request.range.to + 1);
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
        request.orders = [...(request.orders || []), request.order];
        return builder;
      },
      range(from, to) {
        request.range = { from, to };
        return builder;
      },
      limit(n) {
        request.limit = n;
        return builder;
      },
      // The client's own way to drop a request: the answer is the same.
      abortSignal() {
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
      // `.not(column, operator, value)` takes three: every argument is kept.
      builder[op] = (...args) => {
        request.filters.push([op, ...args]);
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
