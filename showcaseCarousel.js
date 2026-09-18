/**
 * Showcase Carousel Plugin for Squarespace
 * Transforms list sections into a full bleed carousel with an enlarged center
 * slide, drag support, arrows and a progress bar
 * Copyright Will-Myers.com
 **/

class WMShowcaseCarousel {
  static pluginName = 'showcase-carousel';

  static emitEvent(type, detail = {}, elem = document) {
    elem.dispatchEvent(new CustomEvent(`wm-${this.pluginName}${type}`, { detail, bubbles: true }));
  }

  // Horizontal travel (px) needed before a drag counts as a slide change.
  static dragThreshold = 30;

  // Travel (px) before a pointer gesture is locked to horizontal or vertical.
  static dragLockThreshold = 6;

  // How much of a drag past the first/last slide is honored when loop is off.
  static dragEdgeResistance = 0.35;

  // Aspect ratio used when the browser cannot resolve the ratio probe.
  static fallbackAspectRatio = 0.5625;

  constructor(el, settings = {}) {
    this.el = el;
    this.settings = {
      draggable: true, // drag/swipe to move between slides
      clickToCenter: true, // clicking a side slide brings it to the center
      showProgress: true, // progress bar below the carousel
      autoplay: false, // advance on a timer
      autoplaySpeed: 5000, // ms between automatic advances
      pauseOnHover: true, // pause autoplay while hovered or focused
      startIndex: 0, // slide centered on load
      fullBleed: true, // stretch the carousel to the full window width
      imageWidth: 1500, // Squarespace ?format= width requested for each image
      ...settings
    };
    this.data = null;
    this.loop = true; // set from the section's Infinite Scroll setting
    this.showArrows = true; // set from the section's Navigation setting
    this.sectionTitle = null;
    this.sectionButton = null;
    this.isSectionTitleEnabled = true;
    this.isSectionButtonEnabled = false;
    this.options = null;
    this.styles = null;
    this.originalContainer = null;
    this.pluginName = this.constructor.pluginName;
    this.isBackend = window.top !== window.self;
    this.carousel = null;
    this.track = null;
    this.metricsEl = null;
    this.progressBar = null;
    this.prevButton = null;
    this.nextButton = null;
    this.slides = [];
    this.centerIndex = 0;
    this.positions = {};
    this.lastWidth = 0;
    this.isDragging = false;
    this.isDragLocked = false;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.dragDeltaX = 0;
    this.suppressClick = false;
    this.skipProgressTransition = false;
    this.autoplayTimer = null;
    this.isAutoplayPaused = false;
    this.isVisible = true;
    this.prefersReducedMotion = window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;
    this.resizeObserver = null;
    this.intersectionObserver = null;
    this.boundHandleResize = null;
    this.boundHandlePointerDown = null;
    this.boundHandlePointerMove = null;
    this.boundHandlePointerUp = null;
    this.boundHandlePointerCancel = null;
    this.boundHandleKeydown = null;
    this.boundHandleClickCapture = null;
    this.boundPauseAutoplay = null;
    this.boundResumeAutoplay = null;
    this.resizeTimeout = null;
    this.init();
  }

  init() {
    WMShowcaseCarousel.emitEvent(':beforeInit', { el: this.el }, this.el);
    this.addDataAttribute();
    this.extractData();
    if (!this.data || this.data.length === 0) return;
    this.applySectionDerivedSettings();
    this.removeOrHideOriginalListSectionContent();
    this.buildLayout();
    this.bindEvents();
    this.layout();
    WMShowcaseCarousel.emitEvent(':afterInit', { el: this.el }, this.el);
  }

  addDataAttribute() {
    this.el.setAttribute('data-wm-plugin', this.pluginName);
  }

  extractData() {
    const container = this.el.querySelector('.user-items-list-item-container');
    if (!container || !container.dataset.currentContext) {
      console.error(`[${this.pluginName}] No data-current-context found`);
      return;
    }

    let contextData;
    try {
      contextData = JSON.parse(container.dataset.currentContext);
    } catch (error) {
      console.error(`[${this.pluginName}] Failed to parse data-current-context`, error);
      return;
    }

    this.originalContainer = container;
    this.data = contextData.userItems || [];
    this.options = contextData.options || {};
    this.styles = contextData.styles || {};
    this.sectionTitle = contextData.sectionTitle || null;
    this.sectionButton = contextData.sectionButton || null;
    this.isSectionTitleEnabled = contextData.isSectionTitleEnabled !== false;
    this.isSectionButtonEnabled = !!contextData.isSectionButtonEnabled;

    if (!this.data.length) {
      console.warn(`[${this.pluginName}] List section has no items`);
    }
  }

