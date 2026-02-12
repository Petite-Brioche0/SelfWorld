const NAME_MAX = 64;
const NAME_MIN = 3;
const DESCRIPTION_MAX = 500;

const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\s'’\-_.()!?]+$/u;

function sanitizeName(raw) {
        if (typeof raw !== 'string') return '';
        return raw.replace(/\s+/g, ' ').trim();
}

function validateZoneName(raw) {
        const value = sanitizeName(raw).slice(0, NAME_MAX);
        const errors = [];
        if (!value) {
                errors.push('Nom requis.');
        } else {
                if (value.length < NAME_MIN) {
                        errors.push(`Nom trop court (min ${NAME_MIN} caractères).`);
                }
                if (!NAME_PATTERN.test(value)) {
                        errors.push('Nom invalide : caractères spéciaux non autorisés.');
                }
        }
        return { value, errors };
}

function validateZoneDescription(raw, max = DESCRIPTION_MAX) {
        if (typeof max !== 'number' || max <= 0) max = DESCRIPTION_MAX;
        const trimmed = typeof raw === 'string' ? raw.trim() : '';
        const value = trimmed.slice(0, max);
        const errors = [];
        if (!value) {
                errors.push('Description requise.');
        }
        if (trimmed.length > max) {
                errors.push(`Description trop longue (max ${max} caractères).`);
        }
        return { value, errors };
}

module.exports = {
        NAME_MAX,
        DESCRIPTION_MAX,
        validateZoneName,
        validateZoneDescription,
        sanitizeName
};
