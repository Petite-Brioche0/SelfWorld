const path = require('node:path');
const fs = require('node:fs/promises');
const mysql = require('mysql2/promise');

let pool;

function getPool() {
	if (!pool) {
		pool = mysql.createPool({
			host: process.env.DB_HOST,
			port: process.env.DB_PORT || 3306,
			user: process.env.DB_USER,
			password: process.env.DB_PASSWORD,
			database: process.env.DB_NAME,
			connectionLimit: 10,
			namedPlaceholders: true,
			decimalNumbers: true,
			multipleStatements: true
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

async function ensureSchema() {
	const schemaPath = path.join(__dirname, '..', '..', 'schema.sql');
	const content = await fs.readFile(schemaPath, 'utf8');
	const sanitized = content
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/--.*$/gm, '')
		.trim();

	if (!sanitized.length) {
		return;
	}

	const statements = sanitized
		.split(';')
		.map((stmt) => stmt.trim())
		.filter((stmt) => stmt.length);

	if (!statements.length) {
		return;
	}

	const connection = await getPool().getConnection();

	try {
		const sql = statements.map((stmt) => `${stmt};`).join('\n');
		await connection.query(sql);
	} finally {
		connection.release();
	}
}

module.exports = {
	getPool,
	withTransaction,
	query,
	ensureSchema
};