  /**
   * Anything the list section settings already answer is read from the section
   * rather than repeated as a plugin setting — there is no second place to set
   * it. A list layout without one of these controls leaves the key out of the
   * context entirely, and those keep the plugin's own default.
   */
  applySectionDerivedSettings() {
    // Section » Infinite Scroll
    const isInfiniteEnabled = this.options?.isInfiniteEnabled;
    this.loop = typeof isInfiniteEnabled === 'boolean' ? isInfiniteEnabled : true;

    // Section » Navigation. Matched on "arrow" rather than against a list of
    // off values, so any other choice Squarespace offers simply means no
    // arrows.
    const navigationControls = this.options?.navigationControls;
    this.showArrows = typeof navigationControls === 'string'
      ? navigationControls.toLowerCase().includes('arrow')
      : true;
  }

  removeOrHideOriginalListSectionContent() {
    const userItemsList = this.el.querySelector('.user-items-list');
    if (!userItemsList) return;
    userItemsList.style.display = 'none';
  }

  decodeHtml(html) {
    const txt = document.createElement('textarea');
    txt.innerHTML = html;
    return txt.value;
  }

  sanitizeTitleHtml(html) {
    if (!html) return '';
    const decoded = this.decodeHtml(html);
    const temp = document.createElement('div');
    temp.innerHTML = decoded;
    temp.querySelectorAll('p').forEach(p => {
      if (!p.textContent.trim() && !p.querySelector('img, video, iframe')) {
        p.remove();
      }
    });
    return temp.innerHTML;
  }

  buildSectionTitle() {
    const titleHtml = this.sanitizeTitleHtml(this.sectionTitle);
    if (!titleHtml) return null;

    const titleEl = document.createElement('div');
    titleEl.className = 'wm-showcase-carousel-section-title list-section-title';

    const temp = document.createElement('div');
    temp.innerHTML = titleHtml;
    const paragraphs = [...temp.children].filter(child => child.tagName === 'P');

    if (paragraphs.length && paragraphs.length === temp.children.length) {
      const h2 = document.createElement('h2');
      h2.innerHTML = paragraphs
        .map(p => p.innerHTML.trim())
        .filter(Boolean)
        .join('<br>');
      titleEl.appendChild(h2);
    } else {
      titleEl.innerHTML = titleHtml;
    }
    return titleEl;
  }

  buildSectionButton() {
    if (!this.isSectionButtonEnabled || !this.sectionButton?.buttonText) return null;

    const buttonWrap = document.createElement('div');
    buttonWrap.className = 'wm-showcase-carousel-section-button list-section-button-container';

    const button = document.createElement('a');
    button.className = 'wm-showcase-carousel-button sqs-block-button-element sqs-button-element--primary';
    button.href = this.sectionButton.buttonLink || '#';
    button.textContent = this.sectionButton.buttonText;
    if (this.sectionButton.buttonNewWindow) {
      button.target = '_blank';
      button.rel = 'noopener noreferrer';
    }

    buttonWrap.appendChild(button);
    return buttonWrap;
  }

  buildArrows() {
    const arrows = document.createElement('div');
    arrows.className = 'wm-showcase-carousel-arrows';

    this.prevButton = document.createElement('button');
    this.prevButton.type = 'button';
    this.prevButton.className = 'wm-showcase-carousel-arrow wm-showcase-carousel-arrow--prev';
    this.prevButton.setAttribute('aria-label', 'Previous slide');
    this.prevButton.innerHTML = `
      <svg viewBox="0 0 44 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
        <path d="M9.90649 16.96L2.1221 9.17556L9.9065 1.39116" />
        <path d="M42.8633 9.18125L3.37868 9.18125" />
      </svg>`;

    this.nextButton = document.createElement('button');
    this.nextButton.type = 'button';
    this.nextButton.className = 'wm-showcase-carousel-arrow wm-showcase-carousel-arrow--next';
    this.nextButton.setAttribute('aria-label', 'Next slide');
    this.nextButton.innerHTML = `
      <svg viewBox="0 0 44 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
        <path d="M34.1477 1.39111L41.9321 9.17551L34.1477 16.9599" />
        <path d="M1.19088 9.16982H40.6755" />
      </svg>`;

    arrows.appendChild(this.prevButton);
    arrows.appendChild(this.nextButton);
    return arrows;
  }

