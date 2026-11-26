// Données communes à la grille A4 (grille-gms.html), au flyer (flyer-gms.html)
// et au dépliant 3 volets (depliant-gms.html). Changer un prix, un EAN ou un
// texte ici, puis relancer generer-pdf.mjs : tous les PDF sont refaits avec
// les mêmes chiffres.
/* ======================== DONNÉES À METTRE À JOUR ======================== */
const CONTACT = { tel: "09 67 48 99 63", mail: "brasserieguedesmoines@gmail.com" };
const SOCIETE = "SAS Paille Freyburger au capital de 5 000 € · RCS Toulouse 809 295 553 · SIRET 809 295 553 00022 · APE 1105Z · N° TVA FR48 809 295 553";
const CONDITIONS = "Prix hors taxes par bouteille, droits d’accises inclus, hors transport.";

// Prix HT par bouteille. Un prix propre à une bière se met dans GAMME
// (ex. prix: { "33": 2.10 }) : il remplace alors celui du format.
const TARIFS = {
  "33": { libelle: "33 cl", colis: 24, prixHT: 1.90, pvc: 3.10 },
  "75": { libelle: "75 cl", colis: 6,  prixHT: 3.80, pvc: 6.20 },
};

// c = couleur de l'étiquette (repère visuel dans la grille).
// photo : facultatif, par défaut assets/bottle_<id>.png ; absente = emplacement « visuel à venir ».
const GAMME = [
  { id:"blonde",  nom:"Blonde",  style:"Blonde Pale Ale",    degre:4.5, c:"#F2EFC6", ean:{ "33":"3770005751128", "75":"3770005751340" },
    desc:"Une Pale Ale légère aux délicates notes de miel, appréciée de tous. C’est la plus classique de nos bières." },
  { id:"blanche", nom:"Blanche", style:"Blanche",            degre:5.8, c:"#B9DAD4", ean:{ "33":"3770005751098", "75":"3770005751357" },
    desc:"Brassée avec une levure saison qui lui apporte de la rondeur en bouche. Ses saveurs d’agrumes et de banane la rendent rafraîchissante." },
  { id:"ambree",  nom:"Ambrée",  style:"Ambrée",             degre:5.8, c:"#E5492E", ean:{ "33":"3770005751111", "75":"3770005751319" },
    desc:"Une ambrée aromatique à la belle rondeur en bouche, aux saveurs fruitées relevées de notes d’orange." },
  { id:"ipa",     nom:"IPA",     style:"Blonde IPA",         degre:5.8, c:"#2CD42A", ean:{ "33":"3770005751081", "75":"3770005751333" },
    desc:"Une Indian Pale Ale sèche aux arômes de fruits exotiques, avec une amertume rafraîchissante parfaitement équilibrée." },
  { id:"brune",   nom:"Brune",   style:"Brune Stout",        degre:7.5, c:"#1B2B3C", ean:{ "33":"3770005751043", "75":"3770005751371" },
    desc:"Une Stout brassée avec du malt fumé à la tourbe, qui lui confère un goût unique et distinctif. Équilibrée en bouche." },
  { id:"triple",  nom:"Triple",  style:"Triple style belge", degre:8,   c:"#E5007E", ean:{ "33":"3770005751425", "75":"3770005751449" },
    desc:"À la fois rafraîchissante et sucrée. Son houblonnage léger apporte des notes d’agrumes qui viennent équilibrer sa douceur." },
  { id:"neipa",   nom:"NEIPA",   style:"Blonde NEIPA",       degre:5.8, c:"#27A8E0", ean:{ "33":"3770005751487", "75":"3770005751470" },
    desc:"Trouble et généreuse, aux arômes intenses de fruits tropicaux et d’agrumes. Douce, juteuse et peu amère, avec une finale ultra-rafraîchissante." },
  { id:"sour",    nom:"Sour",    style:"Sour",               degre:5.8, c:"#FFFFFF", ean:{ "33":"3770005751524", "75":"3770005751531" },
    desc:"Acidulée et portée par de belles notes de framboise fraîche. Entre douceur fruitée et acidité vive, une finale légère et désaltérante." },
];
/* ======================================================================== */
