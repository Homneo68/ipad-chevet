/* Écran de chevet pour iPad mini (iOS 9).
   Volontairement écrit en JavaScript ES5 : pas de let/const, pas de =>,
   pas de fetch ni de Promise, que Safari 9 ne gère pas toujours. */
(function () {
  'use strict';

  var JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  var JOURS_COURTS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
  var MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
    'août', 'septembre', 'octobre', 'novembre', 'décembre'];

  var config = { nuit_debut: '22:30', nuit_fin: '07:00', diaporama_secondes: 30 };
  var meteo = null, agenda = null;
  var photos = [], ordre = [], indexPhoto = 0, calqueActif = 1, photoAffichee = false;
  var reveil = lire('reveil', { heure: 7, minute: 0, actif: true });
  var modeForce = null;          // { mode: 'jour' | 'nuit', jusqua: ms }
  var audio = null, sonDebloque = false;
  var sonnerie = null, repeterA = 0, dernierDeclenchement = '';

  // ------------------------------------------------------------ Outils
  function $(id) { return document.getElementById(id); }
  function deux(n) { return (n < 10 ? '0' : '') + n; }
  function hm(d) { return deux(d.getHours()) + ':' + deux(d.getMinutes()); }
  function maj1(t) { return t.charAt(0).toUpperCase() + t.slice(1); }
  function echapper(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function enMinutes(t) { var p = t.split(':'); return parseInt(p[0], 10) * 60 + parseInt(p[1], 10); }
  function lire(cle, defaut) {
    try { var v = window.localStorage.getItem(cle); return v ? JSON.parse(v) : defaut; }
    catch (e) { return defaut; }
  }
  function ecrire(cle, val) {
    try { window.localStorage.setItem(cle, JSON.stringify(val)); } catch (e) { }
  }
  function charger(url, ok) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url + '?v=' + new Date().getTime(), true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) { return; }
      if (xhr.status >= 200 && xhr.status < 300) {
        try { ok(JSON.parse(xhr.responseText)); } catch (e) { }
      }
    };
    xhr.send();
  }
  function prochaine(heureTexte) {
    var p = heureTexte.split(':'), d = new Date();
    d.setHours(parseInt(p[0], 10), parseInt(p[1], 10), 0, 0);
    if (d.getTime() <= new Date().getTime()) { d.setDate(d.getDate() + 1); }
    return d.getTime();
  }
  function minuit(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

  // ------------------------------------------------------------ Jour / nuit
  function nuitPrevue(d) {
    var m = d.getHours() * 60 + d.getMinutes();
    var deb = enMinutes(config.nuit_debut), fin = enMinutes(config.nuit_fin);
    if (deb === fin) { return false; }
    return deb < fin ? (m >= deb && m < fin) : (m >= deb || m < fin);
  }
  function modeActuel(d) {
    if (sonnerie) { return 'jour'; }
    if (modeForce && d.getTime() < modeForce.jusqua) { return modeForce.mode; }
    modeForce = null;
    return nuitPrevue(d) ? 'nuit' : 'jour';
  }

  // ------------------------------------------------------------ Horloge
  function tic() {
    var d = new Date(), texte = hm(d);
    $('heure').innerHTML = texte;
    $('nuit-heure').innerHTML = texte;
    $('sonnerie-heure').innerHTML = texte;
    $('date').innerHTML = maj1(JOURS[d.getDay()]) + ' ' + d.getDate() + ' ' + MOIS[d.getMonth()];

    var mode = modeActuel(d);
    if (document.body.className !== mode) {
      document.body.className = mode;
      if (mode === 'jour' && !photoAffichee) { photoSuivante(); }
    }
    verifierReveil(d);
    afficherReveil();
  }

  // ------------------------------------------------------------ Météo
  var CIEL = {
    0: ['☀️', 'Ciel dégagé'], 1: ['🌤', 'Plutôt dégagé'], 2: ['⛅️', 'Partiellement nuageux'],
    3: ['☁️', 'Couvert'], 45: ['🌫', 'Brouillard'], 48: ['🌫', 'Brouillard givrant'],
    51: ['🌦', 'Bruine légère'], 53: ['🌦', 'Bruine'], 55: ['🌧', 'Bruine dense'],
    56: ['🌧', 'Bruine verglaçante'], 57: ['🌧', 'Bruine verglaçante'],
    61: ['🌦', 'Pluie faible'], 63: ['🌧', 'Pluie'], 65: ['🌧', 'Forte pluie'],
    66: ['🌧', 'Pluie verglaçante'], 67: ['🌧', 'Pluie verglaçante'],
    71: ['🌨', 'Neige faible'], 73: ['🌨', 'Neige'], 75: ['❄️', 'Forte neige'], 77: ['🌨', 'Grésil'],
    80: ['🌦', 'Averses'], 81: ['🌧', 'Averses'], 82: ['🌧', 'Fortes averses'],
    85: ['🌨', 'Averses de neige'], 86: ['❄️', 'Averses de neige'],
    95: ['⛈', 'Orage'], 96: ['⛈', 'Orage et grêle'], 99: ['⛈', 'Orage et grêle']
  };
  function ciel(code, nuitNoire) {
    var c = CIEL[code] || ['🌡', ''];
    if (nuitNoire && (code === 0 || code === 1)) { return ['🌙', code === 0 ? 'Nuit claire' : 'Plutôt dégagé']; }
    return c;
  }
  function rendreMeteo() {
    if (!meteo || !meteo.heures) { return; }
    var t = new Date().getTime() / 1000, i, h = meteo.actuel, jour = meteo.jours[0];
    for (i = 0; i < meteo.heures.length; i++) {
      if (meteo.heures[i].t <= t) { h = meteo.heures[i]; } else { break; }
    }
    for (i = 0; i < meteo.jours.length; i++) {
      if (meteo.jours[i].t <= t) { jour = meteo.jours[i]; }
    }
    var noir = jour && (t < jour.lever || t > jour.coucher);
    var c = ciel(h.code, noir);
    var temp = Math.round(h.temp) + '°';
    $('meteo-icone').innerHTML = c[0];
    $('meteo-temp').innerHTML = temp;

    var detail = c[1];
    if (jour) {
      detail += ', ' + Math.round(jour.max) + '° / ' + Math.round(jour.min) + '°';
      if (jour.pluie >= 20) { detail += ', pluie ' + jour.pluie + ' %'; }
    }
    $('meteo-detail').innerHTML = detail;

    var html = '', n = 0;
    for (i = 0; i < meteo.jours.length && n < 3; i++) {
      var j = meteo.jours[i];
      if (j.t <= t) { continue; }
      var dj = new Date(j.t * 1000);
      html += '<div class="prev"><span class="prev-jour">' + JOURS_COURTS[dj.getDay()] + '</span>' +
        '<span class="prev-icone">' + ciel(j.code, false)[0] + '</span>' +
        Math.round(j.max) + '° <span class="prev-min">' + Math.round(j.min) + '°</span></div>';
      n++;
    }
    $('previsions').innerHTML = html;
    $('nuit-infos-meteo').innerHTML = c[0] + ' ' + temp;
  }

  // ------------------------------------------------------------ Agenda
  function etiquetteJour(d, auj) {
    var ecart = Math.round((minuit(d) - minuit(auj)) / 86400000);
    if (ecart <= 0) { return 'Aujourd’hui'; }
    if (ecart === 1) { return 'Demain'; }
    return maj1(JOURS[d.getDay()]) + ' ' + d.getDate();
  }
  function rendreAgenda() {
    var el = $('agenda');
    if (!agenda || !agenda.actif) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    var auj = new Date(), t = auj.getTime(), html = '', n = 0, groupe = '', i;
    var max = window.innerHeight > window.innerWidth ? 4 : 6;
    for (i = 0; i < agenda.evenements.length && n < max; i++) {
      var ev = agenda.evenements[i];
      if (ev.fin <= t) { continue; }
      var debut = new Date(ev.debut);
      var etiquette = etiquetteJour(ev.debut < t ? auj : debut, auj);
      if (etiquette !== groupe) { html += '<div class="ag-jour">' + etiquette + '</div>'; groupe = etiquette; }
      html += '<div class="ag-ev"><span class="ag-h">' + (ev.journee ? 'Journée' : hm(debut)) +
        '</span>' + echapper(ev.titre) + '</div>';
      n++;
    }
    el.innerHTML = n ? html : '<div class="ag-vide">Rien de prévu cette semaine.</div>';
  }

  // ------------------------------------------------------------ Photos
  function melanger(liste) {
    for (var i = liste.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1)), x = liste[i];
      liste[i] = liste[j]; liste[j] = x;
    }
    return liste;
  }
  function photoSuivante() {
    // La nuit, on ne charge rien : ça économise la mémoire du vieil iPad.
    if (!photos.length || document.body.className === 'nuit') { return; }
    if (indexPhoto >= ordre.length) { ordre = melanger(photos.slice(0)); indexPhoto = 0; }
    var src = ordre[indexPhoto++], img = new Image();
    img.onload = function () {
      var nouveau = $('c' + (1 - calqueActif)), ancien = $('c' + calqueActif);
      nouveau.style.backgroundImage = 'url("' + src + '")';
      nouveau.style.opacity = 1;
      ancien.style.opacity = 0;
      calqueActif = 1 - calqueActif;
      photoAffichee = true;
    };
    img.src = src;
  }

  // ------------------------------------------------------------ Son
  function debloquerSon() {
    if (sonDebloque) { return; }
    var Contexte = window.AudioContext || window.webkitAudioContext;
    if (!Contexte) { return; }
    try {
      if (!audio) { audio = new Contexte(); }
      var tampon = audio.createBuffer(1, 1, 22050), source = audio.createBufferSource();
      source.buffer = tampon;
      source.connect(audio.destination);
      if (source.start) { source.start(0); } else { source.noteOn(0); }
      if (audio.resume) { audio.resume(); }
      sonDebloque = true;
    } catch (e) { }
    afficherReveil();
  }
  function bip(frequence, quand, duree, volume) {
    var o = audio.createOscillator();
    var g = audio.createGain ? audio.createGain() : audio.createGainNode();
    o.type = 'sine';
    o.frequency.value = frequence;
    g.gain.setValueAtTime(0, quand);
    g.gain.linearRampToValueAtTime(volume, quand + 0.02);
    g.gain.setValueAtTime(volume, quand + duree - 0.03);
    g.gain.linearRampToValueAtTime(0, quand + duree);
    o.connect(g);
    g.connect(audio.destination);
    if (o.start) { o.start(quand); o.stop(quand + duree + 0.05); }
    else { o.noteOn(quand); o.noteOff(quand + duree + 0.05); }
  }
  function motif(volume) {
    if (!audio) { return; }
    var t = audio.currentTime + 0.05;
    bip(784, t, 0.16, volume);
    bip(784, t + 0.24, 0.16, volume);
    bip(1047, t + 0.48, 0.32, volume);
  }

  // ------------------------------------------------------------ Réveil
  function verifierReveil(d) {
    var t = d.getTime();
    if (sonnerie) {
      if (t - sonnerie.debut > 10 * 60000) { arreter(false); }
      return;
    }
    if (repeterA && t >= repeterA) { repeterA = 0; sonner(); return; }
    if (!reveil.actif) { return; }
    var cle = d.toDateString() + ' ' + reveil.heure + ':' + reveil.minute;
    if (d.getHours() === reveil.heure && d.getMinutes() === reveil.minute && cle !== dernierDeclenchement) {
      dernierDeclenchement = cle;
      sonner();
    }
  }
  function sonner() {
    sonnerie = { debut: new Date().getTime(), minuteur: null };
    document.body.className = 'jour';
    $('sonnerie').style.display = 'block';
    var jouer = function () {
      var ecoule = (new Date().getTime() - sonnerie.debut) / 1000;
      motif(Math.min(1, 0.12 + ecoule / 90));   // le son monte doucement sur 1 min 30
    };
    jouer();
    sonnerie.minuteur = setInterval(jouer, 1600);
  }
  function arreter(repeter) {
    if (!sonnerie) { return; }
    clearInterval(sonnerie.minuteur);
    sonnerie = null;
    $('sonnerie').style.display = 'none';
    if (repeter) {
      repeterA = new Date().getTime() + 9 * 60000;
    } else {
      repeterA = 0;
      modeForce = { mode: 'jour', jusqua: prochaine(config.nuit_debut) };
    }
    tic();
  }
  function afficherReveil() {
    var texte = deux(reveil.heure) + ':' + deux(reveil.minute);
    var bouton = $('btn-reveil');
    bouton.innerHTML = reveil.actif ? 'Réveil ' + texte : 'Réveil désactivé';
    bouton.className = reveil.actif ? 'actif' : '';

    var infos = '';
    if (repeterA) { infos = 'Répétition à ' + hm(new Date(repeterA)); }
    else if (reveil.actif) { infos = 'Réveil à ' + texte; }
    $('nuit-infos-reveil').innerHTML = infos;

    var sansSon = (reveil.actif || repeterA) && !sonDebloque;
    $('son-jour').style.display = sansSon ? 'block' : 'none';
    $('son-nuit').style.display = sansSon ? 'block' : 'none';
  }
  function ouvrirReglage() {
    $('r-h').innerHTML = deux(reveil.heure);
    $('r-m').innerHTML = deux(reveil.minute);
    $('r-actif').innerHTML = reveil.actif ? 'Réveil activé' : 'Réveil désactivé';
    $('r-actif').className = reveil.actif ? '' : 'eteint';
    $('reglage').style.display = 'block';
  }
  function actionReglage(e) {
    var cible = e.target, act = cible.getAttribute && cible.getAttribute('data-act');
    if (!act) { return; }
    if (act === 'h+') { reveil.heure = (reveil.heure + 1) % 24; }
    if (act === 'h-') { reveil.heure = (reveil.heure + 23) % 24; }
    if (act === 'm+') { reveil.minute = (reveil.minute + 5) % 60; }
    if (act === 'm-') { reveil.minute = (reveil.minute + 55) % 60; }
    if (act === 'actif') { reveil.actif = !reveil.actif; }
    if (act === 'test') { debloquerSon(); motif(0.6); }
    if (act === 'ok') { $('reglage').style.display = 'none'; }
    reveil.minute = reveil.minute - (reveil.minute % 5);
    ecrire('reveil', reveil);
    dernierDeclenchement = '';
    if (act !== 'ok') { ouvrirReglage(); }
    afficherReveil();
  }

  // ------------------------------------------------------------ Données
  function verifierFraicheur() {
    var el = $('maj');
    if (meteo && meteo.maj && new Date().getTime() - meteo.maj > 3 * 3600000) {
      el.innerHTML = 'Données du ' + hm(new Date(meteo.maj)) + ', la mise à jour automatique semble bloquée.';
    } else {
      el.innerHTML = '';
    }
  }
  function chargerMeteoAgenda() {
    charger('data/weather.json', function (d) { meteo = d; rendreMeteo(); verifierFraicheur(); });
    charger('data/agenda.json', function (d) { agenda = d; rendreAgenda(); });
  }
  function chargerPhotos() {
    charger('data/photos.json', function (d) {
      var liste = d.photos || [];
      if (liste.join('|') === photos.join('|')) { return; }
      photos = liste;
      ordre = [];
      indexPhoto = 0;
      $('photos-vide').style.display = photos.length ? 'none' : 'block';
      if (!photoAffichee) { photoSuivante(); }
    });
  }

  // ------------------------------------------------------------ Démarrage
  function demarrer() {
    document.addEventListener('touchend', debloquerSon, false);
    document.addEventListener('click', debloquerSon, false);

    $('btn-reveil').addEventListener('click', ouvrirReglage, false);
    $('reglage').addEventListener('click', actionReglage, false);
    $('btn-nuit').addEventListener('click', function () {
      modeForce = nuitPrevue(new Date()) ? null : { mode: 'nuit', jusqua: prochaine(config.nuit_fin) };
      tic();
    }, false);
    $('nuit').addEventListener('click', function () {
      modeForce = { mode: 'jour', jusqua: new Date().getTime() + 60000 };  // 1 min d'écran complet
      tic();
    }, false);
    $('btn-repeter').addEventListener('click', function () { arreter(true); }, false);
    $('btn-arreter').addEventListener('click', function () { arreter(false); }, false);

    var infos = $('nuit-infos');
    infos.innerHTML = '<span id="nuit-infos-meteo"></span>&nbsp;&nbsp;&nbsp;<span id="nuit-infos-reveil"></span>';

    tic();
    setInterval(tic, 1000);
    chargerMeteoAgenda();
    chargerPhotos();
    setInterval(chargerMeteoAgenda, 10 * 60000);
    setInterval(chargerPhotos, 30 * 60000);
    setInterval(function () { rendreMeteo(); rendreAgenda(); verifierFraicheur(); }, 60000);
    setInterval(photoSuivante, Math.max(10, config.diaporama_secondes) * 1000);
  }

  var demarre = false;
  function lancerUneFois() { if (!demarre) { demarre = true; demarrer(); } }
  charger('config.json', function (c) {
    var cle;
    for (cle in c) { if (c.hasOwnProperty(cle)) { config[cle] = c[cle]; } }
    lancerUneFois();
  });
  setTimeout(lancerUneFois, 4000);  // si config.json ne répond pas, on part avec les valeurs par défaut
}());