  buildProgress() {
    const progress = document.createElement('div');
    progress.className = 'wm-showcase-carousel-progress';
    progress.setAttribute('aria-hidden', 'true');

    this.progressBar = document.createElement('div');
    this.progressBar.className = 'wm-showcase-carousel-progress-bar';
    this.progressBar.style.width = `${100 / this.data.length}%`;

    progress.appendChild(this.progressBar);
    return progress;
  }

  /**
   * Hidden probes let the sizing live in CSS custom properties — including
   * inside the user's own media queries — while JS still gets the resolved
   * pixel values it needs for the absolute positioning math.
   */
  buildMetricsProbe() {
    const metrics = document.createElement('div');
    metrics.className = 'wm-showcase-carousel-metrics';
    metrics.setAttribute('aria-hidden', 'true');
    ['center', 'side', 'gap', 'ratio'].forEach(name => {
      const probe = document.createElement('span');
      probe.dataset.metric = name;
      metrics.appendChild(probe);
    });
    return metrics;
  }

  buildLayout() {
    const userItemsList = this.el.querySelector('.user-items-list');
    if (!userItemsList || !userItemsList.parentElement) return;

    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'wm-plugin-content';

    let sectionTitleEl = null;
    if (this.isSectionTitleEnabled && this.sectionTitle) {
      sectionTitleEl = this.buildSectionTitle();
      if (sectionTitleEl) contentWrapper.appendChild(sectionTitleEl);
    }

    this.carousel = document.createElement('div');
    this.carousel.className = 'wm-showcase-carousel';
    this.carousel.setAttribute('role', 'region');
    this.carousel.setAttribute('aria-roledescription', 'carousel');
    this.carousel.setAttribute(
      'aria-label',
      sectionTitleEl?.textContent.trim() || 'Showcase carousel'
    );
    if (this.data.length < 2) this.carousel.setAttribute('data-carousel-single', 'true');
    if (this.settings.draggable && this.data.length > 1) {
      this.carousel.setAttribute('data-carousel-draggable', 'true');
    }

    this.track = document.createElement('div');
    this.track.className = 'wm-showcase-carousel-track';

    this.data.forEach((item, index) => {
      const slide = this.buildSlide(item, index);
      this.track.appendChild(slide);
      this.slides.push(slide);
    });

    this.metricsEl = this.buildMetricsProbe();

    this.carousel.appendChild(this.metricsEl);
    this.carousel.appendChild(this.track);
    if (this.showArrows && this.data.length > 1) {
      this.carousel.appendChild(this.buildArrows());
    } else if (this.data.length > 1) {
      // Without the arrows there is nothing here to focus, so the carousel
      // itself becomes the tab stop that the left/right keys work from.
      this.carousel.setAttribute('tabindex', '0');
    }
    if (this.settings.showProgress && this.data.length > 1) {
      this.carousel.appendChild(this.buildProgress());
    }

    contentWrapper.appendChild(this.carousel);

    const sectionButton = this.buildSectionButton();
    if (sectionButton) contentWrapper.appendChild(sectionButton);

    userItemsList.insertAdjacentElement('afterend', contentWrapper);

    const startIndex = Number(this.settings.startIndex);
    this.centerIndex = Number.isFinite(startIndex)
      ? Math.min(Math.max(Math.trunc(startIndex), 0), this.data.length - 1)
      : 0;
  }

  buildImageUrl(assetUrl) {
    if (!assetUrl) return '';
    const base = assetUrl.split('?')[0];
    const width = parseInt(this.settings.imageWidth, 10);
    return Number.isFinite(width) ? `${base}?format=${width}w` : base;
  }

