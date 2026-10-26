#!/usr/bin/env python3
"""Génère snippets/gdm-page-skin.liquid : l'habillage GDM des pages de contenu.

Les pages, articles et descriptions de collection du site contiennent leur
propre HTML avec une feuille de style (polices Barlow Condensed et DM Sans,
orange #FF9900, variables --acc, --c, --tx…). Ce contenu est enregistré dans
la boutique, pas dans le thème : le modifier changerait le site en ligne.
Ce script lit ces feuilles de style et produit, pour chaque contenu, des
règles qui l'habillent au style GDM depuis le thème :

- variables de couleur remplacées par celles de la marque ;
- Barlow Condensed → Anton (titres) ou Inter semi-gras (petites étiquettes),
  DM Sans → Inter ;
- texte foncé sur les boutons orange (lisibilité) ;
- grands espacements (≥ 40 px) resserrés d'un tiers, grands titres un peu
  plus petits.

Toutes les règles sont préfixées par #MainContent, ce qui les fait passer
devant celles du contenu sans toucher au reste du site.

Usage :
  python3 gdm_page_skin.py <dossier des sources> <snippet de sortie>
Les sources sont des fichiers <type>__<handle>.html (type : page, article ou
collection) contenant le HTML du contenu, tel que l'API Admin le renvoie.
"""
import re
import sys
from pathlib import Path

DISPLAY = 'var(--gdm-site-display)'
BODY = 'var(--gdm-site-body)'
SCOPE = '#MainContent'

VARS = {
    '--acc': '#f0921e',
    '--accent': '#f0921e',
    '--accent-dark': '#c97412',
    '--acc-g': 'rgba(240, 146, 30, 0.12)',
    '--accent-glow': 'rgba(240, 146, 30, 0.12)',
    '--acc-b': 'rgba(240, 146, 30, 0.28)',
    '--acc-bh': 'rgba(240, 146, 30, 0.45)',
    '--bg': '#0d0d0d',
    '--c': '#1a1714',
    '--card': '#1a1714',
    '--c-h': '#201c18',
    '--card-h': '#201c18',
    '--card-hover': '#201c18',
    '--ln-h': 'rgba(240, 146, 30, 0.35)',
    '--line-hover': 'rgba(240, 146, 30, 0.35)',
    '--mu': '#a8a39a',
    '--muted': '#a8a39a',
    '--tx': '#ffffff',
    '--text': '#ffffff',
}
SPACING = re.compile(r'^(padding|margin)(-(top|bottom|block|block-start|block-end|inline|left|right))?$|^(row-|column-)?gap$')
WHITE = re.compile(r'^(#fff(fff)?|white|#f2f0ec)$', re.I)


def strip_comments(css):
    return re.sub(r'/\*.*?\*/', '', css, flags=re.S)


def parse(css):
    """Liste de (préambule, corps) ; le corps d'un @media est lui-même une liste."""
    out, i = [], 0
    while True:
        j = css.find('{', i)
        if j < 0:
            break
        prelude = css[i:j]
        if ';' in prelude:
            prelude = prelude.rsplit(';', 1)[-1]
        prelude = prelude.strip()
        depth, k = 1, j + 1
        while k < len(css) and depth:
            depth += {'{': 1, '}': -1}.get(css[k], 0)
            k += 1
        body = css[j + 1:k - 1]
        if prelude.startswith(('@media', '@supports')):
            out.append((prelude, parse(body)))
        elif not prelude.startswith('@'):
            out.append((prelude, body))
        i = k
    return out


def declarations(body):
    decl = {}
    for prop, value in re.findall(r'([\w-]+)\s*:\s*([^;]+)', body):
        decl[prop.strip().lower()] = value.strip()
    return decl


def scale_px(value, factor, minimum):
    def repl(m):
        n = float(m.group(1))
        if abs(n) < minimum:
            return m.group(0)
        v = round(n * factor / 2) * 2
        return f'{v:g}px'
    return re.sub(r'(-?\d+(?:\.\d+)?)px', repl, value)


def max_px(value):
    nums = [float(x) for x in re.findall(r'(\d+(?:\.\d+)?)px', value)]
    return max(nums) if nums else None


def scope(selector):
    parts = []
    for sel in selector.split(','):
        sel = sel.strip()
        if not sel:
            continue
        if re.match(r'^(:root|html|body)$', sel):
            parts.append(SCOPE)
        else:
            sel = re.sub(r'^(:root|html|body)\s+', '', sel)
            parts.append(f'{SCOPE} {sel}')
    return ', '.join(parts)


def transform(selector, body):
    d = declarations(body)
    out = []
    for var, value in VARS.items():
        if var in d:
            out.append(f'{var}: {value}')
    family = d.get('font-family', '')
    size = max_px(d.get('font-size', ''))
    if 'barlow' in family.lower():
        if size is not None and size <= 15:
            out += [f'font-family: {BODY} !important', 'font-weight: 600 !important']
        else:
            out += [f'font-family: {DISPLAY} !important', 'font-weight: 400 !important']
            if d.get('letter-spacing', '').startswith('-'):
                out.append('letter-spacing: 0.005em')
            lh = d.get('line-height', '')
            if re.fullmatch(r'\d*\.?\d+', lh) and float(lh) < 1.1:
                out.append('line-height: 1.12')
            if size is not None and size >= 28:
                out.append('font-size: ' + scale_px(d['font-size'], 0.9, 28))
    elif 'dm sans' in family.lower():
        out.append(f'font-family: {BODY} !important')
    bg = d.get('background', '') + d.get('background-color', '')
    if re.search(r'var\(--acc(ent)?\)', bg) and WHITE.match(d.get('color', '').strip()):
        out.append('color: #0d0d0d')
    for prop, value in d.items():
        if SPACING.match(prop) and max_px(value) and max_px(value) >= 40:
            out.append(f'{prop}: ' + scale_px(value, 0.66, 40))
    if not out:
        return ''
    return scope(selector) + ' { ' + '; '.join(out) + ' }'


def skin(css):
    lines = []
    for prelude, body in parse(strip_comments(css)):
        if isinstance(body, list):
            inner = [r for r in (transform(p, b) for p, b in body if not isinstance(b, list)) if r]
            if inner:
                lines.append(prelude + ' { ' + ' '.join(inner) + ' }')
        else:
            rule = transform(prelude, body)
            if rule:
                lines.append(rule)
    return '\n'.join(lines)


def main(src_dir, out_file):
    cases = []
    for path in sorted(Path(src_dir).glob('*.html')):
        kind, handle = path.stem.split('__', 1)
        html = path.read_text(encoding='utf-8')
        css = '\n'.join(re.findall(r'<style[^>]*>(.*?)</style>', html, flags=re.S))
        rules = skin(css)
        if rules:
            cases.append((f'{kind}/{handle}', rules))
    with open(out_file, 'w', encoding='utf-8') as f:
        f.write('{%- comment -%}\n')
        f.write('  Le Gué des Moines — habillage GDM des pages, articles et collections dont le\n')
        f.write('  contenu a sa propre feuille de style. Fichier généré par\n')
        f.write('  outils/gdm_page_skin.py : le régénérer plutôt que le modifier à la main.\n')
        f.write("  Usage : {% render 'gdm-page-skin', key: 'page/brewpub' %}\n")
        f.write('{%- endcomment -%}\n')
        f.write('{%- case key -%}\n')
        for key, rules in cases:
            f.write(f"  {{%- when '{key}' -%}}\n<style>\n{rules}\n</style>\n")
        f.write('{%- endcase -%}\n')
    print(f'{len(cases)} contenus habillés -> {out_file}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
