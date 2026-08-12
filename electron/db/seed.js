/**
 * Pre-populates leagues/teams so the country -> league -> team pickers
 * aren't empty, and keeps the current season available for every league.
 * Both seedLeaguesAndTeams() and ensureCurrentSeasons() run on every app
 * start but check before inserting, so they never duplicate or touch
 * anything the user has already added or edited.
 *
 * Club lists reflect the 2025-26 season (researched, not guessed); the two
 * lowest Greek tiers are regionalized into groups in real life but are
 * flattened into one league each here since the schema doesn't model
 * divisions/groups.
 */
const LEAGUES = [
  {
    name: 'Greek Basket League',
    country: 'Greece',
    tier: 'greek_gbl',
    teams: [
      'AEK', 'Aris', 'Iraklis', 'Karditsa', 'Kolossos Rodou', 'Maroussi', 'Mykonos',
      'Olympiacos', 'Panathinaikos', 'Panionios', 'PAOK', 'Peristeri', 'Promitheas Patras',
    ],
  },
  {
    name: 'Elite League',
    country: 'Greece',
    tier: 'greek_a2',
    teams: [
      'AGE Chalkida', 'Egaleo', 'Vikos Falcons Ioannina', 'Dafni', 'Doxa Lefkada',
      'Koroivos Amaliadas', 'Lavrio', 'Machites Pefkis', 'Megarida', 'Niki Volou',
      'Panerythraikos', 'Papagou', 'Proteas Voulas', 'Sofades', 'Trikala', 'Psychiko',
    ],
  },
  {
    name: 'National League 1',
    country: 'Greece',
    tier: 'greek_b',
    teams: [
      'AO Amyntas', 'Panellinios', 'Cholargos', 'Palaio Faliro', 'Near East', 'Ionikos Nikaias',
      'Anagennisi Karditsas', 'Elefsina', 'Milonas', 'Dafni Agiou Dimitriou', 'Ermis Argyroupolis',
      'OFI', 'Fanaria Naxou',
      'Kronos Agiou Dimitriou', 'Promitheas 2014', 'Glaykos Esperou', 'Panelefsiniakos',
      'Ethnikos Livadeias', 'Apollon Patras', 'Pagrati', 'Ilysiakos', 'Ionios Kerkyras',
      'Saronidas', 'Esperos Lamias', 'Nea Kifissia', 'Esperos Kallitheas',
      'Komotini', 'HANTH Thessaloniki', 'Europi 87', 'Ionikos Ionias', 'Eleftheroupoli',
      'Panorama Kavalas', 'Drama', 'Pierikos Arxelaos', 'Gefyra', 'Lefkippos Xanthis',
      'DEKA', 'Aretsou Kalamarias', 'Panserraikos',
    ],
  },
  {
    name: 'National League 2',
    country: 'Greece',
    tier: 'greek_c',
    teams: [
      'Gargalianoi', 'Panachaiki', 'Achaia 82', 'Neo Lixouri', 'Vartholomio', 'Doxa Pyrrou Artas',
      'Tiroi Agion Theodoron', 'Koropi', 'Kalamata', 'Acheron Kanalakiou', 'Pigasos Thireas',
      'Doukas', 'Ikaros Kallitheas', 'Apollon Smyrnis', 'Kadmos Thivas', 'Agia Paraskevi',
      'Porfyras', 'Pikermi', 'Lykovrysi', 'Ippokratis', 'Niki Amarousiou', 'Ermis Peiraia',
      'Filathlitikos Zografou', 'Panaxiakos', 'Agioi Anargyroi', 'Melissia', 'Athinaikos',
      'Rethymno Cretan Kings', 'Asteras Agiou Dimitriou', 'Ilioupoli', 'Pefki',
      'Ikaros Neas Smyrnis', 'Eleutheria Moschatou',
      'Anagennisi Karditsas II', 'Edipsos', 'Anorthosi Volou', 'Proteas Grevenon',
      'Ampelonas Larissas', 'Filippos Veroias', 'Aristotelis Florinas', 'Dioskouroi Kozanis',
      'Panthires', 'Megas Alexandros Giannitson', 'Argos Orestiko', 'Titanes Palamas',
      'Fryganioti', 'Vassilakis', 'Aspis Xanthis', 'Stavroupoli', 'Galatista',
      'Prosotsani Dramas', 'Varvara Kavalas', 'Ermis Lagkadas', 'Olympos', 'Aias Evosmou',
      'Akadimia Moudanion',
    ],
  },
  {
    name: 'Liga ACB',
    country: 'Spain',
    teams: [
      'Real Madrid', 'FC Barcelona', 'Unicaja', 'Valencia Basket', 'Baskonia',
      'Joventut Badalona', 'Girona', 'Manresa', 'Casademont Zaragoza', 'Coviran Granada',
      'Gran Canaria', 'Hiopos Lleida', 'La Laguna Tenerife', 'MoraBanc Andorra', 'Burgos',
      'Río Breogán', 'Bilbao Basket', 'UCAM Murcia',
    ],
  },
  {
    name: 'Lega Basket Serie A',
    country: 'Italy',
    teams: [
      'Olimpia Milano', 'Virtus Bologna', 'Reyer Venezia', 'Trapani Shark', 'Napoli Basket',
      'Trento', 'Brescia', 'Cantù', 'Sassari', 'Tortona', 'Reggio Emilia', 'Treviso',
      'Varese', 'Trieste', 'Udine',
    ],
  },
  {
    name: 'Turkish Basketball Super League',
    country: 'Turkey',
    teams: [
      'Fenerbahçe Beko', 'Anadolu Efes', 'Galatasaray', 'Beşiktaş Gain', 'Türk Telekom',
      'Bahçeşehir Koleji', 'Tofaş', 'Bursaspor', 'Karşıyaka', 'Manisa Basket', 'Mersin MSK',
      'Büyükçekmece', 'Petkim Spor', 'Safiport Erokspor', 'Trabzonspor', 'Merkezefendi Basket',
    ],
  },
  {
    name: 'Betclic Élite',
    country: 'France',
    teams: [
      'AS Monaco', 'Paris Basketball', 'Nanterre 92', 'LDLC ASVEL', 'Cholet Basket', 'Le Mans',
      'JL Bourg', 'SIG Strasbourg', 'Élan Chalon', 'SLUC Nancy', 'JDA Dijon', 'Boulazac',
      'Limoges CSP', 'BCM Gravelines-Dunkerque', 'Saint-Quentin', 'ESSM Le Portel',
    ],
  },
  {
    name: 'Basketball Bundesliga',
    country: 'Germany',
    teams: [
      'Bamberg Baskets', 'Alba Berlin', 'Telekom Baskets Bonn', 'Löwen Braunschweig',
      'Niners Chemnitz', 'Skyliners Frankfurt', 'Veolia Towers Hamburg',
      'MLP Academics Heidelberg', 'Science City Jena', 'MHP Riesen Ludwigsburg',
      'Syntainics MBC', 'Bayern Munich', 'EWE Baskets Oldenburg', 'Rostock Seawolves',
      'Gladiators Trier', 'Ratiopharm Ulm', 'SC Rasta Vechta', 'Würzburg Baskets',
    ],
  },
  {
    name: 'ABA League',
    country: 'Regional',
    tier: 'regional_balkans',
    teams: [
      'Partizan', 'Crvena Zvezda', 'Mega', 'FMP', 'Spartak Subotica', 'Borac Čačak',
      'Cedevita Olimpija', 'Krka', 'Ilirija', 'Split', 'Zadar', 'Budućnost',
      'Studentski Centar', 'Igokea', 'Bosna', 'U-BT Cluj-Napoca', 'BC Vienna',
    ],
  },
  {
    name: 'LKL',
    country: 'Lithuania',
    teams: [
      'Žalgiris', 'Rytas', 'Neptūnas', 'Lietkabelis', 'Juventus', 'Šiauliai', 'Nevėžis',
      'Jonava', 'Gargždai',
    ],
  },
  {
    name: 'Israeli Basketball Premier League',
    country: 'Israel',
    teams: [
      'Maccabi Tel Aviv', 'Hapoel Tel Aviv', 'Hapoel Jerusalem', 'Bnei Herzliya',
      'Hapoel Holon', "Hapoel HaEmek", 'Maccabi Rishon LeZion', "Hapoel Be'er Sheva",
      'Maccabi Ironi Ramat Gan', 'Ironi Kiryat Ata', 'Ironi Ness Ziona',
      'Hapoel Galil Elyon', 'Elitzur Netanya', "Maccabi Ironi Ra'anana",
    ],
  },
  {
    name: 'EuroLeague',
    country: 'Europe',
    tier: 'euroleague',
    teams: [
      'Real Madrid', 'Barcelona', 'Baskonia', 'Valencia Basket', 'Olympiacos', 'Panathinaikos',
      'Fenerbahçe Beko', 'Anadolu Efes', 'Maccabi Tel Aviv', 'Hapoel Tel Aviv', 'ASVEL',
      'AS Monaco', 'Paris Basketball', 'Olimpia Milano', 'Virtus Bologna', 'Bayern Munich',
      'Žalgiris', 'Crvena Zvezda', 'Partizan', 'Dubai Basketball',
    ],
  },
  {
    name: 'EuroCup',
    country: 'Europe',
    tier: 'eurocup',
    teams: [
      'Hapoel Jerusalem', 'Bahçeşehir Koleji', 'Beşiktaş Gain', 'Türk Telekom',
      'Cedevita Olimpija', 'Reyer Venezia', 'Trento', 'Baxi Manresa', 'U-BT Cluj-Napoca',
      'Aris', 'Neptūnas', 'Lietkabelis', 'Śląsk Wrocław', 'Veolia Towers Hamburg',
      'Niners Chemnitz', 'Ratiopharm Ulm', 'JL Bourg', 'London Lions', 'Budućnost', 'Panionios',
    ],
  },

  // National cup competitions — one per country, alongside that country's
  // league(s) above. Participant lists mirror each country's top-flight
  // league for now (real domestic cups often also draw qualifiers from
  // lower divisions, but the top-flight clubs are who's actually likely to
  // have games entered here).
  {
    name: 'Greek Cup',
    country: 'Greece',
    tier: 'greek_cup',
    teams: [
      'AEK', 'Aris', 'Iraklis', 'Karditsa', 'Kolossos Rodou', 'Maroussi', 'Mykonos',
      'Olympiacos', 'Panathinaikos', 'Panionios', 'PAOK', 'Peristeri', 'Promitheas Patras',
    ],
  },
  {
    name: 'Copa del Rey',
    country: 'Spain',
    tier: 'spanish_cup',
    teams: [
      'Real Madrid', 'FC Barcelona', 'Unicaja', 'Valencia Basket', 'Baskonia',
      'Joventut Badalona', 'Girona', 'Manresa', 'Casademont Zaragoza', 'Coviran Granada',
      'Gran Canaria', 'Hiopos Lleida', 'La Laguna Tenerife', 'MoraBanc Andorra', 'Burgos',
      'Río Breogán', 'Bilbao Basket', 'UCAM Murcia',
    ],
  },
  {
    name: 'Coppa Italia',
    country: 'Italy',
    tier: 'italian_cup',
    teams: [
      'Olimpia Milano', 'Virtus Bologna', 'Reyer Venezia', 'Trapani Shark', 'Napoli Basket',
      'Trento', 'Brescia', 'Cantù', 'Sassari', 'Tortona', 'Reggio Emilia', 'Treviso',
      'Varese', 'Trieste', 'Udine',
    ],
  },
  {
    name: 'Turkish Cup',
    country: 'Turkey',
    tier: 'turkish_cup',
    teams: [
      'Fenerbahçe Beko', 'Anadolu Efes', 'Galatasaray', 'Beşiktaş Gain', 'Türk Telekom',
      'Bahçeşehir Koleji', 'Tofaş', 'Bursaspor', 'Karşıyaka', 'Manisa Basket', 'Mersin MSK',
      'Büyükçekmece', 'Petkim Spor', 'Safiport Erokspor', 'Trabzonspor', 'Merkezefendi Basket',
    ],
  },
  {
    name: 'Coupe de France',
    country: 'France',
    tier: 'french_cup',
    teams: [
      'AS Monaco', 'Paris Basketball', 'Nanterre 92', 'LDLC ASVEL', 'Cholet Basket', 'Le Mans',
      'JL Bourg', 'SIG Strasbourg', 'Élan Chalon', 'SLUC Nancy', 'JDA Dijon', 'Boulazac',
      'Limoges CSP', 'BCM Gravelines-Dunkerque', 'Saint-Quentin', 'ESSM Le Portel',
    ],
  },
  {
    name: 'BBL-Pokal',
    country: 'Germany',
    tier: 'german_cup',
    teams: [
      'Bamberg Baskets', 'Alba Berlin', 'Telekom Baskets Bonn', 'Löwen Braunschweig',
      'Niners Chemnitz', 'Skyliners Frankfurt', 'Veolia Towers Hamburg',
      'MLP Academics Heidelberg', 'Science City Jena', 'MHP Riesen Ludwigsburg',
      'Syntainics MBC', 'Bayern Munich', 'EWE Baskets Oldenburg', 'Rostock Seawolves',
      'Gladiators Trier', 'Ratiopharm Ulm', 'SC Rasta Vechta', 'Würzburg Baskets',
    ],
  },
  {
    name: 'LKL Cup',
    country: 'Lithuania',
    tier: 'lithuanian_cup',
    teams: [
      'Žalgiris', 'Rytas', 'Neptūnas', 'Lietkabelis', 'Juventus', 'Šiauliai', 'Nevėžis',
      'Jonava', 'Gargždai',
    ],
  },
  {
    name: 'Israeli State Cup',
    country: 'Israel',
    tier: 'israeli_cup',
    teams: [
      'Maccabi Tel Aviv', 'Hapoel Tel Aviv', 'Hapoel Jerusalem', 'Bnei Herzliya',
      'Hapoel Holon', "Hapoel HaEmek", 'Maccabi Rishon LeZion', "Hapoel Be'er Sheva",
      'Maccabi Ironi Ramat Gan', 'Ironi Kiryat Ata', 'Ironi Ness Ziona',
      'Hapoel Galil Elyon', 'Elitzur Netanya', "Maccabi Ironi Ra'anana",
    ],
  },
];

