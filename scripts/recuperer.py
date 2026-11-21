#!/usr/bin/env python3
"""Récupère la météo, l'agenda iCloud et l'album photo iCloud partagé,
et les dépose dans data/ et photos/ pour la page de l'iPad.

Chaque partie est indépendante : si l'une échoue, les autres continuent
et l'ancien fichier est conservé.
"""
import datetime as dt
import json
import os
import re
import sys
import time
import traceback
from io import BytesIO
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

RACINE = Path(__file__).resolve().parent.parent
DATA = RACINE / "data"
PHOTOS = RACINE / "photos"
CONFIG = json.loads((RACINE / "config.json").read_text(encoding="utf-8"))
ENTETES = {"User-Agent": "Mozilla/5.0 (ipad-chevet)"}
TAILLE_MAX = 1024  # l'écran de l'iPad mini 1 fait 1024 x 768


def maintenant_ms():
    return int(time.time() * 1000)


def ecrire_json(nom, contenu):
    DATA.mkdir(exist_ok=True)
    (DATA / nom).write_text(json.dumps(contenu, ensure_ascii=False, indent=1), encoding="utf-8")


# ---------------------------------------------------------------- Météo
def meteo():
    params = {"name": CONFIG["ville"], "count": 1, "language": "fr"}
    if CONFIG.get("pays"):
        params["countryCode"] = CONFIG["pays"]
    geo = requests.get("https://geocoding-api.open-meteo.com/v1/search",
                       params=params, timeout=30).json()
    if not geo.get("results"):
        raise RuntimeError("Ville introuvable : %s" % CONFIG["ville"])
    lieu = geo["results"][0]

    f = requests.get("https://api.open-meteo.com/v1/forecast", params={
        "latitude": lieu["latitude"],
        "longitude": lieu["longitude"],
        "current": "temperature_2m,apparent_temperature,weather_code,is_day",
        "hourly": "temperature_2m,weather_code,precipitation_probability",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,"
                 "precipitation_probability_max,sunrise,sunset",
        "timezone": "auto",
        "forecast_days": 5,
        "forecast_hours": 48,
        "timeformat": "unixtime",
    }, timeout=30).json()

    c, h, d = f["current"], f["hourly"], f["daily"]
    ecrire_json("weather.json", {
        "maj": maintenant_ms(),
        "ville": lieu["name"],
        "fuseau": f["timezone"],
        "actuel": {"t": c["time"], "temp": c["temperature_2m"],
                   "ressenti": c["apparent_temperature"], "code": c["weather_code"]},
        "heures": [{"t": h["time"][i], "temp": h["temperature_2m"][i],
                    "code": h["weather_code"][i],
                    "pluie": h["precipitation_probability"][i]}
                   for i in range(len(h["time"]))],
        "jours": [{"t": d["time"][i], "code": d["weather_code"][i],
                   "max": d["temperature_2m_max"][i], "min": d["temperature_2m_min"][i],
                   "pluie": d["precipitation_probability_max"][i],
                   "lever": d["sunrise"][i], "coucher": d["sunset"][i]}
                  for i in range(len(d["time"]))],
    })
    return ZoneInfo(f["timezone"])


# ---------------------------------------------------------------- Agenda
def agenda(fuseau):
    import icalendar
    import recurring_ical_events

    url = os.environ.get("ICLOUD_CALENDAR_URL", "").strip()
    if not url:
        ecrire_json("agenda.json", {"maj": maintenant_ms(), "actif": False, "evenements": []})
        print("Agenda : aucun lien configuré, ignoré.")
        return
    url = re.sub(r"^webcals?://", "https://", url)
    reponse = requests.get(url, headers=ENTETES, timeout=30)
    reponse.raise_for_status()
    cal = icalendar.Calendar.from_ical(reponse.content)

    maint = dt.datetime.now(fuseau)
    debut = maint.replace(hour=0, minute=0, second=0, microsecond=0)
    fin = debut + dt.timedelta(days=int(CONFIG.get("jours_agenda", 7)))

    def en_local(valeur):
        if isinstance(valeur, dt.datetime):
            return valeur if valeur.tzinfo else valeur.replace(tzinfo=fuseau)
        return dt.datetime.combine(valeur, dt.time(), fuseau)

    evenements = []
    for ev in recurring_ical_events.of(cal).between(debut, fin):
        d0 = ev["DTSTART"].dt
        journee = not isinstance(d0, dt.datetime)
        s = en_local(d0)
        if ev.get("DTEND") is not None:
            e = en_local(ev["DTEND"].dt)
        elif ev.get("DURATION") is not None:
            e = s + ev["DURATION"].dt
        else:
            e = s + (dt.timedelta(days=1) if journee else dt.timedelta(hours=1))
        if e <= maint:
            continue
        evenements.append({
            "debut": int(s.timestamp() * 1000),
            "fin": int(e.timestamp() * 1000),
            "journee": journee,
            "titre": str(ev.get("SUMMARY", "") or "Sans titre"),
        })
    evenements.sort(key=lambda x: (x["debut"], not x["journee"]))
    ecrire_json("agenda.json", {"maj": maintenant_ms(), "actif": True, "evenements": evenements})
    print("Agenda : %d événement(s)." % len(evenements))