  buildSlide(item, index) {
    const slide = document.createElement('div');
    slide.className = 'wm-showcase-carousel-slide';
    slide.dataset.index = index;
    slide.setAttribute('role', 'group');
    slide.setAttribute('aria-roledescription', 'slide');
    slide.setAttribute('aria-label', `${index + 1} of ${this.data.length}`);

    const media = document.createElement('div');
    media.className = 'wm-showcase-carousel-media';

    if (item.image?.assetUrl && this.options?.isMediaEnabled !== false) {
      const img = document.createElement('img');
      img.src = this.buildImageUrl(item.image.assetUrl);
      img.alt = item.image.title || item.title || '';
      img.loading = 'lazy';
      img.draggable = false;

      const focalX = item.image.mediaFocalPoint?.x ?? 0.5;
      const focalY = item.image.mediaFocalPoint?.y ?? 0.5;
      img.style.objectPosition = `${focalX * 100}% ${focalY * 100}%`;

      media.appendChild(img);
    } else {
      media.classList.add('wm-showcase-carousel-media--empty');
    }

    const content = document.createElement('div');
    content.className = 'wm-showcase-carousel-content';

    if (item.title && this.options?.isTitleEnabled !== false) {
      const title = document.createElement('h3');
      title.className = 'wm-showcase-carousel-title';
      title.textContent = item.title;
      content.appendChild(title);
    }

    if (item.description && this.options?.isBodyEnabled !== false) {
      const description = document.createElement('div');
      description.className = 'wm-showcase-carousel-description';
      description.innerHTML = item.description;
      content.appendChild(description);
    }

    if (item.button?.buttonText && this.options?.isButtonEnabled !== false) {
      const buttonWrap = document.createElement('div');
      buttonWrap.className = 'wm-showcase-carousel-item-button-wrapper';

      const button = document.createElement('a');
      button.className = 'wm-showcase-carousel-item-button sqs-block-button-element sqs-button-element--primary';
      button.href = item.button.buttonLink || '#';
      button.textContent = item.button.buttonText;
      button.draggable = false;
      if (item.button.buttonNewWindow) {
        button.target = '_blank';
        button.rel = 'noopener noreferrer';
      }

      buttonWrap.appendChild(button);
      content.appendChild(buttonWrap);
    }

    if (content.childElementCount) media.appendChild(content);
    slide.appendChild(media);
    return slide;
  }

  mod(n, m) {
    return ((n % m) + m) % m;
  }

  /**
   * Resolve a slide index the placement loop wants to show. Outside of loop
   * mode the ends are hard stops, so out of range means "nothing to place".
   */
  resolveIndex(index) {
    const count = this.data.length;
    if (this.loop) return this.mod(index, count);
    return index >= 0 && index < count ? index : null;
  }

  readMetrics(viewportWidth) {
    const centerProbe = this.metricsEl?.querySelector('[data-metric="center"]');
    const sideProbe = this.metricsEl?.querySelector('[data-metric="side"]');
    const gapProbe = this.metricsEl?.querySelector('[data-metric="gap"]');
    const ratioProbe = this.metricsEl?.querySelector('[data-metric="ratio"]');

    // The probes carry the user facing custom properties, so a missing or
    // unresolved value falls back to the same numbers the stylesheet ships.
    // Rects rather than offsetWidth: the ratio probe needs sub-pixel precision.
    const centerRect = centerProbe?.getBoundingClientRect();
    const sideRect = sideProbe?.getBoundingClientRect();
    const gapRect = gapProbe?.getBoundingClientRect();
    const ratioRect = ratioProbe?.getBoundingClientRect();

    const centerWidth = Math.round(centerRect?.width || viewportWidth * 0.48);
    const sideWidth = Math.round(sideRect?.width || viewportWidth * 0.38);
    const gap = Math.round(gapRect?.width || 20);

    let ratio = WMShowcaseCarousel.fallbackAspectRatio;
    if (ratioRect?.width && ratioRect.height) {
      ratio = ratioRect.height / ratioRect.width;
    }

    return { centerWidth, sideWidth, gap, ratio };
  }

