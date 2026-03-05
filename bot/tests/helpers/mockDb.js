'use strict';

/**
 * Creates a mock database pool with a configurable .query() spy.
 * Usage: const db = mockDb({ rows: [...] }) — query returns [rows, fields]
 */
function mockDb(defaults = {}) {
	const calls = [];
	const db = {
		calls,
		rows: defaults.rows ?? [],
		insertId: defaults.insertId ?? 0,
		query: async (sql, params) => {
			calls.push({ sql, params });
			if (typeof db._queryFn === 'function') {
				return db._queryFn(sql, params);
			}
			const rows = db.rows;
			return [Array.isArray(rows) ? rows : [], { insertId: db.insertId }];
		},
		reset() {
			calls.length = 0;
		}
	};
	return db;
}

module.exports = { mockDb };
