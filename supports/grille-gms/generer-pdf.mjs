// Génère les PDF à partir des sources HTML (mêmes données : donnees.js).
//   grille-gms.html → Grille-tarifaire-GMS-Le-Gue-des-Moines.pdf (A4 paysage, 3 pages)
//   flyer-gms.html  → Flyer-GMS-Le-Gue-des-Moines.pdf (A5 recto-verso)
//   depliant-gms.html → Depliant-3-volets-GMS-Le-Gue-des-Moines.pdf (A4 plié en 3, extérieur + intérieur)
// Usage : node supports/grille-gms/generer-pdf.mjs [dossier-apercus-png]
// Nécessite Playwright (npx playwright install chromium si absent).
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ici = path.dirname(fileURLToPath(import.meta.url));
// require() suit NODE_PATH : marche avec un Playwright local ou installé globalement.
const { chromium } = createRequire(import.meta.url)("playwright");
const DOCUMENTS = [
  { source: "grille-gms.html", sortie: "Grille-tarifaire-GMS-Le-Gue-des-Moines.pdf", pages: ".page" },
  { source: "flyer-gms.html", sortie: "Flyer-GMS-Le-Gue-des-Moines.pdf", pages: ".face" },
  { source: "depliant-gms.html", sortie: "Depliant-3-volets-GMS-Le-Gue-des-Moines.pdf", pages: ".feuille" },
];
const dossierApercus = process.argv[2];

const navigateur = await chromium.launch();
for (const doc of DOCUMENTS) {
  const page = await navigateur.newPage({ viewport: { width: 1123, height: 794 }, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(path.join(ici, doc.source)).href, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(100);   // laisse les ajustements de mise en page se faire
  if (await page.$(".trop-plein")) console.warn(`ATTENTION ${doc.source} : contenu trop long pour le format, voir l'avertissement dans le PDF.`);
  await page.emulateMedia({ media: "print" });
  const sortie = path.join(ici, doc.sortie);
  await page.pdf({ path: sortie, preferCSSPageSize: true, printBackground: true });
  console.log("PDF :", sortie);
  if (dossierApercus) {
    const pages = await page.$$(doc.pages);
    for (let i = 0; i < pages.length; i++) {
      await pages[i].screenshot({ path: path.join(dossierApercus, `${path.basename(doc.source, ".html")}-${i + 1}.png`) });
    }
  }
  await page.close();
}
await navigateur.close();
