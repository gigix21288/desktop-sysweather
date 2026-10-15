# Desktop System & Weather Widget

Widget trasparente per il desktop di GNOME (Zorin OS, Ubuntu, Debian, Fedora…) che mostra:

- **Sistema**: utilizzo CPU con grafico storico, temperatura CPU, carico, temperatura e frequenza
  della GPU e memoria video usata (AMD, NVIDIA, Intel e altri driver DRM, senza privilegi),
  memoria, swap, disco,
  velocità di rete, carico medio, ventole, batteria con autonomia residua (o tempo alla ricarica
  completa), tempo di attività
- **Meteo**: condizioni attuali, temperatura percepita, umidità, vento e previsioni per 4 giorni
  con la probabilità di pioggia di ogni giorno
  (dati [Open-Meteo](https://open-meteo.com), nessuna chiave API necessaria)
- **Prossime ore**: sei fasce di due ore con orario, icona giorno/notte, temperatura e
  probabilità di pioggia quando supera il 20%
- **Allerte meteo**: le allerte gialle, arancioni e rosse del servizio meteorologico nazionale
  per la tua regione, diffuse da [MeteoAlarm](https://meteoalarm.org) (Italia e altri 16 paesi
  europei), con dettagli al passaggio del mouse e notifica desktop per quelle arancioni e rosse
- **Pioggia nelle prossime due ore**: "Pioggia tra 25 min · per ~45 min", con una mini barra
  a intervalli di 15 minuti (compare solo quando serve)
- **Sole e luna**: arco del sole con la posizione attuale, orari di alba e tramonto, tempo che
  manca al tramonto; di notte la fase lunare calcolata localmente e i giorni alla prossima luna
  piena o nuova
- **Aria, UV e pollini**: indice europeo di qualità dell'aria, indice UV attuale e massimo del
  giorno, polline dominante (betulla, graminacee, olivo… disponibile in Europa)
- **Consiglio del giorno**: una riga pratica ricavata dalle prossime ore ("Porta l'ombrello:
  pioggia probabile dalle 18", "UV alto verso le 13: crema solare", "Ottimo per stendere…")
- **Terremoti recenti**: l'ultima scossa degli ultimi 7 giorni entro il raggio scelto
  (dati [INGV](https://www.ingv.it) in Italia, USGS altrove)
- **Sfondo cielo vivo**: la scheda prende il colore del cielo reale: azzurro di giorno, arancio
  all'alba e al tramonto, blu notte con le stelle, grigio sotto la pioggia, con gocce o fiocchi
- **Meteo spaziale e ISS**: indice Kp della NOAA con allerta tempesta geomagnetica e aurora,
  distanza attuale della Stazione Spaziale Internazionale ("ISS sopra di te adesso · guarda in alto!")

E, per chi lavora nell'informatica o nella sicurezza, un pannello **Rete e sicurezza** letto in
locale senza privilegi (NetworkManager via D-Bus, `/proc`, `/sys`, systemd e login1 via D-Bus):

- **Rete**: IP pubblico con operatore e paese (mascherabile per gli screenshot), stato VPN con
  avviso se la VPN cade o l'IP pubblico cambia, Wi-Fi con banda e cifratura (segnala reti aperte,
  WEP e WPA1), IP locale, gateway, DNS e interfaccia
- **Dispositivi nella rete locale**: quanti sono (dalla cache ARP, senza generare traffico),
  con IP e MAC nel riquadro al passaggio del mouse e un avviso quando ne compare uno nuovo
- **Porte e connessioni**: porte TCP in ascolto, quelle esposte verso la rete elencate per nome
  (22 ssh, 631 ipp…), connessioni attive e numero di host remoti
- **Latenza**: grafico del tempo di connessione TCP verso l'host scelto (1.1.1.1 di default),
  media e percentuale di sonde perse
- **Sicurezza**: firewall (ufw, firewalld, nftables), aggiornamenti in sospeso e di sicurezza
  (apt, pacman, dnf, zypper e Flatpak), riavvio richiesto (nuovo kernel installato o richiesta della distribuzione), accessi falliti
  nelle ultime 24 ore, sessioni remote e utenti connessi, server SSH, unità systemd in errore,
  Secure Boot, cifratura LUKS del disco, AppArmor/SELinux, container Docker/Podman in esecuzione,
  con un riepilogo "Tutto ok" o "N avvisi"
- **Processi**: i tre processi che usano più CPU e più memoria
- **Feed**: le ultime vulnerabilità sfruttate attivamente dal catalogo [CISA KEV](https://www.cisa.gov/known-exploited-vulnerabilities-catalog)
  (con evidenza di quelle usate da ransomware) e le ultime notizie del [CERT-AGID](https://cert-agid.gov.it)
- **Dettagli al passaggio del mouse**: fermando il puntatore su un indicatore di sicurezza, su una
  CVE o su una notizia compare un riquadro con i dettagli: gli ultimi tentativi di accesso falliti
  (ora, servizio, utente, indirizzo di origine), i pacchetti da aggiornare e la data dell'ultimo
  aggiornamento, le unità in errore, le sessioni aperte, la configurazione del server SSH, i
  container con immagine e porte, il significato di Secure Boot, cifratura e AppArmor; per le CVE
  descrizione, azione richiesta, data di aggiunta e scadenza CISA, per le notizie il sommario.
  Un clic sulla CVE o sulla notizia la apre nel browser (NVD o CERT-AGID)
- **Notifiche desktop** quando la VPN cade, quando cinque o più accessi falliscono tra due
  controlli, per le allerte meteo arancioni e rosse e quando CISA aggiunge al catalogo KEV una
  vulnerabilità usata da ransomware (le CVE già viste non vengono ripetute al login)
- **Orologio UTC e tempo Unix** sotto il nome del computer; tutti gli altri orari seguono il
  formato 12 o 24 ore scelto nelle impostazioni di GNOME
- **Temi Terminal**: oltre a scuro e chiaro, due temi a fosfori (verde e ambra) con font
  monospace, grafici a blocchi e scanline
- **Due colonne**: meteo e feed a sinistra, sistema, rete e sicurezza a destra (predefinito),
  oppure una sola colonna

![Tema scuro](docs/screenshot-dark.png)
![Tema chiaro](docs/screenshot-light.png)
![Preferenze](docs/screenshot-prefs.png)

## Funzionalità

| Impostazione | Opzioni |
|---|---|
| Lingua | Lingua di sistema, English, Italiano (vale per il widget e per le preferenze) |
| Tema | Scuro / Chiaro / Terminale verde / Terminale ambra |
| Disposizione | Una o due colonne |
| Trasparenza dello sfondo | 0–100% |
| Dimensione | 70–160% |
| Posizione | in alto a sinistra / al centro / a destra, al centro, in basso a sinistra / al centro / a destra |
| Monitor | primario oppure uno schermo scelto per nome (es. HDMI-1); se è scollegato si torna al primario |
| Margine dai bordi | in pixel |
| Sfondo cielo vivo | Attivo / disattivo (con lo sfondo fisso del tema) |
| Posizione meteo | Automatica (servizi di localizzazione di sistema, altrimenti IP) oppure città cercata per nome |
| Unità | Metriche (°C, km/h) o imperiali (°F, mph) |
| Terremoti | Magnitudo minima e raggio di ricerca in km |
| Sezioni | Ogni blocco si può nascondere: allerte meteo, prossime ore, pioggia, sole e luna, aria, meteo spaziale, consiglio, previsioni, terremoti, sistema, processi, rete, porte, latenza, sicurezza, feed… |
| Rete | Host per la latenza, intervalli di aggiornamento, maschera dell'IP pubblico |
| Sicurezza | Dettagli al passaggio del mouse (attivabile/disattivabile), intervallo di controllo |
| Notifiche | VPN caduta, raffica di accessi falliti, allerte meteo arancioni e rosse, nuova vulnerabilità ransomware (ciascuna attivabile/disattivabile) |
| Ripristino | Pulsante nella pagina Aspetto che riporta ogni opzione al valore predefinito |

Le preferenze si aprono con l'**ingranaggio** in alto a destra nel widget (compare passando
il mouse sulla scheda), dall'app **Estensioni**, oppure con:

```bash
gnome-extensions prefs desktop-sysweather@piorio.github.io
```

## Compatibilità

- **GNOME Shell 45 e successivi**, sia Wayland sia X11: Zorin OS 18 (Core/Pro), Ubuntu 24.04+,
  Debian 13+, Fedora 39+, ecc. Testato su Zorin OS 18.1 / GNOME 46.
- Non funziona su desktop diversi da GNOME (KDE, XFCE/Zorin Lite, Cinnamon, MATE).

Il widget è disegnato nel livello dello sfondo di GNOME Shell: resta sotto tutte le finestre
e non compare in Alt+Tab. Legge i dati direttamente da `/proc`, `/sys` e D-Bus, quindi non servono
programmi aggiuntivi né privilegi. Il riquadro dei dettagli e l'ingranaggio sono disegnati sopra
le finestre solo mentre il puntatore è sulla scheda, perché il livello dello sfondo non riceve
eventi del mouse. Gli accessi falliti richiedono che il journal sia leggibile
(gruppo `adm` o `systemd-journal`, come di default su Zorin/Ubuntu); gli aggiornamenti usano
`apt-check` di update-notifier dove presente, altrimenti `checkupdates` (Arch), `dnf` (Fedora,
dai metadati già scaricati) o `zypper` (openSUSE), più `flatpak remote-ls --updates`. Servizi
esterni usati: Open-Meteo, Nominatim, MeteoAlarm, INGV/USGS, ipwho.is (IP pubblico), CISA,
CERT-AGID, NOAA SWPC, wheretheiss.at.

## Installazione

I pacchetti pronti (`.deb` e `.zip`) si scaricano dalla pagina
[Releases](https://github.com/gigix21288/desktop-sysweather/releases); in alternativa si
costruiscono dai sorgenti con `./build.py` (vedi [Sviluppo](#sviluppo)).

### Pacchetto .deb (Zorin OS, Ubuntu, Debian)

```bash
sudo apt install ./gnome-shell-extension-desktop-sysweather_1.6.0_all.deb
```

Poi **esci e rientra** nella sessione e attiva il widget dall'app *Estensioni*, oppure con
`gnome-extensions enable desktop-sysweather@piorio.github.io`.

### Pacchetto .zip (qualsiasi distribuzione con GNOME, per il solo utente corrente)

```bash
./install.sh desktop-sysweather@piorio.github.io.shell-extension.zip
```

Lo script installa e attiva l'estensione. Su Wayland bisogna poi uscire e rientrare nella sessione.

### Disinstallazione

```bash
gnome-extensions uninstall desktop-sysweather@piorio.github.io   # versione .zip
sudo apt remove gnome-shell-extension-desktop-sysweather          # versione .deb
```

## Posizione automatica

Con la posizione **Automatica** il widget chiede prima la posizione ai **servizi di localizzazione
di sistema** (GeoClue, lo stesso servizio usato dal meteo di GNOME): funziona se in
*Impostazioni → Privacy → Servizi di localizzazione* l'interruttore è attivo. GeoClue usa il GPS o
il modem se presenti, altrimenti le reti Wi-Fi vicine (database BeaconDB); se le reti intorno non
sono censite ricade sull'indirizzo IP e la precisione scende a decine di km (il widget lo indica
nella riga di stato, es. "posizione di sistema ±26 km").

Se i servizi di localizzazione sono spenti o GeoClue non è installato, la posizione viene stimata
dall'indirizzo IP come in passato. Il nome della località viene ricavato da OpenStreetMap
(Nominatim).

## Privacy

- La posizione di sistema resta sul computer: al widget arrivano solo le coordinate.
- La stima dall'indirizzo IP usa `ipwho.is` (con `get.geojs.io` come riserva), al massimo una
  volta ogni 3 ore.
- Previsioni, qualità dell'aria e ricerca delle città usano Open-Meteo; il nome della località
  Nominatim (OpenStreetMap); i terremoti INGV o USGS. A tutti arrivano solo coordinate
  arrotondate.
- Con una città impostata manualmente non viene contattato alcun servizio di geolocalizzazione
  (una città scelta con una versione precedente alla 1.5 viene cercata una sola volta su
  Open-Meteo per ricavarne regione e paese, poi il risultato resta nelle impostazioni).
- Per le allerte meteo si scarica il feed MeteoAlarm dell'intero paese e il filtro per regione
  avviene sul computer: a MeteoAlarm non arriva nessuna coordinata.

## Sviluppo

```
extension/            sorgenti dell'estensione (ESM, GNOME 45+)
  extension.js        ciclo di vita, timer, posizionamento
  prefs.js            finestra delle preferenze (libadwaita)
  lib/system.js       lettura di /proc e /sys (asincrona)
  lib/weather.js      Open-Meteo (meteo, aria), geolocalizzazione IP, Nominatim, INGV/USGS
  lib/geoclue.js      posizione dai servizi di localizzazione di sistema (GeoClue 2)
  lib/sky.js          calcoli puri: sole, luna, colori del cielo, pioggia a 15 min, consiglio
  lib/widget.js       interfaccia (St + Cairo) e testi dei riquadri di dettaglio
  lib/security.js     stato di sicurezza locale (apt, journal, systemd, login1, /sys)
  lib/feeds.js        CISA KEV, CERT-AGID, NOAA, ISS, MeteoAlarm, IP pubblico
  stylesheet.css      temi scuro e chiaro
po/                   traduzioni (it)
build.py              crea dist/*.zip e dist/*.deb
install.sh            installazione per l'utente corrente dal .zip
tools/                msgfmt.py (compilatore .po di riserva), nested-shell.sh (test)
CHANGELOG.md          storia delle versioni
```

```bash
./build.py            # crea zip e deb in dist/
./build.py zip        # solo zip
```

La build richiede `python3` e `glib-compile-schemas`, più `dpkg-deb` per creare il `.deb`.
Se `msgfmt` non è installato si usa `tools/msgfmt.py`.

Per provare una modifica senza uscire dalla sessione (Wayland ricarica le estensioni solo al
login) si può usare una GNOME Shell annidata con l'estensione installata:

```bash
./build.py zip && gnome-extensions install --force dist/*.zip
tools/nested-shell.sh 40 /tmp/widget.png     # avvia la shell annidata e salva uno screenshot
RUN="gnome-extensions prefs desktop-sysweather@piorio.github.io" tools/nested-shell.sh 40 /tmp/prefs.png
```

La shell annidata condivide le impostazioni (dconf) con la sessione reale; `tools/nested-shell.sh`
accetta un terzo argomento con uno script JavaScript da eseguire nella shell (`org.gnome.Shell.Eval`).

Per aggiungere una lingua, copia `po/it.po` in `po/<codice>.po` e traduci le stringhe `msgstr`
(e le forme `msgstr[0]`/`msgstr[1]` dei plurali): dopo la build la lingua compare da sola nel
menu *Lingua* delle preferenze. Le stringhe sorgente sono in inglese, quindi l'inglese è sempre
disponibile. Con *Lingua di sistema* si usa gettext; con una lingua scelta il widget legge il
catalogo `.mo` direttamente (`lib/i18n.js`), perché gettext non cambia lingua a runtime.

## Licenza

GNU General Public License, versione 2 o successiva (GPL-2.0-or-later), come richiesto per le
estensioni pubblicate su extensions.gnome.org. Il testo completo è nel file `LICENSE`.
