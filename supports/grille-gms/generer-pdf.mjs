// Génère le PDF de la grille tarifaire GMS à partir de grille-gms.html.
// Usage : node supports/grille-gms/generer-pdf.mjs [dossier-apercus-png]
// Nécessite Playwright (npx playwright install chromium si absent).
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ici = path.dirname(fileURLToPath(import.meta.url));
// require() suit NODE_PATH : marche avec un Playwright local ou installé globalement.
const { chromium } = createRequire(import.meta.url)("playwright");
const source = path.join(ici, "grille-gms.html");
const sortie = path.join(ici, "Grille-tarifaire-GMS-Le-Gue-des-Moines.pdf");
const dossierApercus = process.argv[2];

const navigateur = await chromium.launch();
const page = await navigateur.newPage({ viewport: { width: 1123, height: 794 }, deviceScaleFactor: 2 });
await page.goto(pathToFileURL(source).href, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.emulateMedia({ media: "print" });

await page.pdf({ path: sortie, preferCSSPageSize: true, printBackground: true });
console.log("PDF :", sortie);

if (dossierApercus) {
  const pages = await page.$$(".page");
  for (let i = 0; i < pages.length; i++) {
    const fichier = path.join(dossierApercus, `page-${i + 1}.png`);
    await pages[i].screenshot({ path: fichier });
    console.log("Aperçu :", fichier);
  }
}
await navigateur.close();
