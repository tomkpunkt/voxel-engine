// Waffen, Gegenstände und Beutetabellen. Reichweiten in Voxeln (5 pro Meter).
export const WEAP = {
  fists: { name: 'Fäuste', melee: true, dmg: 0.55, range: 4.5, arc: 1.2, cd: 0.42, noise: 8, st: 6 },
  bat: { name: 'Baseballschläger', melee: true, dmg: 1.5, range: 6.5, arc: 1.6, cd: 0.5, noise: 10, st: 12 },
  axe: { name: 'Feueraxt', melee: true, dmg: 2.8, range: 7, arc: 1.2, cd: 0.75, noise: 10, st: 20 },
  pistol: { name: 'Pistole', ammo: 'a9', mag: 12, dmg: 1.1, rate: 0.22, spread: 0.03, pellets: 1, reload: 1.2, noise: 150, range: 150 },
  shotgun: { name: 'Schrotflinte', ammo: 'a12', mag: 6, dmg: 0.7, rate: 0.8, spread: 0.18, pellets: 7, reload: 2.2, noise: 220, range: 70 },
  rifle: { name: 'Sturmgewehr', ammo: 'a556', mag: 30, dmg: 1.1, rate: 0.1, spread: 0.045, pellets: 1, reload: 1.9, noise: 200, range: 220 },
};
export const ITEMS = {
  bat: { n: 'Baseballschläger', ic: '🏏', t: 'w', st: 1 }, axe: { n: 'Feueraxt', ic: '🪓', t: 'w', st: 1 },
  pistol: { n: 'Pistole', ic: '🔫', t: 'w', st: 1 }, shotgun: { n: 'Schrotflinte', ic: '💥', t: 'w', st: 1 }, rifle: { n: 'Sturmgewehr', ic: '🎯', t: 'w', st: 1 },
  a9: { n: '9mm-Patronen', ic: '⁘', t: 'a', st: 60 }, a12: { n: 'Schrotpatronen', ic: '⁙', t: 'a', st: 30 }, a556: { n: '5,56-Patronen', ic: '⁖', t: 'a', st: 90 },
  bandage: { n: 'Verband', ic: '🩹', t: 'h', heal: 20, st: 10 }, medkit: { n: 'Erste-Hilfe-Kasten', ic: '✚', t: 'h', heal: 60, st: 3 },
  food: { n: 'Konserve', ic: '🥫', t: 'h', heal: 8, st: 10 }, choc: { n: 'Schokoriegel', ic: '🍫', t: 'h', heal: 5, st: 10 },
  battery: { n: 'Batterie', ic: '🔋', t: 'b', st: 10 },
};
export const LOOT = {
  kuehl: [['food', .7, 1, 2], ['choc', .3, 1, 1]],
  schrank: [['bandage', .45, 1, 2], ['battery', .3, 1, 1], ['a9', .28, 6, 14], ['pistol', .08, 1, 1], ['bat', .12, 1, 1], ['choc', .2, 1, 1]],
  regal_s: [['food', .8, 1, 3], ['choc', .5, 1, 2], ['battery', .4, 1, 2], ['bandage', .2, 1, 1]],
  regal_a: [['bandage', .8, 1, 3], ['medkit', .35, 1, 1], ['battery', .2, 1, 1]],
  regal_w: [['a9', .7, 12, 24], ['a12', .55, 6, 12], ['a556', .4, 15, 30], ['pistol', .25, 1, 1], ['shotgun', .2, 1, 1], ['rifle', .12, 1, 1], ['axe', .15, 1, 1]],
  auto: [['a12', .3, 4, 8], ['battery', .3, 1, 1], ['bat', .1, 1, 1], ['axe', .08, 1, 1], ['shotgun', .06, 1, 1], ['bandage', .25, 1, 1], ['food', .2, 1, 1]],
  kiste: [['a9', .35, 6, 12], ['a12', .25, 4, 8], ['food', .3, 1, 2], ['battery', .3, 1, 1], ['axe', .1, 1, 1]],
  zombie: [['a9', .1, 3, 8], ['bandage', .07, 1, 1], ['battery', .05, 1, 1], ['choc', .05, 1, 1]],
  kuechenschrank: [['food', .7, 1, 3], ['choc', .4, 1, 2]],
  buecher: [['choc', .1, 1, 1], ['battery', .15, 1, 1], ['a9', .08, 3, 6]],
  bad: [['bandage', .6, 1, 2], ['medkit', .12, 1, 1]],
  schreibtisch: [['battery', .4, 1, 1], ['a9', .2, 4, 10], ['pistol', .05, 1, 1], ['choc', .2, 1, 1]],
  lager_regal_s: [['food', .9, 2, 4], ['battery', .5, 1, 2], ['choc', .5, 1, 3]],
  lager_regal_a: [['bandage', .9, 2, 4], ['medkit', .5, 1, 2]],
  lager_regal_w: [['a9', .8, 12, 30], ['a12', .6, 6, 14], ['a556', .5, 20, 40], ['shotgun', .25, 1, 1], ['rifle', .18, 1, 1], ['pistol', .3, 1, 1]],
};
export const rollLoot = kind => { const out = []; for (const [id, p, a, b] of LOOT[kind] || []) if (Math.random() < p) out.push({ id, n: a + Math.floor(Math.random() * (b - a + 1)) }); return out; };
