const crypto = require('node:crypto');
const slugify = require('slugify');
const sanitize = require('sanitize-filename');

function base64Url(buffer) {
	return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function randomCode(size = 16) {
	return base64Url(crypto.randomBytes(size));
}

function hashToBase64(value) {
	return base64Url(crypto.createHash('sha256').update(value).digest());
}

function buildSlug(input) {
	const cleaned = sanitize(input).replace(/[^\w\s-]/gu, '');
	return slugify(cleaned, { lower: true, strict: true });
}

function pseudonym(userId, zoneId, salt) {
	const hash = hashToBase64(`${userId}:${zoneId}:${salt}`);
	return `Anonymous-${hash.substring(0, 8)}`;
}

function shortId(len = 7) {
	return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

function makeId(namespace, ...parts) {
	if (typeof namespace !== 'string' || namespace.length === 0) {
		throw new TypeError('makeId requires a non-empty namespace');
	}
	const segments = [namespace, ...parts.map((part) => (part === null || part === undefined ? '' : String(part)))];
	return segments.join(':');
}

function parseId(value) {
	if (typeof value !== 'string' || value.length === 0) {
		return null;
	}
	const segments = value.split(':');
	const namespace = segments.shift();
	if (!namespace) {
		return null;
	}
	return {
		namespace,
		parts: segments,
		segments,
		raw: value
	};
}

module.exports = {
	base64Url,
	randomCode,
	hashToBase64,
	buildSlug,
	pseudonym,
	shortId,
	makeId,
	parseId
};
