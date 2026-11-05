# 6. Limites, droits et chantiers

État au 5 novembre 2026.

## Le dépôt et le site en ligne

Le dernier déploiement date du 5 novembre 2026 à 22 h 56, et le code de ce dépôt lui correspond à sa publication. Les modifications suivantes ne sont pas déployées automatiquement : voir [Déployer](05-exploitation.md#déployer).

## Ce qui n'a pas été vérifié

| Sujet | État |
| --- | --- |
| Site réel, après mot de passe | Les déploiements ne sont vérifiés que par le code 401 de la page d'accès |
| Téléphone réel | Testé en émulation seulement |
| Images par seconde réelles | Le panneau de test est limité par le navigateur quand il est masqué ; le rythme sur la machine de l'utilisateur n'est pas confirmé |
| Saccades dans les travellings | Correctif en place, non confirmé. Une capture montrait 11,6 M de points à 60 i/s, signe que l'allègement automatique s'était déclenché |
| Visite complète, du début à la fin | Jamais parcourue en entier dans cette version |
| Préchargement | Testé en local avec 60 000 éléments factices et sur un lieu (0,22 Go). Aucun téléchargement complet, et pas sur le navigateur de l'utilisateur |
| Bouton des silhouettes | Vérifié en local, pas en ligne. Qualité estimée à l'œil |
| Réglage final du rendu (2,6 / 7 / 0,08) | Vu sur une image de nuit, incomplètement chargée |
| Éclairage de nuit relevé | Pas de capture de contrôle |
| Mise en page téléphone | Non revue après la dernière retouche CSS |
| Système de coordonnées CC47 | Présumé d'après les valeurs |
| Facture réelle | Non lue |

## Droits et publication

Rien de ceci n'est un avis juridique. Ce sont des points à régler par les personnes concernées.

| Contenu | Situation | Dans ce dépôt ? |
| --- | --- | --- |
| Relevés laser (AGP) | Droits non clarifiés | Non pour les points. Leur adresse publique, oui |
| Textes de Philippe Gaury (`places.json`) | Accord de l'auteur non vérifié | **Oui** |
| Musique (`app/src/music/`) | Droits non réglés | **Oui** |
| Pièces privées : chambres, salles de bain | Choix de les garder dans le visualiseur. Certains scans montrent une personne | Non pour les points |
| Code | Aucune licence accordée pour l'instant | Oui |

**Avant de rendre ce dépôt public :**

1. obtenir ou retirer les textes et la musique ;
2. retirer du code l'adresse du Blob, ou accepter qu'elle donne accès à tous les points (`DEFAULT_DATA` dans `main.js`, `BASE_URL` dans `coarse_points.py`, et cette documentation) ;
3. mesurer ce que l'historique Git expose : retirer un fichier d'un commit récent ne l'efface pas des précédents ;
4. choisir une licence.

## Limites de sécurité

- Le mot de passe protège le site, pas les fichiers de points.
- Le code d'accès n'a pas de limite de tentatives.
- Le mot de passe est transmis en clair dans le POST, protégé par HTTPS, et comparé à sa valeur en mémoire.
- Le cookie reste valable tant que le mot de passe ne change pas : on ne peut pas révoquer un seul visiteur.

## Limites techniques

- **Pas de couleur :** les scans n'ont que l'intensité. La pierre, le bois et le ciel se distinguent par le relief et la réflectance, pas par la teinte.
- **Pas d'ombres portées :** la lumière agit sur les normales de l'image, sans géométrie pour projeter une ombre.
- **Écart de recalage :** jusqu'à 2,3 mm d'écart médian sur `ext_ouest`, ce qui reste très faible à l'échelle de la visite.
- **Zones non vues :** le nuage garde les trous laissés derrière les obstacles et là où aucun scanner n'a vu.
- **Sans WebGL 2 :** pas de rendu amélioré, et sans lui pas d'occlusion : le budget est réparti aussi sur ce qui est caché.
- **Préchargement :** sur ordinateur seulement, et lié à un navigateur et à une version du parcours.
- **Tests :** aucun test automatisé.
- **Fichiers hérités :** `build_octree.py` et l'essai `saint_benoit/` sur le Blob, qui ne servent plus. Le commentaire d'en-tête de `convert_zone.py` est à corriger.
- **Fichier volumineux :** `main.js` tient en un seul fichier de 1 951 lignes, et le bundle dépasse 500 Ko (173 Ko compressé), ce qui provoque un avertissement sans conséquence au build.

## Masquer les silhouettes de l'équipe de relevé

### Le besoin

Lors du relevé, l'équipe et les trépieds ont été captés. Le rendu « poétique » doit rester le choix par défaut, avec une option pour les masquer, sans renvoyer les données.

### Où on en est

**En ligne, en option :** le bouton « Masquer silhouettes et trépieds » retire ces points de l'affichage, instantanément, sans aucun envoi de données. Les silhouettes restent visibles par défaut.

**La détection est partielle.** D'après une revue d'images à l'œil, qui donne des estimations et non des mesures :

- la plupart des personnes bien isolées et beaucoup de trépieds disparaissent ;
- environ un quart à un tiers des personnes restent, ainsi que de nombreux trépieds ;
- aucun objet patrimonial touché dans les pièces sensibles examinées, sur un échantillon et non sur toute l'abbaye.

Le masque représente 0,38 % des points grossiers de la zone analysée. La méthode est décrite dans [le pipeline](03-pipeline.md#11-silhouettes-et-trépieds--people_maskpy).

### Pour aller plus loin

Une meilleure couverture demanderait d'assouplir les seuils de `people_mask.py`, au risque de masquer de vrais objets. Toute nouvelle version se contrôle à l'œil sur plusieurs pièces, puis se déploie sans toucher au Blob.
