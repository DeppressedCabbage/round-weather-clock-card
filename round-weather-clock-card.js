/*
 * round-weather-clock-card
 * A Home Assistant Lovelace card for round displays: digital clock, current
 * conditions, a 4-day forecast on the lower arc, and a temperature ring around
 * an open temperature arc around the rim: 12 AM at its lower-left end, noon at the
 * top, 12 AM at its lower-right end.
 *
 * Install: copy to /config/www/round-weather-clock-card.js, then add a
 * dashboard resource: /local/round-weather-clock-card.js?v=2 (JavaScript module).
 * Bump ?v= whenever you change the file so WebViews don't serve a stale copy.
 *
 * Config:
 *   type: custom:round-weather-clock-card
 *   entity: weather.home        # required, must be a weather.* entity
 *   forecast_days: 4            # 2-4 (default 4), starting tomorrow
 *   time_format: 12             # 12 or 24 (default 12)
 *   marker_label: temp          # temp (default) or letter (H / L)
 *   temperature_entity: sensor.outdoor_temperature   # optional, see below
 *   switches:                   # optional, up to 4. Tap the clock to show them.
 *     - entity: light.lamp      # light / switch / fan / input_boolean only
 *       name: Lamp              # optional short label
 *   switch_timeout: 20          # seconds before returning to the forecast (0 = stay)
 *   size: 320px                 # optional size override (default fills the screen)
 *
 * Everything above can also be set in the dashboard's visual card editor.
 *
 * Tapping the clock/date area swaps the forecast for the switch buttons; tapping
 * it again (or waiting switch_timeout seconds) swaps back.
 *   size: 100vmin               # optional: px | vmin | vw | vh, e.g. 320px
 *
 * The ring shows TODAY, midnight to midnight. The forecast API only returns the
 * future, so the part of the day that has already happened is read from Home
 * Assistant's recorder (one websocket request every 15 minutes). By default that is
 * the weather entity's recorded `temperature`; set temperature_entity to a real
 * outdoor sensor for better data. The rest of the day comes from the HOURLY
 * forecast, so the weather entity must support it. Anything with no data yet is
 * drawn dim, and no high/low marker is placed from data that doesn't exist.
 *
 * Design notes:
 *  - No network calls of its own. Forecasts arrive through HA's already
 *    authenticated websocket (hass.connection): no API keys on the display.
 *  - Entity data is only ever written with textContent / SVG attributes built
 *    from numbers, or used as a lookup key. Never interpolated into HTML.
 *  - All sizes are multiples of one unit (--u = 1% of the face diameter), so
 *    the layout scales to any round display.
 *  - Timers and subscriptions are released when the element is detached.
 */

// ---- layout constants (units: 1 = 1% of face diameter; center is 0,0) ----
const ARC_RADIUS = 24.5; // forecast arc radius
const ARC_STEP_DEG = 33.3; // angle between forecast items, measured from the bottom
const RING_R = 44.6; // temperature ring centerline radius
const RING_W = 3.6; // ring thickness
const MARKER_R = 3.9; // high/low marker radius
const DOT_R = 3.1; // current-time dot radius
const SEGMENTS = 96; // ring resolution (15 minutes each)

// Forecast item metrics. The CSS below AND the arc geometry both read these, so the
// ring's open end always lines up with the forecast text instead of drifting.
const FC_DAY = 4.8; // day label font size
const FC_ICON = 10; // icon box
const FC_HI = 6; // high temp font size
const FC_LO = 4.8; // low temp font size
const FC_GAP = 0.4; // flex gap between the four rows
const FC_LH = 1.1; // line-height multiplier
const HI_GLYPH_INSET = 1.2; // digit tops sit slightly below the top of the text box
const TRACK = 'rgba(255,255,255,0.14)';
const MAX_GAP_MS = 4 * 3600000; // never draw a colour across a data gap longer than this
const HISTORY_REFRESH_MS = 15 * 60000; // re-read today's recorded temperatures this often

// Only these domains can be switched from the card. This guards against a typo or a
// careless edit (a lock or garage door must never be one tap away). It is NOT a
// security boundary: the card runs with whatever permissions its HA user has.
const SWITCH_DOMAINS = ['light', 'switch', 'fan', 'input_boolean'];
const MAX_SWITCHES = 4;
const DEFAULT_SWITCH_TIMEOUT = 20; // seconds
const ENTITY_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;

// Ring colour ramp (cold -> mild -> warm), normalised to the next-24h range.
const COLD = [59, 130, 246];
const MID = [141, 229, 106];
const HOT = [247, 243, 107];

const own = (map, key) =>
  Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;

// Number(null) is 0, which would show a bogus "0 degrees". Treat null/'' as missing.
const num = (x) => (x === null || x === undefined || x === '' ? NaN : Number(x));

const lerp = (a, b, t) => a + (b - a) * t;
const rampColor = (t) => {
  const [a, b, k] = t < 0.5 ? [COLD, MID, t / 0.5] : [MID, HOT, (t - 0.5) / 0.5];
  const c = (i) => Math.round(lerp(a[i], b[i], Math.min(1, Math.max(0, k))));
  return `rgb(${c(0)},${c(1)},${c(2)})`;
};

// Angles are degrees clockwise from the TOP of the face. The ring is an open arc
// (gap at the bottom): midnight at the lower-left end, noon at the top, midnight
// again at the lower-right end. See _hoursToDeg().
const polar = (deg, r) => {
  const a = (deg * Math.PI) / 180;
  return [r * Math.sin(a), -r * Math.cos(a)];
};
const arcPath = (d1, d2, r) => {
  const [x1, y1] = polar(d1, r);
  const [x2, y2] = polar(d2, r);
  return `M${x1.toFixed(3)} ${y1.toFixed(3)}A${r} ${r} 0 0 1 ${x2.toFixed(3)} ${y2.toFixed(3)}`;
};

const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

