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
- espacements de plus de 24 px resserrés (40 → 30, 64 → 44, 80 → 52 px),
  grands titres un peu plus petits.

Chaque règle est préfixée par le bloc du thème qui contient le texte (page,
article ou description de collection) : une classe de plus, elle passe devant
la règle d'origine sans toucher au reste du site. Quand une règle est adaptée,
les règles suivantes du contenu qui visent le même élément et la même
propriété (souvent la version mobile) sont recopiées avec ce même préfixe,
sinon la version adaptée l'emporterait sur elles.

Usage :
  python3 gdm_page_skin.py <dossier des sources> <snippet de sortie>
Les sources sont des fichiers <type>__<handle>.html (type : page, article ou
collection) contenant le HTML du contenu, tel que l'API Admin le renvoie.
Pour un article, le handle est précédé du blog : article__infos~mon-article.html
(dans Liquid, article.handle vaut « infos/mon-article »).
"""
import re
import sys
from pathlib import Path

DISPLAY = 'var(--gdm-site-display)'
BODY = 'var(--gdm-site-body)'
# Bloc du thème qui contient le texte de chaque type de contenu.
ZONES = {
    'page': '.t4s-main-page',
    'article': '.t4s-article-content',
    'collection': '.gdm-bieres__desc',
}

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


def tighten(value):
    """Espacements : inchangés jusqu'à 24 px, puis de plus en plus resserrés."""
    def repl(m):
        n = float(m.group(1))
        a = abs(n)
        if a <= 24:
            return m.group(0)
        v = 24 + (a - 24) * 0.4 if a <= 40 else 30.4 + (a - 40) * 0.55
        v = round(v / 2) * 2
        return f'{-v if n < 0 else v:g}px'
    return re.sub(r'(-?\d+(?:\.\d+)?)px', repl, value)


def max_px(value):
    nums = [float(x) for x in re.findall(r'(\d+(?:\.\d+)?)px', value)]
    return max(nums) if nums else None


def family_of(prop):
    """Propriétés qui se recouvrent (padding et padding-top, gap et row-gap) : même famille."""
    if prop.startswith('font-'):
        return prop
    return re.sub(r'^(row-|column-)', '', prop).split('-')[0]


class Skin:
    """Adapte les règles d'un contenu, dans l'ordre de sa feuille de style."""

    def __init__(self, zone):
        self.zone = zone
        self.changed = set()  # (sélecteur, famille) déjà adaptés

    def scope(self, selector):
        parts = []
        for sel in selector:
            if re.fullmatch(r':root|html|body', sel):
                parts.append(self.zone)
            else:
                parts.append(self.zone + ' ' + re.sub(r'^(:root|html|body)\s+', '', sel))
        return ', '.join(parts)

    def rule(self, prelude, body):
        selector = [x.strip() for x in prelude.split(',') if x.strip()]
        d = declarations(body)
        out = []

        def keep(prop, old, new):
            family = family_of(prop)
            if new != old:
                self.changed.update((sel, family) for sel in selector)
            elif not any((sel, family) in self.changed for sel in selector):
                return
            out.append(f'{prop}: {new}')

        for var, value in VARS.items():
            if var in d:
                out.append(f'{var}: {value}')
        font = d.get('font-family', '').lower()
        size = max_px(d.get('font-size', ''))
        display = 'barlow' in font and not (size is not None and size <= 15)
        if 'barlow' in font and not display:
            out += [f'font-family: {BODY} !important', 'font-weight: 600 !important']
        elif display:
            out += [f'font-family: {DISPLAY} !important', 'font-weight: 400 !important']
        elif 'dm sans' in font:
            out.append(f'font-family: {BODY} !important')
        if 'font-size' in d:
            fs = d['font-size']
            keep('font-size', fs, scale_px(fs, 0.9, 28) if size is not None and size >= 28 else fs)
        if 'line-height' in d:
            lh = d['line-height']
            short = re.fullmatch(r'\d*\.?\d+', lh) and float(lh) < 1.1
            keep('line-height', lh, '1.12' if display and short else lh)
        if 'letter-spacing' in d:
            ls = d['letter-spacing']
            keep('letter-spacing', ls, '0.005em' if display and ls.startswith('-') else ls)
        bg = d.get('background', '') + d.get('background-color', '')
        if re.search(r'var\(--acc(ent)?\)', bg) and WHITE.match(d.get('color', '').strip()):
            out.append('color: #0d0d0d')
        for prop, value in d.items():
            if SPACING.match(prop):
                keep(prop, value, tighten(value))
        if not out:
            return ''
        return self.scope(selector) + ' { ' + '; '.join(out) + ' }'

    def css(self, css):
        lines = []
        for prelude, body in parse(strip_comments(css)):
            if isinstance(body, list):
                inner = [r for r in (self.rule(p, b) for p, b in body if not isinstance(b, list)) if r]
                if inner:
                    lines.append(prelude + ' { ' + ' '.join(inner) + ' }')
            else:
                rule = self.rule(prelude, body)
                if rule:
                    lines.append(rule)
        return '\n'.join(lines)


def main(src_dir, out_file):
    cases = []
    for path in sorted(Path(src_dir).glob('*.html')):
        kind, handle = path.stem.split('__', 1)
        handle = handle.replace('~', '/')
        html = path.read_text(encoding='utf-8')
        css = '\n'.join(re.findall(r'<style[^>]*>(.*?)</style>', html, flags=re.S))
        rules = Skin(ZONES[kind]).css(css)
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
