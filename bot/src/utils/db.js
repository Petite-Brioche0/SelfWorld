const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');

const baseConfig = {
	host: process.env.DB_HOST,
	port: process.env.DB_PORT || 3306,
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME
};

const poolConfig = {
	...baseConfig,
	connectionLimit: 10,
	namedPlaceholders: true,
	decimalNumbers: true
};

const ensureConfig = {
	...baseConfig,
	namedPlaceholders: true,
	decimalNumbers: true,
	multipleStatements: true
};

let pool;

function getPool() {
	if (!pool) {
		pool = mysql.createPool(poolConfig);
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
	const schemaPath = path.resolve(__dirname, '../../schema.sql');
	const contents = await fs.readFile(schemaPath, 'utf8');
	const statements = contents
		.split(';')
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);

	if (!statements.length) {
		return;
	}

	console.info('[db] Application du schéma');
	const connection = await mysql.createConnection(ensureConfig);
	try {
		for (const statement of statements) {
			await connection.query(statement);
		}
		console.info('[db] Schéma prêt');
	} finally {
		await connection.end();
	}
}

module.exports = {
	getPool,
	withTransaction,
	query,
	ensureSchema
};