  /**
   * Stretch the carousel to the window edges. The offsets are measured rather
   * than derived from the section gutter because layout width, section padding
   * and the scrollbar all move that edge — and a 100vw rule would overhang by
   * the width of the scrollbar.
   */
  alignFullBleed() {
    if (!this.settings.fullBleed) return;
    const parent = this.carousel.parentElement;
    if (!parent) return;

    const parentRect = parent.getBoundingClientRect();
    if (!parentRect.width) return;
    const documentWidth = document.documentElement.clientWidth;

    this.carousel.style.marginLeft = `${-parentRect.left}px`;
    this.carousel.style.marginRight = `${-(documentWidth - parentRect.right)}px`;
  }

  /**
   * Position every slide around the centered one. Slides are absolutely
   * positioned and transformed rather than laid out in flow so the center slide
   * can grow and the neighbours can slide underneath it without reflowing the
   * page on every frame.
   */
  layout(direction) {
    if (!this.carousel || !this.track || !this.slides.length) return;

    this.alignFullBleed();

    const viewportWidth = this.carousel.clientWidth;
    // Bail rather than dividing by a zero width, which happens while the
    // section is still hidden (editor panels, display:none parents).
    if (!viewportWidth) return;

    const count = this.data.length;
    const { centerWidth, sideWidth, gap, ratio } = this.readMetrics(viewportWidth);
    const centerLeft = Math.round((viewportWidth - centerWidth) / 2);

    this.track.style.height = `${Math.round(centerWidth * ratio)}px`;

    const newPositions = {};
    const placed = new Set();

    newPositions[this.centerIndex] = { x: centerLeft, w: centerWidth, isCenter: true };
    placed.add(this.centerIndex);

    // Fill to the right of the center slide, then to the left, until the
    // viewport (plus one slide of bleed) is covered.
    let x = centerLeft + centerWidth + gap;
    for (let i = 1; x < viewportWidth + sideWidth; i += 1) {
      const index = this.resolveIndex(this.centerIndex + i);
      if (index === null || placed.has(index)) break;
      newPositions[index] = { x, w: sideWidth, isCenter: false };
      placed.add(index);
      x += sideWidth + gap;
    }

    x = centerLeft - gap - sideWidth;
    for (let i = 1; x > -(sideWidth * 2); i += 1) {
      const index = this.resolveIndex(this.centerIndex - i);
      if (index === null || placed.has(index)) break;
      newPositions[index] = { x, w: sideWidth, isCenter: false };
      placed.add(index);
      x -= sideWidth + gap;
    }

    // A slide that wrapped around the loop would otherwise animate all the way
    // across the viewport. Jump it to the far edge without a transition first,
    // then let the normal pass animate it into place.
    const teleported = [];
    this.slides.forEach((slide, index) => {
      const previous = this.positions[index];
      const next = newPositions[index];
      if (!next) return;
      if (previous && Math.abs(next.x - previous.x) > viewportWidth * 0.5) {
        teleported.push(index);
      } else if (!previous && direction !== undefined) {
        teleported.push(index);
      }
    });

    teleported.forEach(index => {
      const slide = this.slides[index];
      const position = newPositions[index];
      slide.classList.add('wm-showcase-carousel-slide--teleport');
      slide.style.width = `${position.w}px`;
      if (direction === 1) {
        slide.style.transform = `translate3d(${viewportWidth + position.w}px, -50%, 0)`;
      } else if (direction === -1) {
        slide.style.transform = `translate3d(${-(position.w + gap)}px, -50%, 0)`;
      }
    });

    // Force the teleport to land before the animated pass reads it back.
    if (teleported.length) void this.track.offsetHeight;
    teleported.forEach(index => {
      this.slides[index].classList.remove('wm-showcase-carousel-slide--teleport');
    });

    this.slides.forEach((slide, index) => {
      const position = newPositions[index];
      if (position) {
        slide.style.width = `${position.w}px`;
        slide.style.transform = `translate3d(${position.x}px, -50%, 0)`;
        slide.toggleAttribute('data-center', position.isCenter);
        slide.removeAttribute('aria-hidden');
      } else {
        // Parked off canvas: never visible, never in the tab order.
        slide.style.transform = 'translate3d(-9999px, -50%, 0)';
        slide.removeAttribute('data-center');
        slide.setAttribute('aria-hidden', 'true');
      }
      this.updateSlideFocusability(slide, !!position?.isCenter);
    });

    this.positions = newPositions;
    this.lastWidth = viewportWidth;
    this.updateProgress();
    this.updateArrows();
  }

