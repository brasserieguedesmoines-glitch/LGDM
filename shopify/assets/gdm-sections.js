/* ==========================================================================
   Le Gué des Moines — sections personnalisées
   Comportements partagés, sous forme de « custom elements » : ils se
   ré-initialisent tout seuls quand l'éditeur de thème recharge une section.
   Ce fichier peut être inclus plusieurs fois sur une page sans effet de bord.
   ========================================================================== */
(() => {
  const TZ = 'Europe/Paris';
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const inEditor = () => Boolean(window.Shopify && window.Shopify.designMode);
  const define = (name, ctor) => {
    if (!customElements.get(name)) customElements.define(name, ctor);
  };

  /* Date/heure actuelle à Bruguières, quel que soit le fuseau du visiteur. */
  const parisNow = () => {
    const parts = {};
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(new Date())
      .forEach((p) => (parts[p.type] = p.value));
    const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday) + 1;
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      weekday,
      minutes: Number(parts.hour) * 60 + Number(parts.minute)
    };
  };

  /* Convertit une date/heure « murale » de Paris en timestamp UTC. */
  const parisToEpoch = (y, m, d, h = 0, min = 0) => {
    const guess = Date.UTC(y, m - 1, d, h, min);
    const offsetAt = (ts) => {
      const p = {};
      new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      })
        .formatToParts(new Date(ts))
        .forEach((x) => (p[x.type] = x.value));
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - ts;
    };
    let ts = guess - offsetAt(guess);
    ts = guess - offsetAt(ts);
    return ts;
  };

  const parseTime = (value) => {
    const match = String(value || '').match(/(\d{1,2})\s*[:hH.]?\s*(\d{2})?/);
    if (!match) return null;
    return Math.min(23, Number(match[1])) * 60 + Math.min(59, Number(match[2] || 0));
  };

  const formatTime = (minutes) => {
    const h = Math.floor(minutes / 60) % 24;
    const m = minutes % 60;
    if (h === 0 && m === 0) return 'minuit';
    return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
  };

  /* ---------- <gdm-section> : apparition douce des éléments au défilement ---------- */
  class GdmSection extends HTMLElement {
    connectedCallback() {
      const items = this.querySelectorAll('[data-gdm-reveal]');
      if (!items.length || reduceMotion() || inEditor() || !('IntersectionObserver' in window)) return;

      // Le premier signal de l'observer dit ce qui est déjà à l'écran : on n'y touche
      // pas (aucun clignotement). Seuls les éléments encore hors champ sont masqués,
      // puis révélés quand le visiteur les atteint.
      const seen = new WeakSet();
      this.observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          const el = entry.target;
          if (!seen.has(el)) {
            seen.add(el);
            if (entry.isIntersecting) this.observer.unobserve(el);
            else el.classList.add('is-pending');
            return;
          }
          if (!entry.isIntersecting) return;
          el.classList.remove('is-pending');
          el.classList.add('is-in');
          this.observer.unobserve(el);
        });
      });
      items.forEach((el) => this.observer.observe(el));
    }

    disconnectedCallback() {
      if (this.observer) this.observer.disconnect();
    }
  }

  /* ---------- <gdm-carousel> : flèches + barre de progression sur un défilement natif ---------- */
  class GdmCarousel extends HTMLElement {
    connectedCallback() {
      this.track = this.querySelector('[data-track]');
      if (!this.track) return;
      this.prev = this.querySelector('[data-prev]');
      this.next = this.querySelector('[data-next]');
      this.bar = this.querySelector('[data-progress]');

      this.onScroll = () => {
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => {
          this.frame = null;
          this.update();
        });
      };
      this.onPrev = () => this.go(-1);
      this.onNext = () => this.go(1);
      // Au clavier : une carte hors champ qui reçoit le focus est ramenée dans le carrousel.
      this.onFocusIn = (event) => {
        const slide = [...this.track.children].find((child) => child.contains(event.target));
        if (!slide) return;
        const box = this.track.getBoundingClientRect();
        const rect = slide.getBoundingClientRect();
        if (rect.left < box.left - 1 || rect.right > box.right + 1) {
          this.track.scrollTo({ left: this.track.scrollLeft + rect.left - box.left, behavior: 'auto' });
        }
      };
      this.trackFocusable = this.track.hasAttribute('tabindex');

      this.track.addEventListener('scroll', this.onScroll, { passive: true });
      this.track.addEventListener('focusin', this.onFocusIn);
      if (this.prev) this.prev.addEventListener('click', this.onPrev);
      if (this.next) this.next.addEventListener('click', this.onNext);
      if ('ResizeObserver' in window) {
        this.resizeObserver = new ResizeObserver(() => this.update());
        this.resizeObserver.observe(this.track);
      }
      this.update();
    }

    disconnectedCallback() {
      if (!this.track) return;
      this.track.removeEventListener('scroll', this.onScroll);
      this.track.removeEventListener('focusin', this.onFocusIn);
      if (this.prev) this.prev.removeEventListener('click', this.onPrev);
      if (this.next) this.next.removeEventListener('click', this.onNext);
      if (this.resizeObserver) this.resizeObserver.disconnect();
    }

    go(direction) {
      const first = this.track.firstElementChild;
      if (!first) return;
      const gap = parseFloat(getComputedStyle(this.track).columnGap) || 0;
      const step = first.getBoundingClientRect().width + gap;
      const perView = Math.max(1, Math.floor((this.track.clientWidth + gap) / step));
      this.track.scrollBy({ left: direction * step * perView, behavior: reduceMotion() ? 'auto' : 'smooth' });
    }

    update() {
      const { scrollLeft, scrollWidth, clientWidth } = this.track;
      const max = scrollWidth - clientWidth;
      const isStatic = max <= 2;
      this.toggleAttribute('data-static', isStatic);
      // Un carrousel sans rien à faire défiler n'est pas une étape de tabulation.
      if (this.trackFocusable) {
        if (isStatic) this.track.removeAttribute('tabindex');
        else this.track.setAttribute('tabindex', '0');
      }
      const atStart = scrollLeft <= 2;
      const atEnd = scrollLeft >= max - 2;
      // Le focus ne doit pas rester sur une flèche qui devient désactivée.
      const active = document.activeElement;
      if (atEnd && this.next && active === this.next) (this.prev && !atStart ? this.prev : this.track).focus({ preventScroll: true });
      if (atStart && this.prev && active === this.prev) (this.next && !atEnd ? this.next : this.track).focus({ preventScroll: true });
      if (this.prev) this.prev.disabled = atStart;
      if (this.next) this.next.disabled = atEnd;
      if (this.bar && scrollWidth) {
        this.bar.style.setProperty('--gdm-w', (clientWidth / scrollWidth).toFixed(4));
        this.bar.style.setProperty('--gdm-x', (Math.max(0, scrollLeft) / scrollWidth).toFixed(4));
      }
    }
  }

  /* ---------- <gdm-counter> : chiffre qui s'incrémente quand il apparaît ---------- */
  class GdmCounter extends HTMLElement {
    connectedCallback() {
      const raw = String(this.dataset.value || '').replace(/\s/g, '').replace(',', '.');
      const target = parseFloat(raw);
      if (!Number.isFinite(target) || reduceMotion() || inEditor() || !('IntersectionObserver' in window)) return;

      const decimals = (raw.split('.')[1] || '').length;
      const format = (n) =>
        n.toLocaleString('fr-FR', {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
          useGrouping: target >= 10000
        });
      const finalText = this.textContent;
      let first = true;

      this.observer = new IntersectionObserver((entries) => {
        const visible = entries[entries.length - 1].isIntersecting;
        if (first) {
          first = false;
          // Déjà à l'écran au chargement : on garde le chiffre final, sans animation.
          if (visible) return this.observer.disconnect();
          this.textContent = format(0);
          return;
        }
        if (!visible) return;
        this.observer.disconnect();
        const duration = 1600;
        const start = performance.now();
        const tick = (now) => {
          const t = Math.min(1, (now - start) / duration);
          const eased = 1 - Math.pow(1 - t, 3);
          this.textContent = t < 1 ? format(target * eased) : finalText;
          if (t < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      this.observer.observe(this);
    }

    disconnectedCallback() {
      if (this.observer) this.observer.disconnect();
    }
  }

  /* ---------- <gdm-countdown> : compte à rebours vers une date (heure de Paris) ---------- */
  class GdmCountdown extends HTMLElement {
    connectedCallback() {
      const [y, m, d] = String(this.dataset.date || '').split('-').map(Number);
      if (!y || !m || !d) return;
      const time = parseTime(this.dataset.time) || 0;
      this.end = parisToEpoch(y, m, d, Math.floor(time / 60), time % 60);
      this.units = {
        days: this.querySelector('[data-unit="days"]'),
        hours: this.querySelector('[data-unit="hours"]'),
        minutes: this.querySelector('[data-unit="minutes"]'),
        seconds: this.querySelector('[data-unit="seconds"]')
      };
      this.tick();
      this.timer = setInterval(() => this.tick(), 1000);
    }

    disconnectedCallback() {
      clearInterval(this.timer);
    }

    tick() {
      const left = Math.max(0, this.end - Date.now());
      const s = Math.floor(left / 1000);
      const values = {
        days: Math.floor(s / 86400),
        hours: Math.floor((s % 86400) / 3600),
        minutes: Math.floor((s % 3600) / 60),
        seconds: s % 60
      };
      Object.entries(values).forEach(([unit, value]) => {
        const el = this.units[unit];
        if (el) el.textContent = String(value).padStart(2, '0');
      });
      if (left === 0) {
        clearInterval(this.timer);
        this.setAttribute('data-ended', '');
      }
    }
  }

  /* ---------- <gdm-hours> : jour en cours surligné + statut « ouvert / fermé » ---------- */
  class GdmHours extends HTMLElement {
    connectedCallback() {
      const json = this.querySelector('script[type="application/json"]');
      if (!json) return;
      try {
        this.days = JSON.parse(json.textContent);
      } catch (e) {
        return;
      }
      this.render();
      this.timer = setInterval(() => this.render(), 60000);
    }

    disconnectedCallback() {
      clearInterval(this.timer);
    }

    render() {
      const now = parisNow();
      const WEEK = 7 * 1440;
      const nowAbs = (now.weekday - 1) * 1440 + now.minutes;
      const names = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

      this.querySelectorAll('[data-day]').forEach((row) => {
        row.classList.toggle('is-today', Number(row.dataset.day) === now.weekday);
      });

      const slots = [];
      this.days.forEach((day) => {
        if (day.closed) return;
        const open = parseTime(day.open);
        let close = parseTime(day.close);
        if (open === null || close === null) return;
        if (close <= open) close += 1440;
        const start = (day.day - 1) * 1440 + open;
        slots.push({ day: day.day, start, end: start + (close - open), open, close });
      });

      const status = this.querySelector('[data-status]');
      const label = this.querySelector('[data-status-label]');
      if (!status || !label) return;
      if (!slots.length) {
        status.hidden = true;
        return;
      }

      const current = slots.find(
        (slot) => (nowAbs >= slot.start && nowAbs < slot.end) || (nowAbs + WEEK >= slot.start && nowAbs + WEEK < slot.end)
      );

      status.hidden = false;
      if (current) {
        status.dataset.state = 'open';
        label.textContent = `${this.dataset.openLabel || 'Ouvert'} · ${this.dataset.closesLabel || 'ferme à'} ${formatTime(current.close % 1440)}`;
        return;
      }

      const { slot: next, wait } = slots
        .map((slot) => ({ slot, wait: (slot.start - nowAbs + WEEK) % WEEK }))
        .sort((a, b) => a.wait - b.wait)[0];
      const dayDiff = (next.day - now.weekday + 7) % 7;
      let when = names[next.day - 1];
      if (dayDiff === 0 && wait < 1440) when = this.dataset.todayLabel || "aujourd'hui";
      else if (dayDiff === 1) when = this.dataset.tomorrowLabel || 'demain';
      status.dataset.state = 'closed';
      label.textContent = `${this.dataset.closedLabel || 'Fermé'} · ${this.dataset.opensLabel || 'ouvre'} ${when} ${this.dataset.atLabel || 'à'} ${formatTime(next.open)}`;
    }
  }

  /* ---------- <gdm-map> : la carte Google ne se charge qu'au clic (RGPD + vitesse) ---------- */
  class GdmMap extends HTMLElement {
    connectedCallback() {
      this.button = this.querySelector('[data-load-map]');
      if (!this.button) return;
      this.onClick = () => this.load();
      this.button.addEventListener('click', this.onClick);
    }

    disconnectedCallback() {
      if (this.button) this.button.removeEventListener('click', this.onClick);
    }

    load() {
      const query = this.dataset.query;
      if (!query) return;
      const hadFocus = this.contains(document.activeElement);
      const iframe = document.createElement('iframe');
      iframe.src = `https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed`;
      iframe.title = this.dataset.title || 'Carte';
      iframe.loading = 'lazy';
      iframe.referrerPolicy = 'no-referrer-when-downgrade';
      iframe.setAttribute('allowfullscreen', '');
      iframe.className = 'gdm-map__frame';
      this.appendChild(iframe);
      this.setAttribute('data-loaded', '');
      if (hadFocus) iframe.focus();
    }
  }

  /* ---------- <gdm-variant-pills> : 33 cL / 75 cL → met à jour le prix affiché ---------- */
  class GdmVariantPills extends HTMLElement {
    connectedCallback() {
      this.onChange = (event) => {
        const input = event.target.closest('input[type="radio"]');
        if (!input) return;
        const card = this.closest('[data-product-card]');
        if (!card) return;
        const price = card.querySelector('[data-price]');
        const compare = card.querySelector('[data-compare-price]');
        if (price && input.dataset.variantPrice) price.textContent = input.dataset.variantPrice;
        if (compare) {
          compare.textContent = input.dataset.variantCompare || '';
          compare.hidden = !input.dataset.variantCompare;
        }
        const submit = card.querySelector('[data-add-to-cart]');
        if (submit) {
          const available = input.dataset.variantAvailable === 'true';
          submit.disabled = !available;
          const text = submit.querySelector('[data-add-label]');
          if (text) text.textContent = available ? submit.dataset.labelAdd : submit.dataset.labelSoldout;
        }
      };
      this.addEventListener('change', this.onChange);
    }

    disconnectedCallback() {
      this.removeEventListener('change', this.onChange);
    }
  }

  /* ---------- <gdm-events> : masque les événements passés (heure de Paris) ---------- */
  class GdmEvents extends HTMLElement {
    connectedCallback() {
      const today = parisNow().date;
      let visible = 0;
      this.querySelectorAll('[data-event-date]').forEach((el) => {
        const past = el.dataset.eventDate && el.dataset.eventDate < today;
        if (past && !inEditor()) el.hidden = true;
        else visible += 1;
      });
      const empty = this.querySelector('[data-events-empty]');
      if (empty) empty.hidden = visible > 0;
    }
  }

  define('gdm-section', GdmSection);
  define('gdm-carousel', GdmCarousel);
  define('gdm-counter', GdmCounter);
  define('gdm-countdown', GdmCountdown);
  define('gdm-hours', GdmHours);
  define('gdm-map', GdmMap);
  define('gdm-variant-pills', GdmVariantPills);
  define('gdm-events', GdmEvents);
})();
