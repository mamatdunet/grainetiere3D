# 2. Données et formats

## Les scans d'origine

| Caractéristique | Valeur |
| --- | --- |
| Emplacement | Drive privé, dossier « Sauvegarde Scans 3D Lasers AGP » |
| Organisation | 3 sous-dossiers : `Grainetiere E57 part1` (248 fichiers), `Grainetiere E57 part2` (195), `Grainetiere_E57_partie3` (200) |
| Volume | 643 fichiers E57, 389 Gio, 19,22 milliards de points |
| Scanners | Faro Focus S 70 (343 stations), Focus S 150 (300) |
| Logiciel d'export | version 7.5.1.3199 |
| Champs | `cartesianX/Y/Z`, `intensity`, `rowIndex`, `columnIndex`, `cartesianInvalidState` |
| Couleur | Aucune, vérifié sur les 643 fichiers |
| Dates d'acquisition | Absentes des fichiers |
| Recalage | Déjà fait : chaque scan porte sa pose (rotation et translation) |
| Système de coordonnées | EPSG:3947 (CC47), **présumé** d'après les valeurs, sans mention explicite |

La zone d'un scan se déduit de son nom : `Ag_ext_nord_1018.e57` donne `ext_nord` (fonction `zone_of`).

## Le repère du projet

Toutes les données publiées sont exprimées en mètres dans un repère local :

- **origine :** partie entière de la médiane des positions de scan, soit `[1390436, 6189165, 98]` en coordonnées CC47 présumées ;
- **axes :** x vers l'est, y vers le nord, z vers le haut ;
- **cube racine :** 512 m de côté, centré sur l'origine, de −256 à +256 sur chaque axe.

Cette origine n'est stockée dans aucun fichier publié : elle se recalcule à partir de `data/inventory/inventory.jsonl`.

## Sur Vercel Blob

Adresse de base : `https://earmm4k9vwqulmnw.public.blob.vercel-storage.com/abbaye`

```text
abbaye/
├── manifest.json              liste des zones publiées
└── <zone>/
    ├── metadata.json.gz       stations et table des nœuds de la zone
    └── chunks/<N>.bin         nœuds compressés, mis bout à bout
```

### `manifest.json`

```json
{ "grid": 128, "rootSize": 512.0, "zones": [{ "id": "cuisine", "label": "Cuisine" }] }
```

C'est la source de vérité du site : une zone absente du manifeste n'est jamais demandée, même si ses fichiers restent sur le Blob.

### `<zone>/metadata.json.gz`

JSON compressé en gzip :

```json
{
  "zone": "cuisine",
  "grid": 128,
  "rootSize": 512.0,
  "points": 81000000,
  "stations": [{ "name": "Ag_cuisine_1001", "position": [x, y, z] }],
  "nodes": [["0123", 41233, 0, 1048576, 208001]]
}
```

Chaque entrée de `nodes` vaut `[clé, nombre de points, numéro de fichier, position en octets, longueur en octets]`.

### La clé d'un nœud

La clé est une suite de chiffres de 0 à 7, un par niveau ; la racine a pour clé la chaîne vide. Chaque chiffre désigne un octant :

```text
chiffre = (x dans la moitié haute ? 1 : 0)
        + (y dans la moitié haute ? 2 : 0)
        + (z dans la moitié haute ? 4 : 0)
```

La taille d'un nœud vaut `512 / 2^longueur` m, et son coin bas se calcule en descendant la clé depuis (−256, −256, −256). Son espacement vaut `taille / 128`.

| Profondeur | Taille du nœud | Espacement des points |
| --- | --- | --- |
| 0 | 512 m | 4 m |
| 5 (tuile) | 16 m | 12,5 cm |
| 6 | 8 m | 6,25 cm |
| 10 (la plus fine) | 0,5 m | 3,9 mm |

### Le contenu d'un nœud

Une plage de `chunks/N.bin` est un bloc gzip qui, une fois décompressé, contient pour `n` points :

| Position | Type | Contenu |
| --- | --- | --- |
| `0` | `n` × u16 petit-boutiste | x |
| `2n` | `n` × u16 | y |
| `4n` | `n` × u16 | z |
| `6n` | `n` × u8 | intensité |

Les valeurs sont stockées par colonne, ce qui se compresse mieux. Pour retrouver un point : `coin du nœud + valeur / 65535 × taille du nœud`.

L'intensité est ramenée sur 0–255 par `clip((i − 0,2) / 0,8, 0, 1) × 255`.