  /**
   * Only the center slide takes part in the tab order — a link tucked behind a
   * half visible neighbour is a focus trap for keyboard users.
   */
  updateSlideFocusability(slide, isCenter) {
    slide.querySelectorAll('a, button').forEach(el => {
      if (isCenter) {
        el.removeAttribute('tabindex');
      } else {
        el.setAttribute('tabindex', '-1');
      }
    });
  }

  updateProgress(fractionalIndex) {
    if (!this.progressBar) return;
    const index = fractionalIndex !== undefined ? fractionalIndex : this.centerIndex;

    // Wrapping from the last slide to the first would otherwise animate the bar
    // all the way back across the track.
    if (this.skipProgressTransition) {
      this.skipProgressTransition = false;
      this.progressBar.classList.add('wm-showcase-carousel-progress-bar--teleport');
      this.progressBar.style.transform = `translateX(${index * 100}%)`;
      void this.progressBar.offsetHeight;
      this.progressBar.classList.remove('wm-showcase-carousel-progress-bar--teleport');
      return;
    }

    this.progressBar.style.transform = `translateX(${index * 100}%)`;
  }

  updateArrows() {
    if (!this.prevButton || !this.nextButton) return;
    const atStart = !this.loop && this.centerIndex === 0;
    const atEnd = !this.loop && this.centerIndex === this.data.length - 1;
    this.prevButton.disabled = atStart;
    this.nextButton.disabled = atEnd;
  }

  goTo(index, direction) {
    const count = this.data.length;
    const target = this.loop
      ? this.mod(index, count)
      : Math.min(Math.max(index, 0), count - 1);
    if (target === this.centerIndex) {
      this.layout();
      return;
    }

    const step = direction !== undefined
      ? direction
      : (target > this.centerIndex ? 1 : -1);
    this.skipProgressTransition = this.loop
      && ((step === 1 && target < this.centerIndex) || (step === -1 && target > this.centerIndex));
    this.centerIndex = target;
    this.layout(step);
    WMShowcaseCarousel.emitEvent(
      ':change',
      { el: this.el, index: this.centerIndex, item: this.data[this.centerIndex] },
      this.el
    );
  }

  next() {
    if (!this.loop && this.centerIndex >= this.data.length - 1) return;
    this.goTo(this.centerIndex + 1, 1);
  }

  previous() {
    if (!this.loop && this.centerIndex <= 0) return;
    this.goTo(this.centerIndex - 1, -1);
  }

  /* ---- Drag / swipe ---- */

  suspendTransitions() {
    this.carousel.setAttribute('data-carousel-dragging', 'true');
  }

  restoreTransitions() {
    this.carousel.removeAttribute('data-carousel-dragging');
  }

  handlePointerDown(event) {
    if (!this.settings.draggable || this.data.length < 2) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.target.closest('.wm-showcase-carousel-arrow')) return;