# ---------------------------------------------------------------- Photos
BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def jeton_album(url):
    # https://www.icloud.com/sharedalbum/#B0aXXXXXXXX  ->  B0aXXXXXXXX
    return url.split("#", 1)[-1].split(";")[0].strip()


def serveur_album(jeton):
    if jeton[0] == "A":
        n = BASE62.index(jeton[1])
    else:
        n = BASE62.index(jeton[1]) * 62 + BASE62.index(jeton[2])
    return "p%02d-sharedstreams.icloud.com" % n


def appel_icloud(serveur, jeton, point, corps):
    for _ in range(3):
        r = requests.post("https://%s/%s/sharedstreams/%s" % (serveur, jeton, point),
                          data=json.dumps(corps),
                          headers=dict(ENTETES, **{"Content-Type": "text/plain"}),
                          timeout=60, allow_redirects=False)
        if r.status_code == 330:  # Apple indique le bon serveur
            serveur = r.json().get("X-Apple-MMe-Host") or r.headers.get("X-Apple-MMe-Host")
            continue
        r.raise_for_status()
        return serveur, r.json()
    raise RuntimeError("iCloud ne répond pas correctement")


def choisir_version(derives):
    """Prend la plus petite version d'au moins 1024 px, sinon la plus grande."""
    versions = []
    for v in derives.values():
        try:
            versions.append((max(int(v["width"]), int(v["height"])), v["checksum"]))
        except (KeyError, ValueError, TypeError):
            pass
    if not versions:
        return None
    assez = sorted(x for x in versions if x[0] >= TAILLE_MAX)
    return (assez[0] if assez else max(versions))[1]


def photos():
    url = os.environ.get("ICLOUD_ALBUM_URL", "").strip()
    if not url:
        print("Photos : aucun lien d'album configuré, ignoré.")
        return
    from PIL import Image, ImageOps
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except Exception:
        pass

    jeton = jeton_album(url)
    serveur, flux = appel_icloud(serveur_album(jeton), jeton, "webstream", {"streamCtag": None})
    elements = [p for p in flux.get("photos", []) if p.get("mediaAssetType") != "video"]
    elements.sort(key=lambda p: p.get("dateCreated", ""), reverse=True)
    elements = elements[: int(CONFIG.get("max_photos", 150))]

    voulues = {}
    for p in elements:
        nom = re.sub(r"[^A-Za-z0-9-]", "", p["photoGuid"]) + ".jpg"
        somme = choisir_version(p.get("derivatives", {}))
        if somme:
            voulues[nom] = (p["photoGuid"], somme)

    PHOTOS.mkdir(exist_ok=True)
    a_telecharger = {n: v for n, v in voulues.items() if not (PHOTOS / n).exists()}

    guids = [v[0] for v in a_telecharger.values()]
    adresses = {}
    for i in range(0, len(guids), 25):
        serveur, rep = appel_icloud(serveur, jeton, "webasseturls", {"photoGuids": guids[i:i + 25]})
        for somme, info in rep.get("items", {}).items():
            adresses[somme] = "https://%s%s" % (info["url_location"], info["url_path"])

    ajoutees = 0
    for nom, (_, somme) in a_telecharger.items():
        if somme not in adresses:
            continue
        try:
            brut = requests.get(adresses[somme], headers=ENTETES, timeout=60).content
            img = ImageOps.exif_transpose(Image.open(BytesIO(brut))).convert("RGB")
            img.thumbnail((TAILLE_MAX, TAILLE_MAX))
            img.save(PHOTOS / nom, "JPEG", quality=82)
            ajoutees += 1
        except Exception as e:
            print("Photo ignorée (%s) : %s" % (nom, e))

    retirees = 0
    for fichier in PHOTOS.glob("*.jpg"):
        if fichier.name not in voulues:
            fichier.unlink()
            retirees += 1

    presentes = sorted(n for n in voulues if (PHOTOS / n).exists())
    ancien = {}
    try:
        ancien = json.loads((DATA / "photos.json").read_text(encoding="utf-8"))
    except Exception:
        pass
    liste = ["photos/" + n for n in presentes]
    if liste != ancien.get("photos"):
        ecrire_json("photos.json", {"maj": maintenant_ms(), "photos": liste})
    print("Photos : %d au total, %d ajoutée(s), %d retirée(s)." % (len(liste), ajoutees, retirees))


# ---------------------------------------------------------------- Lancement
def main():
    erreurs = 0
    fuseau = ZoneInfo("Europe/Paris")
    for nom, etape in (("Météo", meteo), ("Agenda", None), ("Photos", photos)):
        try:
            if nom == "Météo":
                fuseau = etape() or fuseau
            elif nom == "Agenda":
                agenda(fuseau)
            else:
                etape()
        except Exception:
            erreurs += 1
            print("ERREUR %s :" % nom)
            traceback.print_exc()
    # On publie quand même la page ; l'erreur reste visible dans l'onglet Actions.
    if erreurs:
        print("%d partie(s) en erreur." % erreurs, file=sys.stderr)


if __name__ == "__main__":
    main()