Un nœud contient au plus un point par cellule de sa grille 128³, sauf dans les feuilles fusionnées : quand il reste moins de `MIN_NODE` (2 000) points à descendre, le nœud les garde tous et l'arbre s'arrête là.

## Dans le site : `app/src/`

### Masques `air-mask.bin`, `speck-mask.bin` et `people-mask.bin`

| Position | Type | Contenu |
| --- | --- | --- |
| `0` | u32 | Longueur `L` de l'en-tête |
| `4` | `L` octets, complétés à un multiple de 4 | JSON `{ "voxel", "low": [x,y,z], "shape": [w,d,h] }` |
| après | u32 × … | Numéros de cellules à écarter, triés |

Une cellule porte le numéro `cx + cy × w + cz × w × d`, avec `c = floor((position − low) / voxel)`.

| Fichier | Cellule | Taille | Contenu |
| --- | --- | --- | --- |
| `air-mask.bin` | 40 cm | 22 Ko | Oiseaux, bruit, échos flottant dans l'air |
| `speck-mask.bin` | 12,5 cm | 314 Ko | Points isolés près des surfaces, boule d'échos autour de chaque scanner |
| `people-mask.bin` | 10 cm | 486 Ko | Silhouettes et trépieds de l'équipe de relevé : 121 373 cellules. Ces points restent chargés et ne disparaissent qu'à la demande |


### `pieces-mask.bin`

Fichier de 4,8 Mo chargé seulement par l'outil de nettoyage (`?nettoyage=1`), sur la grille de `people-mask.bin`. Tout le fichier forme un seul flux gzip :

| Ordre | Type | Contenu |
| --- | --- | --- |
| 1 | u32 + JSON complété à un multiple de 4 | En-tête `{ "voxel", "low", "shape", "pieces", "cells", "solid" }` |
| 2 | u32 × `cells` | Cases des morceaux, triées, en écarts avec la précédente |
| 3 | u32 × `cells` | Numéro du morceau de chaque case |
| 4 | u8 × `pieces`, complété à un multiple de 4 | Drapeaux du morceau : 1 s'il est isolé, 2 s'il touche le bâti |
| 5 | u32 × `solid` | Cases du bâti, triées, en écarts avec la précédente |

### `tour.json`

```json
{
  "chains": [[[x, y, z, yaw, pitch], "…une clé par seconde de marche…"]],
  "places": [{ "id": "abords", "chain": 0, "from": 0, "to": 90 }]
}
```

- **Une chaîne** est une suite de positions reliées à pied. Entre deux chaînes, la visite passe par un fondu. Il y a 18 chaînes.
- **Une clé** vaut une seconde à la vitesse nominale de 0,6 m/s. Le lacet (`yaw`) et le tangage (`pitch`) sont en radians, avec un lacet nul vers l'est.
- **Un lieu** désigne un intervalle de clés dans une chaîne. Il y a 25 lieux et 1 352 clés, soit 22 min 32.

### `places.json`

```json
{
  "credit": "Textes extraits et légèrement adaptés de …",
  "places": {
    "abords": { "title": "…", "role": "…", "short": "…", "detail": ["…", "…"] }
  }
}
```

| Champ | Affichage |
| --- | --- |
| `title` | Titre du lieu au centre de l'écran, menu « Se rendre à », boutons de la visite |
| `role` | Une phrase sous le titre |
| `short` | Texte court du panneau d'explications |
| `detail` | Paragraphes du texte détaillé, à la demande |

Le fichier compte 27 entrées : les 25 lieux de `tour.json`, plus `chambres` et `buanderie`, pièces hors parcours qui gardent un texte pendant la visite libre. Chaque `id` de `tour.json` doit y figurer.

### `minimap.png` et `minimap.json`

L'image isométrique du plan, et les paramètres pour y placer un point :

```json
{ "width": 880, "height": 563, "scale": 6.9152, "left": -72.865, "high": -44.312, "pad": 18, "axis": -0.3316 }
```

La projection se calcule ainsi (fonction `onMap` de `main.js`) :

```text
u = x cos(axis) + y sin(axis)
v = −x sin(axis) + y cos(axis)
écran x = ((u − v) cos 30° − left) × scale + pad
écran y = (−(u + v) / 2 − z − high) × scale + pad
```

### `music/`

Six morceaux et une ambiance en MP3 (26 Mo). Ils sont servis par le site, public depuis le 9 novembre 2026.

## Dans le dépôt : `data/inventory/`

### `inventory.jsonl`

Une ligne par scan, produite par `inventory_e57.py` :