    this.isDragging = true;
    this.isDragLocked = false;
    this.suppressClick = false;
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    this.dragDeltaX = 0;
    this.pauseAutoplay();
    this.suspendTransitions();
  }

  handlePointerMove(event) {
    if (!this.isDragging) return;

    const dx = event.clientX - this.dragStartX;
    const dy = event.clientY - this.dragStartY;
    const lockThreshold = WMShowcaseCarousel.dragLockThreshold;

    if (!this.isDragLocked && (Math.abs(dx) > lockThreshold || Math.abs(dy) > lockThreshold)) {
      // A mostly vertical gesture belongs to the page, not the carousel.
      if (Math.abs(dy) > Math.abs(dx)) {
        this.isDragging = false;
        this.restoreTransitions();
        this.resumeAutoplay();
        return;
      }
      this.isDragLocked = true;
      // A gesture that became a drag must not also read as a click on release.
      this.suppressClick = true;
      this.carousel.setPointerCapture(event.pointerId);
    }

    if (!this.isDragLocked) return;
    if (event.cancelable) event.preventDefault();

    this.dragDeltaX = this.applyEdgeResistance(dx);

    this.slides.forEach((slide, index) => {
      const position = this.positions[index];
      if (position) {
        slide.style.transform = `translate3d(${position.x + this.dragDeltaX}px, -50%, 0)`;
      }
    });

    const width = this.lastWidth || this.carousel.clientWidth || 1;
    this.updateProgress(this.centerIndex - this.dragDeltaX / width);
  }

  /**
   * With looping off there is nothing beyond the first and last slide, so the
   * drag is damped instead of pulling empty space into view.
   */
  applyEdgeResistance(dx) {
    if (this.loop) return dx;
    const atStart = this.centerIndex === 0 && dx > 0;
    const atEnd = this.centerIndex === this.data.length - 1 && dx < 0;
    return atStart || atEnd ? dx * WMShowcaseCarousel.dragEdgeResistance : dx;
  }

  handlePointerUp(event) {
    if (!this.isDragging) return;
    this.isDragging = false;
    this.restoreTransitions();

    if (this.carousel.hasPointerCapture?.(event.pointerId)) {
      this.carousel.releasePointerCapture(event.pointerId);
    }

    const travelled = Math.abs(this.dragDeltaX);
    if (this.isDragLocked && travelled > WMShowcaseCarousel.dragThreshold) {
      const before = this.centerIndex;
      if (this.dragDeltaX < 0) {
        this.next();
      } else {
        this.previous();
      }
      // A drag past the first or last slide with looping off changes nothing,
      // so the slides still need snapping back out of the drag offset.
      if (this.centerIndex === before) this.layout();
    } else if (this.isDragLocked) {
      this.layout();
    }

    this.dragDeltaX = 0;
    this.isDragLocked = false;
    this.resumeAutoplay();
  }

  handlePointerCancel() {
    if (!this.isDragging) return;
    this.isDragging = false;
    this.isDragLocked = false;
    this.dragDeltaX = 0;
    this.restoreTransitions();
    this.layout();
    this.resumeAutoplay();
  }

  /**
   * Which way a slide should travel to reach the center. In loop mode that is
   * whichever way round is shorter.
   */
  slideDirection(index) {
    if (!this.loop) return index > this.centerIndex ? 1 : -1;
    const count = this.data.length;
    const forward = this.mod(index - this.centerIndex, count);
    return forward <= count - forward ? 1 : -1;
  }

  /**
   * Clicks are handled in the capture phase so a link inside a side slide never
   * navigates on the click the user meant as "bring this one forward", and so a
   * link never fires on the click that ends a drag.
   */
  handleClickCapture(event) {
    const link = event.target.closest?.('a, button');

    if (this.suppressClick) {
      this.suppressClick = false;
      if (link && !link.closest('.wm-showcase-carousel-arrow')) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (!this.settings.clickToCenter) return;
    const slide = event.target.closest?.('.wm-showcase-carousel-slide');
    if (!slide || slide.hasAttribute('data-center')) return;

    const index = Number(slide.dataset.index);
    if (!Number.isFinite(index)) return;

    if (link) {
      event.preventDefault();
      event.stopPropagation();
    }
    this.goTo(index, this.slideDirection(index));
  }

  handleKeydown(event) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.previous();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.next();
    }
  }

  /* ---- Autoplay ---- */

  startAutoplay() {
    if (!this.settings.autoplay || this.prefersReducedMotion) return;
    if (this.data.length < 2 || this.autoplayTimer) return;
    const speed = parseInt(this.settings.autoplaySpeed, 10);
    this.autoplayTimer = setInterval(() => {
      if (!this.isVisible || this.isAutoplayPaused || document.hidden) return;
      if (!this.loop && this.centerIndex >= this.data.length - 1) {
        this.goTo(0, -1);
        return;
      }
      this.next();
    }, Number.isFinite(speed) ? speed : 5000);
  }

  stopAutoplay() {
    if (!this.autoplayTimer) return;
    clearInterval(this.autoplayTimer);
    this.autoplayTimer = null;
  }

  pauseAutoplay() {
    this.isAutoplayPaused = true;
  }

  resumeAutoplay() {
    this.isAutoplayPaused = false;
  }

  bindEvents() {
    if (!this.carousel) return;

    this.boundHandlePointerDown = event => this.handlePointerDown(event);
    this.boundHandlePointerMove = event => this.handlePointerMove(event);
    this.boundHandlePointerUp = event => this.handlePointerUp(event);
    this.boundHandlePointerCancel = () => this.handlePointerCancel();
    this.boundHandleKeydown = event => this.handleKeydown(event);
    this.boundHandleClickCapture = event => this.handleClickCapture(event);

    this.carousel.addEventListener('pointerdown', this.boundHandlePointerDown);
    this.carousel.addEventListener('pointermove', this.boundHandlePointerMove, { passive: false });
    this.carousel.addEventListener('pointerup', this.boundHandlePointerUp);
    this.carousel.addEventListener('pointercancel', this.boundHandlePointerCancel);
    this.carousel.addEventListener('dragstart', event => event.preventDefault());
    this.carousel.addEventListener('keydown', this.boundHandleKeydown);
    this.carousel.addEventListener('click', this.boundHandleClickCapture, true);

    this.prevButton?.addEventListener('click', () => this.previous());
    this.nextButton?.addEventListener('click', () => this.next());

    // Debounced: the layout pass writes the track height, and an undebounced
    // resize handler would run it once per intermediate width.
    this.boundHandleResize = () => {
      clearTimeout(this.resizeTimeout);
      this.resizeTimeout = setTimeout(() => this.layout(), 100);
    };
    window.addEventListener('resize', this.boundHandleResize, { passive: true });
    window.addEventListener('orientationchange', this.boundHandleResize);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        // Height changes come from this plugin's own layout pass, so only a
        // width change is worth reacting to.
        if (this.carousel.clientWidth === this.lastWidth) return;
        this.boundHandleResize();
      });
      this.resizeObserver.observe(this.carousel);
    }

    if (typeof IntersectionObserver !== 'undefined') {
      this.intersectionObserver = new IntersectionObserver(entries => {
        this.isVisible = entries.some(entry => entry.isIntersecting);
        // Sections that start hidden have no width to measure until now.
        if (this.isVisible && !this.lastWidth) this.layout();
      }, { rootMargin: '10% 0px' });
      this.intersectionObserver.observe(this.carousel);
    }

    if (this.settings.autoplay && this.settings.pauseOnHover) {
      this.boundPauseAutoplay = () => this.pauseAutoplay();
      this.boundResumeAutoplay = () => this.resumeAutoplay();
      this.carousel.addEventListener('mouseenter', this.boundPauseAutoplay);
      this.carousel.addEventListener('mouseleave', this.boundResumeAutoplay);
      this.carousel.addEventListener('focusin', this.boundPauseAutoplay);
      this.carousel.addEventListener('focusout', this.boundResumeAutoplay);
    }

    this.startAutoplay();

    requestAnimationFrame(() => this.layout());
  }

  destroy() {
    this.stopAutoplay();
    clearTimeout(this.resizeTimeout);

    if (this.boundHandleResize) {
      window.removeEventListener('resize', this.boundHandleResize);
      window.removeEventListener('orientationchange', this.boundHandleResize);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
      this.intersectionObserver = null;
    }

    const customContent = this.el.querySelector('.wm-plugin-content');
    if (customContent) customContent.remove();

    const userItemsList = this.el.querySelector('.user-items-list');
    if (userItemsList) userItemsList.style.display = '';

    this.el.removeAttribute('data-wm-plugin');
    this.carousel = null;
    this.track = null;
    this.metricsEl = null;
    this.progressBar = null;
    this.prevButton = null;
    this.nextButton = null;
    this.slides = [];
    this.positions = {};
    this.lastWidth = 0;

    WMShowcaseCarousel.emitEvent(':destroy', { el: this.el }, this.el);
  }
}

// Immediate initialization (no DOMContentLoaded)
(function () {
  const pluginName = 'showcase-carousel';
  const sections = document.querySelectorAll(`[id^="${pluginName}"]`);
  const instances = [];

  sections.forEach(section => {
    const sectionId = section.id;
    const settings = window.wmShowcaseCarouselSettings?.[sectionId] || {};
    const instance = new WMShowcaseCarousel(section, settings);
    instances.push(instance);
  });

  if (window.top !== window.self) {
    const observer = new MutationObserver(() => {
      if (document.body.classList.contains('sqs-edit-mode-active')) {
        instances.forEach(instance => {
          if (instance && typeof instance.destroy === 'function') {
            instance.destroy();
          }
        });
        observer.disconnect();
      }
    });

    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class']
    });
  }
})();
