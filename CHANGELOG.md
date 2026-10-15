# Changelog

Tutte le modifiche rilevanti del widget. Le date sono quelle di build dei pacchetti.

## 1.6.0 — 2026-10-14

- **Scelta della lingua** nelle preferenze (pagina Aspetto): *Lingua di sistema*, *English* o
  *Italiano*. La scelta vale per il widget e per la finestra delle preferenze, che si
  ritraduce subito; nomi dei giorni e dei mesi, ricerca delle città e nomi delle località
  seguono la lingua scelta. L'elenco delle lingue è ricavato dai cataloghi presenti in
  `locale/`: basta aggiungere un `po/<codice>.po` per avere una lingua in più.

## 1.5.0 — 2026-10-14

### Novità
- **Allerte meteo (MeteoAlarm)**: le allerte del servizio meteorologico nazionale per la regione
  della posizione meteo (gialle, arancioni, rosse) compaiono sotto le condizioni attuali, con il
  dettaglio al passaggio del mouse (regione, inizio, fine) e il link alla pagina MeteoAlarm.
  Notifica desktop per le allerte arancioni e rosse (disattivabile). Feed verificati per 17 paesi
  europei; la regione viene dalla città scelta (Open-Meteo), da GeoClue/Nominatim o dall'IP.
- **Formato ora 12/24 h** seguendo l'impostazione di GNOME (`clock-format`): fascia oraria,
  alba/tramonto, orari nei riquadri di dettaglio.
- **UV massimo del giorno** accanto all'indice UV attuale ("UV 4 · moderato · max 7").
- **Giorni alla prossima luna piena o nuova** accanto alla fase lunare, di notte.
- **Aggiornamenti in sospeso** anche con **dnf** (Fedora/RHEL, con conteggio di sicurezza),
  **zypper** (openSUSE) e **Flatpak** (elencati nel riquadro con l'etichetta Flatpak).
- **Notifica per raffica di accessi falliti**: cinque o più nuovi accessi falliti tra due controlli
  di sicurezza (disattivabile).
- **Ripristino delle impostazioni predefinite** dalla pagina Aspetto delle preferenze, con conferma.
- **Partizione /home separata** mostrata come barra "Home" sotto il disco, quando esiste.
- **Velocità di rete dell'interfaccia primaria** (invece della somma di tutte le schede) quando la
  sezione Rete è attiva.
- **DNS con systemd-resolved** nel fallback senza NetworkManager: i server reali al posto dello
  stub 127.0.0.53.

### Miglioramenti
- Plurali corretti in italiano ("1 aggiornamento", "+1 altro", "1 accesso fallito") tramite
  `ngettext`; `tools/msgfmt.py` compila anche le forme plurali.
- `tools/nested-shell.sh` accetta `RUN=...` per avviare un programma (ad es. le preferenze) dentro
  la sessione annidata.
- Screenshot aggiornati in `docs/`.

## 1.4.0 — 2026-10-13

- Notifiche desktop quando la VPN cade e quando CISA aggiunge al catalogo KEV una vulnerabilità
  usata da ransomware (le CVE già notificate non vengono ripetute al login).
- Striscia delle prossime ore: sei fasce di due ore con orario, icona, temperatura e probabilità
  di pioggia; probabilità di pioggia massima sotto ogni giorno delle previsioni.
- Autonomia residua della batteria (o tempo alla ricarica completa).
- Dispositivi nella rete locale dalla cache ARP, con elenco al passaggio del mouse e avviso per
  i nuovi dispositivi.
- Scelta del monitor per nome del connettore.

## 1.3.1 — 2026-10-13

- Correzioni dalla revisione del codice: promessa dell'ingranaggio, DNS IPv6, nuovo tentativo
  con NetworkManager, interfacce tap/ppp escluse dalla VPN, velocità solo delle interfacce
  fisiche, nvidia-smi solo con il driver proprietario, precedenza delle opzioni sshd e
  `ssh.socket`, timeout dei sottoprocessi, elenco LSM del kernel, `LoadUnit` di systemd,
  etichette con ora legale, giorno/notte polare, richieste terremoti coalescenti, User-Agent dai
  metadati, licenza GPL-2.0-or-later, copyright nel .deb.

## 1.3.0 — 2026-10-13

- Dettagli al passaggio del mouse: riquadro con i dettagli degli indicatori di sicurezza, delle
  CVE e delle notizie, con clic per aprire il browser.

## 1.2.0 — 2026-10-13

- Pannello Rete e sicurezza: IP pubblico e operatore, VPN, Wi-Fi, IP locale, gateway, DNS, porte
  in ascolto ed esposte, latenza, firewall, aggiornamenti, accessi falliti, sessioni remote,
  Secure Boot, cifratura del disco, AppArmor/SELinux, container, processi principali.
- Feed CISA KEV e CERT-AGID, meteo spaziale (Kp) e posizione della ISS.
- Carico medio, GPU (carico, temperatura, frequenza, VRAM).
- Temi Terminal (verde e ambra), disposizione a due colonne, orologio UTC e tempo Unix.

## 1.1.0 — 2026-10-13

- Prima versione pacchettizzata (.zip e .deb): sistema (CPU, memoria, swap, disco, rete,
  ventole, batteria), meteo Open-Meteo con previsioni a 4 giorni, pioggia nelle prossime due
  ore, sole e luna, aria/UV/pollini, consiglio del giorno, terremoti INGV/USGS, sfondo cielo
  vivo, posizione da GeoClue, IP o città scelta.