```json
{"path": "Grainetiere E57 part2/Ag_ext_nord_1018.e57", "bytes": 364533760, "scans": 1, "images": 0,
 "fields": ["cartesianX", "…"], "points": 16780473, "colour": false, "sensor": "Focus S 70",
 "software": "7.5.1.3199", "acquired": null, "position": [1390466.9, 6189192.5, 99.3]}
```

`convert_zone.py` et `run_all.py` en ont besoin pour savoir quoi convertir.

### `reports.jsonl`

Une ligne par zone convertie :

| Champ | Sens |
| --- | --- |
| `scans`, `sourcePoints` | Scans lus et points valides |
| `binnedPoints` | Points après dédoublonnage à 5 mm dans chaque scan |
| `keptPoints` | Points publiés, après fusion des scans à 3,9 mm |
| `nodes`, `chunks`, `gzipGB` | Taille de l'octree publié |
| `gapsMm`, `gapMedianMm` | Écart entre surfaces de scans voisins, mesure de la qualité du recalage |
| `peakTilesGB`, `secondsScans`, `secondsBuild`, `peakMemoryGB` | Consommation de la conversion |

### Bilan par zone

| Zone | Scans | Points publiés (M) | Nœuds | Go gzip | Écart médian (mm) |
| --- | --- | --- | --- | --- | --- |
| `buanderie` | 37 | 57,5 | 6 518 | 0,324 | 0,72 |
| `buanderie_jc` | 7 | 19,2 | 3 322 | 0,108 | 1,04 |
| `buanderie_n1` | 20 | 56,9 | 9 552 | 0,324 | 0,55 |
| `chambres` | 33 | 40,6 | 3 720 | 0,228 | 0,54 |
| `chambres_n1` | 69 | 107,4 | 9 859 | 0,605 | 0,82 |
| `chambres_n1_esc` | 9 | 17,9 | 3 036 | 0,103 | 0,75 |
| `chambres_n1_sdb` | 12 | 19,5 | 3 262 | 0,112 | 0,75 |
| `cloitre_est` | 18 | 90,6 | 12 138 | 0,515 | 1,14 |
| `cloitre_ouest` | 14 | 122,2 | 16 943 | 0,697 | 1,24 |
| `cloitre_sud` | 18 | 104,9 | 15 217 | 0,600 | 1,04 |
| `coursive_n0` | 26 | 83,8 | 10 609 | 0,472 | 0,55 |
| `coursive_n1` | 58 | 121,4 | 15 402 | 0,688 | 0,58 |
| `cuisine` | 52 | 81,0 | 7 709 | 0,456 | 0,58 |
| `ext_est` | 23 | 132,2 | 24 121 | 0,764 | 1,13 |
| `ext_nord` | 53 | 277,0 | 37 244 | 1,580 | 1,20 |
| `ext_ouest` | 24 | 169,7 | 37 007 | 0,997 | 2,30 |
| `ext_sud` | 14 | 109,6 | 22 502 | 0,637 | 2,14 |
| `ext_sud_2` | 11 | 70,8 | 13 229 | 0,410 | 1,90 |
| `gps` | 3 | 11,2 | 3 313 | 0,067 | – |
| `magasin` | 18 | 61,5 | 6 403 | 0,349 | 0,79 |
| `sacristie` | 15 | 23,0 | 3 085 | 0,132 | 0,86 |
| `salle_capitulaire` | 19 | 61,1 | 5 557 | 0,346 | 0,97 |
| `salle_saint_benoit` | 9 | 27,3 | 3 930 | 0,154 | 1,92 |
| `tour_n0` | 16 | 34,8 | 5 195 | 0,199 | 1,02 |
| `tour_n0_esc` | 13 | 7,3 | 1 176 | 0,042 | 0,93 |
| `tour_n1` | 19 | 45,2 | 6 950 | 0,258 | 1,96 |
| `tour_n2` | 26 | 38,5 | 4 000 | 0,219 | 1,31 |
| `tour_n2_esc` | 7 | 2,3 | 370 | 0,013 | 0,96 |
| **Total** | **643** | **1 994,4** | **291 369** | **11,399** | |

Le passage de 19,2 milliards à 2,0 milliards de points vient du dédoublonnage : un point par cellule de 5 mm dans chaque scan, puis un point par cellule de 3,9 mm entre scans.

## Les données locales, hors dépôt

`data/out/` contient le tout premier essai (`saint_benoit`), au format de `build_octree.py`. Ce format diffère de celui des zones publiées et n'a pas de manifeste : le visualiseur actuel ne le lit plus. Le préfixe `saint_benoit/` du même essai est d'ailleurs toujours présent sur le Blob, sans être utilisé.
