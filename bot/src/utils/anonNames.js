const crypto = require('node:crypto');

const adjectivesA = [
        'adorable',
        'agile',
        'atroce',
        'brillant',
        'chatoyant',
        'fabuleux',
        'lumineux',
        'malicieux',
        'merveilleux',
        'serein'
];

const animals = [
        'axolotl',
        'chat',
        'hippocampe',
        'lynx',
        'manchot',
        'phoque',
        'renard',
        'rhinocéros',
        'salamandre',
        'yéti'
];

const adjectivesB = [
        'aigris',
        'azur',
        'bohème',
        'borgne',
        'céleste',
        'farouche',
        'lumineux',
        'maladroit',
        'peureux',
        'polyglotte'
];

function pick(array, index) {
        return array[index % array.length];
}

function generateAnonName(seed) {
        const hash = crypto.createHash('sha256').update(String(seed)).digest();
        const a = hash.readUInt32BE(0);
        const b = hash.readUInt32BE(8);
        const c = hash.readUInt32BE(24);
        const first = pick(adjectivesA, a);
        const animal = pick(animals, b);
        const second = pick(adjectivesB, c);
        return `${first} ${animal} ${second}`;
}

module.exports = { generateAnonName };
