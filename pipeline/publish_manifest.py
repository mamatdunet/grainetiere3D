#!/usr/bin/env python3
"""Write the manifest of converted zones. Zones missing from LABELS are never published."""
import json
import sys

LABELS = {
    "salle_saint_benoit": "Salle Saint-Benoît", "salle_capitulaire": "Salle capitulaire",
    "sacristie": "Sacristie", "magasin": "Magasin", "cuisine": "Cuisine", "buanderie": "Buanderie",
    "buanderie_jc": "Buanderie (JC)", "buanderie_n1": "Buanderie, étage",
    "cloitre_est": "Cloître est", "cloitre_ouest": "Cloître ouest", "cloitre_sud": "Cloître sud",
    "coursive_n0": "Coursive, rez-de-chaussée", "coursive_n1": "Coursive, étage",
    "ext_est": "Extérieur est", "ext_nord": "Extérieur nord", "ext_ouest": "Extérieur ouest",
    "ext_sud": "Extérieur sud", "ext_sud_2": "Extérieur sud (2)", "gps": "Points GPS",
    "tour_n0": "Tour, rez-de-chaussée", "tour_n0_esc": "Tour, escalier bas", "tour_n1": "Tour, niveau 1",
    "tour_n2": "Tour, niveau 2", "tour_n2_esc": "Tour, escalier haut",
    "chambres": "Chambres", "chambres_n1": "Chambres, étage",
    "chambres_n1_esc": "Chambres, escalier", "chambres_n1_sdb": "Chambres, salles de bain",
}
zones = [{"id": z, "label": LABELS[z]} for z in sys.argv[2:]]
json.dump({"grid": 128, "rootSize": 512.0, "zones": zones}, open(sys.argv[1], "w"), ensure_ascii=False)