/**
 * Idempotent, additive: checks each league/team by name before inserting,
 * so it's safe to run on every app start. This is what makes seeding
 * self-healing for a DB that already had some hand-created leagues/teams
 * before this seed list existed — it fills in whatever's missing without
 * touching or duplicating anything the user already made.
 */
function seedLeaguesAndTeams(db) {
  const findLeague = db.prepare(`SELECT id FROM leagues WHERE name = ?`);
  const insertLeague = db.prepare(
    `INSERT INTO leagues (name, country, tier, source) VALUES (?, ?, ?, 'public_api')`
  );
  const findTeam = db.prepare(`SELECT id FROM teams WHERE league_id = ? AND name = ?`);
  const insertTeam = db.prepare(`INSERT INTO teams (league_id, name, is_my_team) VALUES (?, ?, 0)`);

  const seedTx = db.transaction(() => {
    for (const league of LEAGUES) {
      const existingLeague = findLeague.get(league.name);
      const leagueId = existingLeague
        ? existingLeague.id
        : insertLeague.run(league.name, league.country, league.tier || null).lastInsertRowid;

      for (const teamName of league.teams) {
        if (!findTeam.get(leagueId, teamName)) insertTeam.run(leagueId, teamName);
      }
    }
  });

  seedTx();
}

/**
 * Basketball seasons span two calendar years and roll over around
 * August/September. "2026-27" starts in fall 2026 and runs through
 * mid-2027 — so from August onward the season named after the current
 * year is "current"; before that, it's still last year's season.
 */
function currentSeasonLabel(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const startYear = month >= 8 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/**
 * Ensures every league has a season row for the current season (per
 * currentSeasonLabel), additively — never removes or touches past
 * seasons. Runs on every app start, so as real time crosses into a new
 * season, the next launch adds it automatically alongside every earlier
 * one, for every league (seeded or user-created).
 */
function ensureCurrentSeasons(db) {
  const label = currentSeasonLabel();
  const leagues = db.prepare(`SELECT id FROM leagues`).all();
  const findSeason = db.prepare(`SELECT id FROM seasons WHERE league_id = ? AND year = ?`);
  const insertSeason = db.prepare(`INSERT INTO seasons (league_id, year) VALUES (?, ?)`);

  const tx = db.transaction(() => {
    for (const league of leagues) {
      if (!findSeason.get(league.id, label)) insertSeason.run(league.id, label);
    }
  });

  tx();
}

module.exports = { seedLeaguesAndTeams, currentSeasonLabel, ensureCurrentSeasons };