// Place an element on the lower arc: item i of n, angles measured from straight down.
const placeOnArc = (el, i, n) => {
  const rad = (((i - (n - 1) / 2) * ARC_STEP_DEG) * Math.PI) / 180;
  el.style.setProperty('--dx', (ARC_RADIUS * Math.sin(rad)).toFixed(2));
  el.style.setProperty('--dy', (ARC_RADIUS * Math.cos(rad)).toFixed(2));
};

const svg = (inner) => `<svg viewBox="0 0 64 64" aria-hidden="true">${inner}</svg>`;

const SUN =
  '<circle cx="32" cy="32" r="11" fill="#FFC53D"/>' +
  '<path d="M32 8v6M32 50v6M8 32h6M50 32h6M15 15l4 4M45 45l4 4M49 15l-4 4M19 45l-4 4" ' +
  'stroke="#FFC53D" stroke-width="3.5" stroke-linecap="round" fill="none"/>';

const CLOUD =
  '<g fill="#DCE3EA"><circle cx="23" cy="40" r="8"/><circle cx="33" cy="33" r="11"/>' +
  '<circle cx="44" cy="40" r="8"/><rect x="23" y="40" width="21" height="8"/></g>';

// Static, trusted markup only. Never build these from entity data.
const ICONS = {
  sun: svg(SUN),
  moon: svg('<path d="M40 12a21 21 0 1 0 13 32A18 18 0 0 1 40 12z" fill="#E8E3C8"/>'),
  cloud: svg(CLOUD),
  partly: svg(
    `<g transform="translate(0 -2) scale(.6)">${SUN}</g><g transform="translate(4 6)">${CLOUD}</g>`
  ),
  rain: svg(
    CLOUD +
      '<path d="M26 52l-2 6M35 52l-2 6M44 52l-2 6" stroke="#6EC1FF" stroke-width="3.5" stroke-linecap="round" fill="none"/>'
  ),
  snow: svg(
    CLOUD +
      '<g fill="#FFFFFF"><circle cx="26" cy="54" r="2.5"/><circle cx="35" cy="58" r="2.5"/><circle cx="44" cy="54" r="2.5"/></g>'
  ),
  thunder: svg(CLOUD + '<path d="M36 42l-8 12h6l-3 9 12-14h-7l4-7z" fill="#FFD43B"/>'),
  fog: svg(
    CLOUD +
      '<path d="M14 53h36M20 59h30" stroke="#B8C2CC" stroke-width="3.5" stroke-linecap="round" fill="none"/>'
  ),
  wind: svg(
    '<path d="M8 24h30a6 6 0 1 0-6-6M8 36h40a6 6 0 1 1-6 6M8 48h22" stroke="#B8C2CC" stroke-width="3.5" stroke-linecap="round" fill="none"/>'
  ),
};

// Switch icons use currentColor, so the CSS colours them on/off.
const SW_ICONS = {
  light: svg(
    '<path d="M32 7a17 17 0 0 0-9.5 31c1.8 1.4 2.5 2.7 2.5 5v2h14v-2c0-2.3.7-3.6 2.5-5A17 17 0 0 0 32 7z" fill="currentColor"/>' +
      '<path d="M26 51h12M28.5 57h7" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" fill="none"/>'
  ),
  fan: svg(
    '<g fill="currentColor"><circle cx="32" cy="32" r="4.5"/>' +
      '<path d="M32 27C25 20 26 10 32 7C38 10 39 20 32 27Z"/>' +
      '<path d="M32 27C25 20 26 10 32 7C38 10 39 20 32 27Z" transform="rotate(120 32 32)"/>' +
      '<path d="M32 27C25 20 26 10 32 7C38 10 39 20 32 27Z" transform="rotate(240 32 32)"/></g>'
  ),
  power: svg(
    '<path d="M32 9v21M19.5 18.5a21 21 0 1 0 25 0" stroke="currentColor" stroke-width="5" stroke-linecap="round" fill="none"/>'
  ),
};
const SW_ICON_KEY = { light: 'light', fan: 'fan', switch: 'power', input_boolean: 'power' };
const SW_KIND = { light: 'Light', fan: 'Fan', switch: 'Switch', input_boolean: 'Toggle' };

const CONDITION_ICON = {
  sunny: 'sun',
  'clear-night': 'moon',
  partlycloudy: 'partly',
  cloudy: 'cloud',
  rainy: 'rain',
  pouring: 'rain',
  snowy: 'snow',
  'snowy-rainy': 'snow',
  hail: 'snow',
  lightning: 'thunder',
  'lightning-rainy': 'thunder',
  fog: 'fog',
  windy: 'wind',
  'windy-variant': 'wind',
  exceptional: 'cloud',
};

const CONDITION_TEXT = {
  sunny: 'Sunny',
  'clear-night': 'Clear',
  partlycloudy: 'Partly cloudy',
  cloudy: 'Cloudy',
  rainy: 'Rain',
  pouring: 'Heavy rain',
  snowy: 'Snow',
  'snowy-rainy': 'Sleet',
  hail: 'Hail',
  lightning: 'Thunder',
  'lightning-rainy': 'Storms',
  fog: 'Fog',
  windy: 'Windy',
  'windy-variant': 'Windy',
  exceptional: 'Alert',
};

const u = (n) => `calc(var(--u) * ${n})`;

