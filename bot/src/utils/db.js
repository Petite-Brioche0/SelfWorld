const mysql = require('mysql2/promise');

let pool;

function getPool() {
	if (!pool) {
		pool = mysql.createPool({
			host: process.env.DB_HOST,
			user: process.env.DB_USER,
			password: process.env.DB_PASSWORD,
			database: process.env.DB_NAME,
			connectionLimit: 10,
			namedPlaceholders: true,
			decimalNumbers: true
		});
	}
	return pool;
}

async function withTransaction(cb) {
	const conn = await getPool().getConnection();
	try {
		await conn.beginTransaction();
		const result = await cb(conn);
		await conn.commit();
		return result;
	} catch (error) {
		await conn.rollback();
		throw error;
	} finally {
		conn.release();
	}
}

async function query(sql, params = {}) {
	const [rows] = await getPool().query(sql, params);
	return rows;
}

module.exports = {
	getPool,
	withTransaction,
	query
};
