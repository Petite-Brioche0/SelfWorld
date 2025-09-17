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

module.exports = {
	base64Url,
	randomCode,
	hashToBase64,
	buildSlug,
	pseudonym
};