const CSS = `
:host {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}
.face {
  --u: calc(var(--size, 100vmin) / 100);
  position: relative;
  flex: none;
  width: var(--size, 100vmin);
  height: var(--size, 100vmin);
  border-radius: 50%;
  overflow: hidden;
  color: var(--primary-text-color, #fff);
  font-family: var(--primary-font-family, Roboto, "Helvetica Neue", Arial, sans-serif);
  background:
    radial-gradient(circle at 30% 18%, rgba(255, 255, 255, 0.10), rgba(255, 255, 255, 0) 55%),
    var(--ha-card-background, var(--card-background-color, #15171c));
}
.ring {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.ring text {
  font-family: inherit;
}
.date,
.time,
.current {
  position: absolute;
  left: 50%;
  transform: translate(-50%, -50%);
  white-space: nowrap;
}
.date,
.time {
  pointer-events: none; /* taps fall through to .hit underneath */
}
.date {
  top: ${u(13.5)};
  font-size: ${u(4.6)};
  color: var(--secondary-text-color, #aab);
}
.time {
  top: ${u(25)};
  font-size: ${u(16)};
  font-weight: 300;
  line-height: 1;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}
.period {
  position: absolute;
  left: 100%;
  bottom: ${u(1.2)};
  margin-left: ${u(1)};
  font-size: ${u(5)};
  font-weight: 400;
  letter-spacing: 0;
  color: var(--secondary-text-color, #aab);
}
.current {
  top: ${u(44)};
  display: flex;
  align-items: center;
  gap: ${u(2)};
}
.cur-icon svg {
  display: block;
  width: ${u(11)};
  height: ${u(11)};
}
.cur-temp {
  font-size: ${u(9)};
  font-weight: 300;
  line-height: 1;
}
.cur-cond {
  font-size: ${u(4)};
  color: var(--secondary-text-color, #aab);
}
.fc {
  position: absolute;
  left: 50%;
  top: 50%;
  width: ${u(14)};
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: ${u(FC_GAP)};
  text-align: center;
  line-height: ${FC_LH};
  transform: translate(-50%, -50%)
    translate(calc(var(--dx) * var(--u)), calc(var(--dy) * var(--u)));
}
.fc .day {
  font-size: ${u(FC_DAY)};
  color: var(--secondary-text-color, #aab);
}
.fc .icon svg {
  display: block;
  width: ${u(FC_ICON)};
  height: ${u(FC_ICON)};
}
.fc .hi {
  font-size: ${u(FC_HI)};
  font-weight: 600;
}
.fc .lo {
  font-size: ${u(FC_LO)};
  color: var(--secondary-text-color, #aab);
}
.hit {
  position: absolute;
  left: 50%;
  top: ${u(9)};
  width: ${u(62)};
  height: ${u(29)};
  transform: translateX(-50%);
  border-radius: ${u(6)};
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.hit:active ~ .date,
.hit:active ~ .time {
  opacity: 0.6;
}
.face.mode-switches .fcast,
.face:not(.mode-switches) .sw {
  display: none;
}
.sw {
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.sw:active {
  opacity: 0.7;
}
.sw .icon {
  color: #7d8590;
}
.sw.on.d-light .icon {
  color: #ffc53d;
}
.sw.on.d-fan .icon {
  color: #6ec1ff;
}
.sw.on.d-switch .icon,
.sw.on.d-input_boolean .icon {
  color: #8de56a;
}
.sw .day {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: ${u(4.2)};
}
.sw.on .hi {
  color: var(--primary-text-color, #fff);
}
.sw.off .hi,
.sw.na .hi {
  color: var(--secondary-text-color, #aab);
}
.sw.na {
  opacity: 0.45;
}
.sw .lo {
  min-height: ${u(FC_LO * FC_LH)};
}
`;

class RoundWeatherClockCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = null;
    this._hass = null;
    this._stateObj = undefined;
    this._data = { daily: [], hourly: [] };
    this._hourlyPts = [];
    this._el = null;
    this._items = [];
    this._ring = null;
    this._arcHalf = 120; // half-extent of the ring arc in degrees; recomputed in _build()
    this._history = []; // today's recorded temperatures: [{ t: ms, v: number }]
    this._histAt = 0;
    this._histDay = null;
    this._histBusy = false;
    this._histToken = 0;
    this._mode = 'weather'; // 'weather' | 'switches'
    this._modeTimer = null;
    this._swItems = [];
    this._swStates = [];
    this._lastTap = [];
    this._clockTimer = null;
    this._subs = { daily: null, hourly: null };
  }

  // Accepts ["light.a", ...] or [{ entity, name }, ...]. Throws on anything unsafe or malformed
  // so mistakes show up in the editor instead of silently doing nothing (or something worse).
  static _parseSwitches(raw) {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > MAX_SWITCHES) {
      throw new Error(`round-weather-clock-card: "switches" must be a list of at most ${MAX_SWITCHES}`);
    }
    return raw.map((item) => {
      const entity = typeof item === 'string' ? item : item?.entity;
      if (typeof entity !== 'string' || !ENTITY_RE.test(entity)) {
        throw new Error('round-weather-clock-card: each switch needs an entity like light.lamp');
      }
      const domain = entity.split('.')[0];
      if (!SWITCH_DOMAINS.includes(domain)) {
        throw new Error(
          `round-weather-clock-card: switches may only be ${SWITCH_DOMAINS.join(', ')} entities`
        );
      }
      const name = typeof item === 'object' && typeof item.name === 'string' ? item.name.trim() : '';
      return { entity, name: name ? name.slice(0, 24) : null };
    });
  }

  static getConfigElement() {
    return document.createElement('round-weather-clock-card-editor');
  }

  static getStubConfig(hass) {
    const entity = Object.keys(hass?.states ?? {}).find((id) => id.startsWith('weather.'));
    return { entity: entity ?? 'weather.home' };
  }

  setConfig(config) {
    if (!config || typeof config.entity !== 'string' || !config.entity.startsWith('weather.')) {
      throw new Error('round-weather-clock-card: "entity" must be a weather.* entity');
    }
    const days = Number.isInteger(config.forecast_days) ? config.forecast_days : 4;
    const size =
      typeof config.size === 'string' && /^\d+(\.\d+)?(px|vmin|vw|vh)$/.test(config.size)
        ? config.size
        : '100vmin';
    if (
      config.temperature_entity !== undefined &&
      !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(config.temperature_entity)
    ) {
      throw new Error(
        'round-weather-clock-card: "temperature_entity" must look like sensor.outdoor_temperature'
      );
    }
    const switches = RoundWeatherClockCard._parseSwitches(config.switches);
    const timeout =
      config.switch_timeout === undefined ? DEFAULT_SWITCH_TIMEOUT : Number(config.switch_timeout);
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 600) {
      throw new Error('round-weather-clock-card: "switch_timeout" must be 0-600 seconds');
    }
    this._config = {
      entity: config.entity,
      forecast_days: Math.min(4, Math.max(2, days)),
      time_format: config.time_format === 24 ? 24 : 12,
      marker_label: config.marker_label === 'letter' ? 'letter' : 'temp',
      temperature_entity: config.temperature_entity ?? null,
      switches,
      switch_timeout: timeout,
      size,
    };

    this._unsubscribeAll();
    this._data = { daily: [], hourly: [] };
    this._hourlyPts = [];
    this._history = [];
    this._histAt = 0;
    this._histToken++; // discard any history request still in flight for the old config
    this._stateObj = undefined;
    this._build();
    this._renderClock();
    this._renderForecast();
    this._renderRing();
    if (this._hass) this._onHass();
  }

  set hass(hass) {
    this._hass = hass;
    this._onHass();
  }

  getCardSize() {
    return 8;
  }

  connectedCallback() {
    this._startClock();
    this._onHass();
  }

  disconnectedCallback() {
    this._stopClock();
    this._unsubscribeAll();
    this._setMode('weather'); // also clears the auto-return timer
  }

  // ---------- build ----------

  _build() {
    const root = this.shadowRoot;
    const { forecast_days: n, size } = this._config;
    this.style.setProperty('--size', size);

    // Static skeleton: contains no dynamic data.
    root.innerHTML = `<style>${CSS}</style>
      <div class="face">
        <svg class="ring" viewBox="-50 -50 100 100" aria-hidden="true"></svg>
        <div class="hit" role="button" tabindex="0" aria-label="Toggle switches"></div>
        <div class="date"></div>
        <div class="time"><span class="digits"></span><span class="period"></span></div>
        <div class="current">
          <div class="cur-icon"></div><div class="cur-temp"></div><div class="cur-cond"></div>
        </div>
      </div>`;

    const q = (sel) => root.querySelector(sel);
    this._el = {
      date: q('.date'),
      digits: q('.digits'),
      period: q('.period'),
      curIcon: q('.cur-icon'),
      curTemp: q('.cur-temp'),
      curCond: q('.cur-cond'),
      face: q('.face'),
      hit: q('.hit'),
    };

    // Forecast items on the lower arc.
    const face = q('.face');
    this._items = [];
    for (let i = 0; i < n; i++) {
      const item = document.createElement('div');
      item.className = 'fc fcast';
      placeOnArc(item, i, n);
      item.style.visibility = 'hidden';
      const day = document.createElement('div');
      day.className = 'day';
      const icon = document.createElement('div');
      icon.className = 'icon';
      const hi = document.createElement('div');
      hi.className = 'hi';
      const lo = document.createElement('div');
      lo.className = 'lo';
      item.append(day, icon, hi, lo);
      face.append(item);
      this._items.push({ item, day, icon, hi, lo });
    }

    // Switch buttons share the forecast items' footprint and arc positions. The CSS shows
    // one set or the other depending on the face's mode.
    this._swItems = [];
    this._swStates = [];
    this._lastTap = [];
    const swList = this._config.switches;
    swList.forEach((cfg, i) => {
      const domain = cfg.entity.split('.')[0];
      const item = document.createElement('div');
      item.className = `fc sw d-${domain} na`;
      item.setAttribute('role', 'switch');
      item.setAttribute('aria-checked', 'false');
      item.tabIndex = 0;
      placeOnArc(item, i, swList.length);
      const name = document.createElement('div');
      name.className = 'day';
      const icon = document.createElement('div');
      icon.className = 'icon';
      // Safe: static markup keyed by a whitelisted domain, never by entity data.
      icon.innerHTML = own(SW_ICONS, own(SW_ICON_KEY, domain)) ?? '';
      const stateText = document.createElement('div');
      stateText.className = 'hi';
      const kind = document.createElement('div');
      kind.className = 'lo';
      kind.textContent = own(SW_KIND, domain) ?? '';
      item.append(name, icon, stateText, kind);
      const activate = () => this._onSwitchTap(i);
      item.addEventListener('click', activate);
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      });
      face.append(item);
      this._swItems.push({ item, name, icon, state: stateText });
      // Render now, not only when hass changes: an entity that doesn't exist never produces
      // a state change, and would otherwise leave a blank button.
      this._renderSwitch(i);
    });

    // The clock / date area is the toggle between forecast and switches.
    const hit = this._el.hit;
    hit.style.display = swList.length ? '' : 'none'; // no switches configured: no dead tap zone
    hit.addEventListener('click', () => this._toggleMode());
    hit.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this._toggleMode();
      }
    });
    this._setMode('weather');

    // Where the arc stops: level with the top of the lowest forecast "high" numbers.
    // The lowest items are the ones whose arc angle is closest to straight down.
    const centerYs = this._items.map((_, i) =>
      ARC_RADIUS * Math.cos(((i - (n - 1) / 2) * ARC_STEP_DEG * Math.PI) / 180)
    );
    const itemH = FC_LH * (FC_DAY + FC_HI + FC_LO) + FC_ICON + 3 * FC_GAP;
    const hiTop =
      Math.max(...centerYs) - itemH / 2 + FC_LH * FC_DAY + FC_GAP + FC_ICON + FC_GAP + HI_GLYPH_INSET;
    // The round cap hangs RING_W/2 below the arc's end point, so stop that much earlier.
    const endY = hiTop - RING_W / 2;
    this._arcHalf = 180 - (Math.acos(Math.min(1, endY / RING_R)) * 180) / Math.PI;
    const segDeg = (2 * this._arcHalf) / SEGMENTS;

    // Temperature ring: segments, end caps, markers, then the current-time dot (top).
    const ringSvg = q('.ring');
    const segs = [];
    for (let k = 0; k < SEGMENTS; k++) {
      const a = -this._arcHalf + k * segDeg;
      const path = svgEl('path', {
        // 0.4deg overlap hides anti-aliasing seams; clamp so the last segment can't overshoot
        d: arcPath(a, Math.min(a + segDeg + 0.4, this._arcHalf), RING_R),
        fill: 'none',
        stroke: TRACK,
        'stroke-width': RING_W,
      });
      ringSvg.append(path);
      segs.push(path);
    }
    const cap = (deg) => {
      const [cx, cy] = polar(deg, RING_R);
      const c = svgEl('circle', {
        cx: cx.toFixed(3),
        cy: cy.toFixed(3),
        r: RING_W / 2,
        fill: TRACK,
      });
      ringSvg.append(c);
      return c;
    };
    const capStart = cap(-this._arcHalf);
    const capEnd = cap(this._arcHalf);
    const marker = (fill, textFill) => {
      const g = svgEl('g', { visibility: 'hidden' });
      g.append(
        svgEl('circle', {
          r: MARKER_R,
          fill,
          stroke: 'rgba(0,0,0,0.85)',
          'stroke-width': 0.9,
        })
      );
      const text = svgEl('text', {
        'text-anchor': 'middle',
        dy: '.35em',
        'font-weight': 700,
        fill: textFill,
      });
      g.append(text);
      ringSvg.append(g);
      return { g, text };
    };
    const hiMarker = marker('#F7F36B', '#1b1b1b');
    const loMarker = marker('#3B82F6', '#ffffff');
    const dot = svgEl('circle', {
      r: DOT_R,
      fill: '#ffffff',
      stroke: 'rgba(0,0,0,0.85)',
      'stroke-width': 0.9,
    });
    ringSvg.append(dot);
    this._ring = {
      segs,
      colors: segs.map(() => TRACK),
      capStart,
      capEnd,
      hi: hiMarker,
      lo: loMarker,
      dot,
    };
  }

  // ---------- data flow ----------

  _onHass() {
    if (!this._config || !this._hass) return;
    // hass is replaced on EVERY state change in HA. Only touch the DOM when
    // our own entity's state object actually changed.
    const s = this._hass.states[this._config.entity];
    if (s !== this._stateObj) {
      this._stateObj = s;
      this._renderCurrent();
    }
    // Switch states: only touch a button when its own entity's state object changed.
    this._config.switches.forEach((cfg, i) => {
      const st = this._hass.states[cfg.entity];
      if (st !== this._swStates[i]) {
        this._swStates[i] = st;
        this._renderSwitch(i);
      }
    });
    // The first render happens before hass exists, so it used the device's time zone.
    // Redraw the time-dependent parts as soon as HA's locale / time zone is known.
    const localeKey = `${this._hass.locale?.language}|${this._hass.config?.time_zone}`;
    if (localeKey !== this._localeKey) {
      this._localeKey = localeKey;
      this._renderClock();
      this._renderForecast();
      this._renderRing();
    }
    this._ensureSubscriptions();
    this._maybeFetchHistory();
  }

  _ensureSubscriptions() {
    if (!this.isConnected || !this._hass?.connection || !this._stateObj) return;
    const entity = this._config.entity;
    const features = this._stateObj.attributes?.supported_features;

    // WeatherEntityFeature bits: FORECAST_DAILY = 1, FORECAST_HOURLY = 2.
    for (const [kind, bit] of [
      ['daily', 1],
      ['hourly', 2],
    ]) {
      if (this._subs[kind]?.entity === entity) continue; // already subscribed (or in flight)
      if (typeof features === 'number' && !(features & bit)) continue; // unsupported
      this._unsubscribeKind(kind);
      const promise = this._hass.connection
        .subscribeMessage(
          (event) => {
            this._data[kind] = Array.isArray(event?.forecast) ? event.forecast : [];
            if (kind === 'hourly') {
              this._hourlyPts = this._parseHourly(this._data.hourly);
              this._renderRing();
            } else {
              this._renderForecast();
            }
          },
          { type: 'weather/subscribe_forecast', forecast_type: kind, entity_id: entity }
        )
        .catch((err) => {
          // Keep the entry so we don't retry on every state change.
          console.warn(`round-weather-clock-card: ${kind} forecast subscription failed`, err);
          return null;
        });
      this._subs[kind] = { entity, promise };
    }
  }

  _unsubscribeKind(kind) {
    const sub = this._subs[kind];
    this._subs[kind] = null;
    if (sub?.promise) {
      sub.promise
        .then((unsub) => {
          if (typeof unsub === 'function') unsub();
        })
        .catch(() => {});
    }
  }

  _unsubscribeAll() {
    this._unsubscribeKind('daily');
    this._unsubscribeKind('hourly');
  }

  _parseHourly(list) {
    return (Array.isArray(list) ? list : [])
      .map((f) => ({ t: Date.parse(f?.datetime), v: num(f?.temperature) }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
      .sort((a, b) => a.t - b.t);
  }

  // ---------- clock ----------

  _startClock() {
    this._stopClock();
    this._tick();
  }

  _stopClock() {
    clearTimeout(this._clockTimer);
    this._clockTimer = null;
  }

  _tick() {
    this._renderClock();
    this._renderForecast(); // "tomorrow" shifts at midnight
    this._renderRing(); // the dot moves along the arc
    this._maybeFetchHistory(); // cheap check: only fetches on a new day or every 15 minutes
    // Re-arm for the next minute boundary instead of polling every second.
    const delay = 60000 - (Date.now() % 60000) + 50;
    this._clockTimer = setTimeout(() => this._tick(), delay);
  }

  _fmt(options, lang) {
    const language = lang || this._hass?.locale?.language || navigator.language || 'en';
    const tz = this._hass?.config?.time_zone;
    try {
      return new Intl.DateTimeFormat(language, tz ? { ...options, timeZone: tz } : options);
    } catch (_) {
      return new Intl.DateTimeFormat(undefined, options);
    }
  }

  _ymd(date) {
    return this._fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }, 'en-CA').format(date);
  }

  // Hours since local midnight (0-24) in the HA time zone. Fixed 'en-US' so the
  // digits are always ASCII and parseable.
  _clockHours(date) {
    const parts = this._fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, 'en-US')
      .formatToParts(date);
    let h = 0;
    let m = 0;
    for (const p of parts) {
      if (p.type === 'hour') h = parseInt(p.value, 10) % 24;
      else if (p.type === 'minute') m = parseInt(p.value, 10);
    }
    return h + m / 60;
  }

  // ---------- render ----------

  _renderClock() {
    if (!this._el) return;
    const now = new Date();
    const is12 = this._config.time_format === 12;
    const parts = this._fmt({
      hour: is12 ? 'numeric' : '2-digit',
      minute: '2-digit',
      hourCycle: is12 ? 'h12' : 'h23',
    }).formatToParts(now);

    let digits = '';
    let period = '';
    for (const p of parts) {
      if (p.type === 'dayPeriod') period = p.value;
      else if (p.value.trim() !== '') digits += p.value;
    }
    this._el.digits.textContent = digits;
    this._el.period.textContent = period;
    this._el.date.textContent = this._fmt({
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(now);
  }

  _setIcon(target, condition) {
    const key = own(CONDITION_ICON, condition);
    // Safe: the value is always one of our own static strings.
    target.innerHTML = own(ICONS, key) ?? ICONS.cloud;
  }

  _renderCurrent() {
    if (!this._el) return;
    const s = this._stateObj;
    const ok = !!s && s.state !== 'unavailable' && s.state !== 'unknown';
    const temp = ok ? num(s.attributes?.temperature) : NaN;
    const unit = ok ? s.attributes?.temperature_unit ?? '' : '';

    this._el.curTemp.textContent = Number.isFinite(temp) ? `${Math.round(temp)}${unit}` : '–';
    this._setIcon(this._el.curIcon, ok ? s.state : undefined);
    this._el.curCond.textContent = ok ? own(CONDITION_TEXT, s.state) ?? s.state : 'Unavailable';
  }

  _renderForecast() {
    if (!this._items.length) return;
    const todayKey = this._ymd(new Date());
    const dayFmt = this._fmt({ weekday: 'short' });

    // Today lives on the ring now, so the arc starts tomorrow. YYYY-MM-DD strings sort correctly.
    const days = this._data.daily.filter((f) => {
      const d = new Date(f?.datetime);
      return !Number.isNaN(d.getTime()) && this._ymd(d) > todayKey;
    });

    this._items.forEach((slot, i) => {
      const f = days[i];
      if (!f) {
        slot.item.style.visibility = 'hidden';
        return;
      }
      const hi = num(f.temperature);
      const lo = num(f.templow);
      slot.day.textContent = dayFmt.format(new Date(f.datetime));
      this._setIcon(slot.icon, f.condition);
      slot.hi.textContent = Number.isFinite(hi) ? `${Math.round(hi)}°` : '–';
      slot.lo.textContent = Number.isFinite(lo) ? `${Math.round(lo)}°` : '';
      slot.item.style.visibility = 'visible';
    });
  }

  // ---------- forecast <-> switches ----------

  _setMode(mode) {
    this._mode = mode;
    clearTimeout(this._modeTimer);
    this._modeTimer = null;
    this._el?.face?.classList.toggle('mode-switches', mode === 'switches');
    if (mode === 'switches') this._armModeTimer();
  }

  _toggleMode() {
    if (!this._config.switches.length) return;
    this._setMode(this._mode === 'switches' ? 'weather' : 'switches');
  }

  // A wall display must not stay parked on the switch page forever: fall back to the
  // forecast after a quiet period. Every tap on a switch restarts the countdown.
  _armModeTimer() {
    clearTimeout(this._modeTimer);
    this._modeTimer = null;
    const seconds = this._config.switch_timeout;
    if (seconds > 0) this._modeTimer = setTimeout(() => this._setMode('weather'), seconds * 1000);
  }

  _renderSwitch(i) {
    const sw = this._swItems[i];
    if (!sw) return;
    const cfg = this._config.switches[i];
    const st = this._swStates[i];
    const state = st?.state;
    sw.name.textContent = cfg.name ?? st?.attributes?.friendly_name ?? cfg.entity;
    sw.item.classList.toggle('on', state === 'on');
    sw.item.classList.toggle('off', state === 'off');
    sw.item.classList.toggle('na', state !== 'on' && state !== 'off');
    sw.item.setAttribute('aria-checked', String(state === 'on'));
    sw.state.textContent = state === 'on' ? 'On' : state === 'off' ? 'Off' : 'N/A';
  }

  _onSwitchTap(i) {
    this._armModeTimer();
    const now = Date.now();
    if (now - (this._lastTap[i] ?? 0) < 400) return; // ignore bounces / double taps
    this._lastTap[i] = now;

    const cfg = this._config.switches[i];
    const state = this._swStates[i]?.state;
    if (!cfg || (state !== 'on' && state !== 'off')) return; // unavailable: do nothing
    const domain = cfg.entity.split('.')[0];
    if (!SWITCH_DOMAINS.includes(domain) || typeof this._hass?.callService !== 'function') return;
    // Explicit turn_on / turn_off, not toggle: repeating the same command is harmless,
    // whereas a toggle sent from a stale view would do the opposite of what was shown.
    Promise.resolve(
      this._hass.callService(domain, state === 'on' ? 'turn_off' : 'turn_on', {
        entity_id: cfg.entity,
      })
    ).catch((err) => console.warn(`round-weather-clock-card: could not switch ${cfg.entity}`, err));
  }

  // ---------- today's observed temperatures ----------

  async _maybeFetchHistory() {
    if (!this.isConnected || !this._config || typeof this._hass?.callWS !== 'function') return;
    if (this._histBusy) return;
    const nowMs = Date.now();
    const day = this._ymd(new Date(nowMs));
    if (this._histDay === day && nowMs - this._histAt < HISTORY_REFRESH_MS) return;

    const entity = this._config.temperature_entity ?? this._config.entity;
    const useAttr = !this._config.temperature_entity; // weather entity: read the attribute
    const startMs = nowMs - this._clockHours(new Date(nowMs)) * 3600000;
    const token = ++this._histToken;
    this._histBusy = true;
    this._histAt = nowMs; // throttles retries as well, success or failure
    this._histDay = day;
    try {
      const res = await this._hass.callWS({
        type: 'history/history_during_period',
        start_time: new Date(startMs - 2 * 3600000).toISOString(),
        end_time: new Date(nowMs).toISOString(),
        entity_ids: [entity],
        include_start_time_state: true,
        significant_changes_only: false, // attribute-only changes must be kept
        minimal_response: false,
        no_attributes: !useAttr,
      });
      if (token === this._histToken) {
        this._history = this._parseHistory(res, entity, useAttr);
        this._renderRing();
      }
    } catch (err) {
      console.warn("round-weather-clock-card: could not read today's temperature history", err);
    } finally {
      this._histBusy = false;
    }
  }

  _parseHistory(res, entity, useAttr) {
    const rows = res?.[entity];
    if (!Array.isArray(rows)) return [];
    const out = [];
    let carried = NaN;
    for (const row of rows) {
      // Compressed rows: s / a / lu / lc (lu is omitted when it equals lc), times in
      // seconds. Full rows: state / attributes / last_updated. Accept both.
      const secs = row?.lu ?? row?.lc;
      const t =
        typeof secs === 'number' ? secs * 1000 : Date.parse(row?.last_updated ?? row?.last_changed);
      let v;
      if (useAttr) {
        const attrs = row?.a ?? row?.attributes;
        if (attrs && Object.prototype.hasOwnProperty.call(attrs, 'temperature')) {
          carried = num(attrs.temperature);
        }
        v = carried; // a row without attributes means "unchanged since the previous row"
      } else {
        v = num(row?.s ?? row?.state);
      }
      if (Number.isFinite(t) && Number.isFinite(v)) out.push({ t, v });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  // Observed points so far today + the live reading + the hourly forecast from now on.
  _ringPoints(nowMs, startMs) {
    const out = this._history.filter((p) => p.t >= startMs - 2 * 3600000 && p.t <= nowMs);
    const cfg = this._config;
    const live = num(
      cfg.temperature_entity
        ? this._hass?.states?.[cfg.temperature_entity]?.state
        : this._stateObj?.attributes?.temperature
    );
    if (Number.isFinite(live)) out.push({ t: nowMs, v: live });
    for (const p of this._hourlyPts) if (p.t > nowMs) out.push(p);
    return out.sort((a, b) => a.t - b.t);
  }

  _interp(pts, t) {
    if (t < pts[0].t || t > pts[pts.length - 1].t) return null;
    let i = 1;
    while (i < pts.length && pts[i].t < t) i++;
    const a = pts[i - 1];
    const b = pts[i] ?? a;
    if (b.t - a.t > MAX_GAP_MS) return null;
    const span = b.t - a.t;
    return span > 0 ? a.v + (b.v - a.v) * ((t - a.t) / span) : a.v;
  }

  // 0h -> lower-left end of the arc, 12h -> top, 24h -> lower-right end.
  _hoursToDeg(h) {
    return -this._arcHalf + (h / 24) * 2 * this._arcHalf;
  }

  _placeMarker(m, pt, label) {
    const deg = this._hoursToDeg(this._clockHours(new Date(pt.t)));
    const [x, y] = polar(deg, RING_R);
    m.g.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
    m.text.textContent = label;
    m.text.setAttribute('font-size', label.length > 3 ? 2.7 : label.length > 1 ? 3.3 : 4.2);
    m.g.setAttribute('visibility', 'visible');
  }

  _renderRing() {
    if (!this._ring) return;
    const r = this._ring;
    const now = new Date();
    const nowMs = now.getTime();
    const nowH = this._clockHours(now);

    // Current-time dot.
    const [dx, dy] = polar(this._hoursToDeg(nowH), RING_R);
    r.dot.setAttribute('cx', dx.toFixed(2));
    r.dot.setAttribute('cy', dy.toFixed(2));

    // Today, local midnight to midnight (an hour off on the two daylight-saving days a year).
    const startMs = nowMs - nowH * 3600000;
    const endMs = startMs + 24 * 3600000;
    const pts = this._ringPoints(nowMs, startMs);
    if (pts.length < 2) {
      r.colors.forEach((c, k) => {
        if (c !== TRACK) {
          r.segs[k].setAttribute('stroke', TRACK);
          r.colors[k] = TRACK;
        }
      });
      r.capStart.setAttribute('fill', TRACK);
      r.capEnd.setAttribute('fill', TRACK);
      r.hi.g.setAttribute('visibility', 'hidden');
      r.lo.g.setAttribute('visibility', 'hidden');
      return;
    }

    // Each ring slot shows the temperature at that time of day: recorded before now,
    // forecast after. Slots with no data stay dim.
    const temps = [];
    for (let k = 0; k < SEGMENTS; k++) {
      const slotH = ((k + 0.5) * 24) / SEGMENTS;
      temps.push(this._interp(pts, startMs + slotH * 3600000));
    }
    const known = temps.filter((v) => v !== null);
    const lo = known.length ? Math.min(...known) : 0;
    const hi = known.length ? Math.max(...known) : 0;
    const span = hi - lo;
    temps.forEach((v, k) => {
      const color = v === null ? TRACK : rampColor(span > 0 ? (v - lo) / span : 0.5);
      if (color !== r.colors[k]) {
        r.segs[k].setAttribute('stroke', color);
        r.colors[k] = color;
      }
    });
    r.capStart.setAttribute('fill', r.colors[0]);
    r.capEnd.setAttribute('fill', r.colors[SEGMENTS - 1]);

    // Today's high / low, at the time each occurs (or is forecast to).
    const win = pts.filter((p) => p.t >= startMs && p.t <= endMs);
    if (win.length >= 2) {
      const hiPt = win.reduce((a, b) => (b.v > a.v ? b : a));
      const loPt = win.reduce((a, b) => (b.v < a.v ? b : a));
      if (hiPt.v - loPt.v >= 1) {
        const letters = this._config.marker_label === 'letter';
        this._placeMarker(r.hi, hiPt, letters ? 'H' : `${Math.round(hiPt.v)}°`);
        this._placeMarker(r.lo, loPt, letters ? 'L' : `${Math.round(loPt.v)}°`);
        return;
      }
    }
    r.hi.g.setAttribute('visibility', 'hidden');
    r.lo.g.setAttribute('visibility', 'hidden');
  }
}

// ---------------------------------------------------------------------------
// Visual editor. Uses Home Assistant's own <ha-form> with entity selectors.
// The form is flat (switch_1_entity, switch_1_name, ...) because that is what
// ha-form edits well; toForm/fromForm convert to and from the clean nested YAML.
// ---------------------------------------------------------------------------
const EDITOR_SCHEMA = [
  { name: 'entity', required: true, selector: { entity: { domain: 'weather' } } },
  { name: 'temperature_entity', selector: { entity: { domain: 'sensor' } } },
  {
    type: 'grid',
    name: '',
    schema: [
      { name: 'forecast_days', selector: { number: { min: 2, max: 4, step: 1, mode: 'box' } } },
      {
        name: 'time_format',
        selector: {
          select: {
            mode: 'dropdown',
            options: [
              { value: '12', label: '12-hour' },
              { value: '24', label: '24-hour' },
            ],
          },
        },
      },
      {
        name: 'marker_label',
        selector: {
          select: {
            mode: 'dropdown',
            options: [
              { value: 'temp', label: 'Temperature' },
              { value: 'letter', label: 'Letters (H / L)' },
            ],
          },
        },
      },
      {
        name: 'switch_timeout',
        selector: { number: { min: 0, max: 600, step: 1, unit_of_measurement: 's', mode: 'box' } },
      },
    ],
  },
  { name: 'size', selector: { text: {} } },
  ...Array.from({ length: MAX_SWITCHES }, (_, k) => ({
    type: 'grid',
    name: '',
    schema: [
      { name: `switch_${k + 1}_entity`, selector: { entity: { domain: SWITCH_DOMAINS } } },
      { name: `switch_${k + 1}_name`, selector: { text: {} } },
    ],
  })),
];

const EDITOR_LABELS = {
  entity: 'Weather entity',
  temperature_entity: 'Outdoor temperature sensor (optional)',
  forecast_days: 'Forecast days (2-4)',
  time_format: 'Clock format',
  marker_label: 'High / low marker',
  switch_timeout: 'Return to forecast after (0 = stay)',
  size: 'Size override, e.g. 320px (blank = fill the screen)',
};
const EDITOR_HELP = {
  temperature_entity: 'Used for the ring\'s history so far today. Better than the weather entity\'s own readings.',
  size: 'Set this while editing: the preview otherwise tries to fill your whole browser window.',
};
for (let i = 1; i <= MAX_SWITCHES; i++) {
  EDITOR_LABELS[`switch_${i}_entity`] = `Switch ${i} (light, fan, switch)`;
  EDITOR_LABELS[`switch_${i}_name`] = `Switch ${i} label (short)`;
}

const numOrUndef = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? undefined : Number(v));

const toForm = (c) => {
  const f = {
    entity: c.entity ?? '',
    temperature_entity: c.temperature_entity ?? '',
    forecast_days: c.forecast_days ?? 4,
    time_format: String(c.time_format ?? 12),
    marker_label: c.marker_label ?? 'temp',
    switch_timeout: c.switch_timeout ?? DEFAULT_SWITCH_TIMEOUT,
    size: c.size ?? '',
  };
  const list = Array.isArray(c.switches) ? c.switches : [];
  for (let i = 0; i < MAX_SWITCHES; i++) {
    const it = list[i];
    f[`switch_${i + 1}_entity`] = (typeof it === 'string' ? it : it?.entity) ?? '';
    f[`switch_${i + 1}_name`] = (it && typeof it === 'object' ? it.name : '') ?? '';
  }
  return f;
};

const fromForm = (d, base) => {
  const out = { ...base }; // keeps `type` and any keys the form doesn't know about
  const put = (key, value) => {
    if (value === undefined || value === null || value === '') delete out[key];
    else out[key] = value;
  };
  put('entity', d.entity);
  put('temperature_entity', d.temperature_entity);
  const days = numOrUndef(d.forecast_days);
  put('forecast_days', days === undefined ? undefined : Math.round(days));
  put('time_format', d.time_format === '24' ? 24 : 12);
  put('marker_label', d.marker_label === 'letter' ? 'letter' : 'temp');
  put('switch_timeout', numOrUndef(d.switch_timeout));
  put('size', typeof d.size === 'string' ? d.size.trim() : undefined);
  const switches = [];
  for (let i = 1; i <= MAX_SWITCHES; i++) {
    const entity = d[`switch_${i}_entity`];
    const label = typeof d[`switch_${i}_name`] === 'string' ? d[`switch_${i}_name`].trim() : '';
    if (entity) switches.push(label ? { entity, name: label } : { entity });
  }
  if (switches.length) out.switches = switches;
  else delete out.switches;
  return out;
};

class RoundWeatherClockCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  _render() {
    if (!this._form) {
      if (!customElements.get('ha-form')) {
        this.textContent = "The visual editor needs Home Assistant's ha-form component. Use the YAML editor instead.";
        return;
      }
      this._form = document.createElement('ha-form');
      this._form.schema = EDITOR_SCHEMA;
      this._form.computeLabel = (schema) => EDITOR_LABELS[schema.name] ?? schema.name;
      this._form.computeHelper = (schema) => EDITOR_HELP[schema.name] ?? '';
      this._form.addEventListener('value-changed', (ev) => {
        ev.stopPropagation();
        this._config = fromForm(ev.detail.value, this._config);
        this.dispatchEvent(
          new CustomEvent('config-changed', {
            detail: { config: this._config },
            bubbles: true,
            composed: true,
          })
        );
      });
      this.append(this._form);
    }
    this._form.hass = this._hass;
    this._form.data = toForm(this._config);
  }
}

if (!customElements.get('round-weather-clock-card-editor')) {
  customElements.define('round-weather-clock-card-editor', RoundWeatherClockCardEditor);
}

if (!customElements.get('round-weather-clock-card')) {
  customElements.define('round-weather-clock-card', RoundWeatherClockCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'round-weather-clock-card',
  name: 'Round Weather Clock',
  description: 'Clock, forecast, today\'s temperature ring and tap-to-reveal switches for round displays.',
});
