const crypto = require('node:crypto');

const adjectivesA = [
	'adorable','agile','audacieux','brillant','chatoyant','fabuleux','lumineux','merveilleux','sublime','courageux',
	'intrépide','rayonnant','formidable','fantastique','héroïque','incroyable','mythique','puissant','redoutable','sacré',
	'magnifique','mystérieux','légendaire','élégant','prestigieux','radieux','grandiose','divin','serein','glorieux',
	'gros','petit','énorme','ridicule','moche','crade','sale','puant','maladif','tordu',
	'stupide','idiot','débile','taré','cinglé','pervers','suspect','instable','hargneux','goujat',
	'cruel','sanguinaire','dangereux','vicieux','pernicieux','sournois','venimeux','raté','désespéré','pitoyable',
	'malchanceux','fainéant','bruyant','chiant','fourbe','roublard','mesquin','odieux','agressif','vicelard'
];

const animals = [
	'chat','chien','rat','souris','cheval','vache','cochon','mouton','chèvre','lapin',
	'renard','loup','ours','lynx','puma','tigre','lion','léopard','panthère','jaguar',
	'singe','gorille','chimpanzé','orang-outan','gibbon','raton-laveur','blaireau','putois','belette','furet',
	'hibou','chouette','aigle','faucon','corbeau','pie','perroquet','moineau','pigeon','pélican',
	'poisson','requin','dauphin','baleine','thon','méduse','pieuvre','calamar','crabe','homard',
	'grenouille','crapaud','salamandre','triton','lézard','iguane','gecko','crocodile','alligator','caméléon',
	'escargot','limace','araignée','fourmi','scarabée','cafard','moustique','mouche','guêpe','bourdon',
	'axolotl','ornithorynque','okapi','narval','pangolin','tatou','paresseux','manchot','koala','kangourou',
	'lama','alpaga','yack','bison','wapiti','chameau','dromadaire','autruche','émeu','casoar',
	'dragon','phénix','griffon','chimère','hydre','kraken','yéti','goule','zombie','squelette',
	'démon','troll','orc','gobelin','elfe','nécromancien','spectre','fantôme','licorne','pégase'
];

const adjectivesB = [
	'lumineux','sage','serein','céleste','angélique','radieux','vaillant','fier','curieux','loyal',
	'stupide','bête','débile','idiot','abruti','maladroit','gros','lourd','fatigué','bourré',
	'instable','taré','cinglé','dérangé','bizarre','louche','suspect','pervers','vicieux','moche',
	'grognon','grincheux','colérique','paresseux','lent','chiant','agaçant','énervé','aigris','dépressif',
	'violent','sanguinaire','psychopathe','démoniaque','hystérique','fou','zinzin','sombre','méchant','torturé'
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
