'use strict';

const strings = require('../i18n/fr');

/**
 * Returns the localised string for a key, interpolating {variable} placeholders.
 * Falls back to the raw key if not found.
 * @param {string} key - Locale key (e.g. 'error.generic')
 * @param {Record<string, string|number>} [vars] - Variables to interpolate
 * @returns {string}
 */
function t(key, vars = {}) {
	let s = strings[key] ?? key;
	for (const [k, v] of Object.entries(vars)) {
		s = s.replaceAll(`{${k}}`, String(v));
	}
	return s;
}

module.exports = { t };
