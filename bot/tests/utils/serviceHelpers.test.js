'use strict';

const {
	normalizeColor,
	parseParticipants,
	formatParticipants,
	extractImageAttachment,
} = require('../../src/utils/serviceHelpers');

describe('normalizeColor', () => {
	it('returns null for falsy input', () => {
		expect(normalizeColor(null)).toBeNull();
		expect(normalizeColor('')).toBeNull();
		expect(normalizeColor(undefined)).toBeNull();
	});

	it('accepts 6-digit hex without hash', () => {
		expect(normalizeColor('5865f2')).toBe('#5865F2');
	});

	it('accepts 6-digit hex with hash', () => {
		expect(normalizeColor('#5865f2')).toBe('#5865F2');
	});

	it('uppercases the result', () => {
		expect(normalizeColor('aabbcc')).toBe('#AABBCC');
	});

	it('returns null for invalid hex', () => {
		expect(normalizeColor('xyz')).toBeNull();
		expect(normalizeColor('12345')).toBeNull();
		expect(normalizeColor('1234567')).toBeNull();
		expect(normalizeColor('GGGGGG')).toBeNull();
	});
});

describe('parseParticipants', () => {
	it('returns null/null for empty input', () => {
		expect(parseParticipants('')).toEqual({ min: null, max: null });
		expect(parseParticipants(null)).toEqual({ min: null, max: null });
	});

	it('parses min=X max=Y format', () => {
		expect(parseParticipants('min=4 max=10')).toEqual({ min: 4, max: 10 });
	});

	it('parses only max', () => {
		expect(parseParticipants('max=8')).toEqual({ min: null, max: 8 });
	});

	it('parses only min', () => {
		expect(parseParticipants('min=2')).toEqual({ min: 2, max: null });
	});

	it('parses X/Y pair format', () => {
		expect(parseParticipants('4/10')).toEqual({ min: 4, max: 10 });
	});

	it('parses single number as max', () => {
		expect(parseParticipants('10')).toEqual({ min: null, max: 10 });
	});

	it('swaps min/max when min > max', () => {
		expect(parseParticipants('min=10 max=4')).toEqual({ min: 4, max: 10 });
	});

	it('is case-insensitive', () => {
		expect(parseParticipants('MIN=2 MAX=6')).toEqual({ min: 2, max: 6 });
	});
});

describe('formatParticipants', () => {
	it('returns empty string for null', () => {
		expect(formatParticipants(null)).toBe('');
	});

	it('returns empty string when no participants set', () => {
		expect(formatParticipants({})).toBe('');
	});

	it('formats min and max', () => {
		expect(formatParticipants({ min_participants: 2, max_participants: 8 })).toBe('min=2 max=8');
	});

	it('formats only max', () => {
		expect(formatParticipants({ max_participants: 10 })).toBe('max=10');
	});

	it('formats only min', () => {
		expect(formatParticipants({ min_participants: 3 })).toBe('min=3');
	});
});

describe('extractImageAttachment', () => {
	it('returns null when no message', () => {
		expect(extractImageAttachment(null)).toBeNull();
	});

	it('returns null when no attachments', () => {
		expect(extractImageAttachment({ attachments: new Map() })).toBeNull();
	});

	it('returns attachment when contentType is image/', () => {
		const att = { contentType: 'image/png', url: 'https://cdn.discord.com/img.png' };
		const msg = { attachments: new Map([['1', att]]) };
		expect(extractImageAttachment(msg)).toBe(att);
	});

	it('returns attachment when URL matches image extension', () => {
		const att = { url: 'https://example.com/image.jpg' };
		const msg = { attachments: new Map([['1', att]]) };
		expect(extractImageAttachment(msg)).toBe(att);
	});

	it('returns null for non-image attachments', () => {
		const att = { contentType: 'text/plain', url: 'https://example.com/file.txt' };
		const msg = { attachments: new Map([['1', att]]) };
		expect(extractImageAttachment(msg)).toBeNull();
	});
});
