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

  // Stacking for the centered slide, counting down for each step away from it.
  // Stays below the arrows' z-index of 10.
  static maxSlideZIndex = 6;

  constructor(el, settings = {}) {
    this.el = el;
    this.settings = {
      draggable: true, // drag/swipe to move between slides
      clickToCenter: true, // clicking a side slide brings it to the center
      hideInactiveText: false, // hide the text overlay on the side slides
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
    this.dragFrame = null;
    this.progressWrapDirection = 0; // set to the travel direction on a loop wrap
    this.progressWrapFrom = 0;
    this.progressWrapAnimation = null;
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
    if (this.settings.hideInactiveText) {
      this.el.setAttribute('data-carousel-hide-inactive-text', 'true');
    }
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
    ['center', 'side-scale', 'gap', 'ratio'].forEach(name => {
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

  buildImageUrl(assetUrl, width) {
    if (!assetUrl) return '';
    const base = assetUrl.split('?')[0];
    return Number.isFinite(width) ? `${base}?format=${width}w` : base;
  }

  /**
   * Squarespace lists the widths it rendered for an asset in systemDataVariants
   * ("2500x1406,100w,300w,…"). Offering them lets a phone fetch a 750w file for
   * a 330px slide instead of the full imageWidth: a smaller download, and a far
   * smaller texture for the GPU to move while the carousel is being dragged.
   */
  buildImageSrcset(image, maxWidth) {
    const variants = image?.systemDataVariants;
    if (typeof variants !== 'string') return '';

    const widths = variants
      .split(',')
      .map(variant => /^(\d+)w$/.exec(variant.trim()))
      .filter(Boolean)
      .map(match => parseInt(match[1], 10))
      .filter(width => Number.isFinite(width) && width <= maxWidth)
      .sort((a, b) => a - b);

    if (widths.length < 2) return '';
    return widths
      .map(width => `${this.buildImageUrl(image.assetUrl, width)} ${width}w`)
      .join(', ');
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
      const maxWidth = parseInt(this.settings.imageWidth, 10);
      const img = document.createElement('img');
      img.src = this.buildImageUrl(item.image.assetUrl, maxWidth);

      const srcset = this.buildImageSrcset(item.image, maxWidth);
      if (srcset) {
        img.srcset = srcset;
        // Mirrors the stylesheet's default centered and side widths at each
        // breakpoint. It only has to be close: the browser rounds up to the
        // next variant it has.
        img.sizes = '(max-width: 767px) 86vw, 48vw';
      }

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
    const scaleProbe = this.metricsEl?.querySelector('[data-metric="side-scale"]');
    const gapProbe = this.metricsEl?.querySelector('[data-metric="gap"]');
    const ratioProbe = this.metricsEl?.querySelector('[data-metric="ratio"]');

    // The probes carry the user facing custom properties, so a missing or
    // unresolved value falls back to the same numbers the stylesheet ships.
    // Rects rather than offsetWidth: the ratio probe needs sub-pixel precision.
    const centerRect = centerProbe?.getBoundingClientRect();
    // The side probe is 100px wide times the scale, so its measured width is
    // the scale in hundredths. Going through a probe rather than reading the
    // property means a calc() or a media query override resolves for free.
    const scaleRect = scaleProbe?.getBoundingClientRect();
    const gapRect = gapProbe?.getBoundingClientRect();
    const ratioRect = ratioProbe?.getBoundingClientRect();

    const centerWidth = Math.round(centerRect?.width || viewportWidth * 0.48);
    const sideScale = scaleRect?.width ? scaleRect.width / 100 : 0.8;
    const gap = Math.round(gapRect?.width || 20);

    let ratio = WMShowcaseCarousel.fallbackAspectRatio;
    if (ratioRect?.width && ratioRect.height) {
      ratio = ratioRect.height / ratioRect.width;
    }

    return { centerWidth, sideScale, gap, ratio };
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
    const { centerWidth, sideScale, gap, ratio } = this.readMetrics(viewportWidth);
    const centerLeft = Math.round((viewportWidth - centerWidth) / 2);

    // Every slide is laid out at the centered width and scaled down when it is
    // to the side, rather than having its width animated. A width animation
    // re-wraps the overlay's text on every frame of the move; scaling zooms the
    // whole slide, text included, and rides the compositor. The side slides'
    // width is what the scale leaves, and it still drives their positions.
    const sideWidth = Math.round(centerWidth * sideScale);

    this.track.style.height = `${Math.round(centerWidth * ratio)}px`;

    const newPositions = {};
    const placed = new Set();

    // offset is how many slots away from the center this slide sits, negative
    // to the left. It drives both the stacking and the wrap detection below.
    newPositions[this.centerIndex] = { x: centerLeft, w: centerWidth, isCenter: true, offset: 0, scale: 1 };
    placed.add(this.centerIndex);

    // Fill to the right of the center slide, then to the left, until the
    // viewport (plus one slide of bleed) is covered.
    let x = centerLeft + centerWidth + gap;
    for (let i = 1; x < viewportWidth + sideWidth; i += 1) {
      const index = this.resolveIndex(this.centerIndex + i);
      if (index === null || placed.has(index)) break;
      newPositions[index] = { x, w: sideWidth, isCenter: false, offset: i, scale: sideScale };
      placed.add(index);
      x += sideWidth + gap;
    }

    x = centerLeft - gap - sideWidth;
    for (let i = 1; x > -(sideWidth * 2); i += 1) {
      const index = this.resolveIndex(this.centerIndex - i);
      if (index === null || placed.has(index)) break;
      newPositions[index] = { x, w: sideWidth, isCenter: false, offset: -i, scale: sideScale };
      placed.add(index);
      x -= sideWidth + gap;
    }

    // A slide that wrapped around the loop would otherwise animate all the way
    // across the viewport. Jump it to the far edge without a transition first,
    // then let the normal pass animate it into place.
    //
    // Whether a slide wrapped is a question about slots, not distance. Moving
    // the center on by one shifts every slide one slot the other way, so a
    // slide whose new slot is not the expected one came around the ends. A
    // distance test cannot tell the two apart: on a narrow screen an ordinary
    // step already moves a slide further than half the viewport, and every move
    // was being mistaken for a wrap.
    const teleported = [];
    this.slides.forEach((slide, index) => {
      const previous = this.positions[index];
      const next = newPositions[index];
      if (!next || direction === undefined) return;
      if (!previous) {
        teleported.push(index);
      } else if (next.offset !== previous.offset - direction) {
        teleported.push(index);
      }
    });

    teleported.forEach(index => {
      const slide = this.slides[index];
      const position = newPositions[index];
      slide.classList.add('wm-showcase-carousel-slide--teleport');
      slide.style.width = `${centerWidth}px`;
      if (direction === 1) {
        slide.style.transform = `translate3d(${viewportWidth + position.w}px, -50%, 0) scale(${position.scale})`;
      } else if (direction === -1) {
        slide.style.transform = `translate3d(${-(position.w + gap)}px, -50%, 0) scale(${position.scale})`;
      }
    });

    // Force the teleport to land before the animated pass reads it back.
    if (teleported.length) void this.track.offsetHeight;
    teleported.forEach(index => {
      this.slides[index].classList.remove('wm-showcase-carousel-slide--teleport');
    });

    const parked = [];

    this.slides.forEach((slide, index) => {
      const position = newPositions[index];
      if (position) {
        slide.style.width = `${centerWidth}px`;
        slide.style.transform = `translate3d(${position.x}px, -50%, 0) scale(${position.scale})`;
        // Nearest the center paints highest. Without this the slides stack in
        // DOM order, so a slide moving in from the left passed under its
        // neighbour while one from the right passed over it.
        slide.style.zIndex = String(
          Math.max(1, WMShowcaseCarousel.maxSlideZIndex - Math.abs(position.offset))
        );
        slide.toggleAttribute('data-center', position.isCenter);
        slide.removeAttribute('aria-hidden');
      } else {
        parked.push(slide);
      }
      this.updateSlideFocusability(slide, !!position?.isCenter);
    });

    // A slide that has dropped out of the arrangement goes off canvas with the
    // transition suppressed. Animating it there would send it travelling to
    // -9999px: harmless for one leaving past the left edge, but a slide leaving
    // past the right edge would sweep back across the whole carousel on its way
    // out, which is what made moving backwards look wrong.
    if (parked.length) {
      parked.forEach(slide => slide.classList.add('wm-showcase-carousel-slide--teleport'));
      parked.forEach(slide => {
        slide.style.transform = 'translate3d(-9999px, -50%, 0)';
        slide.style.zIndex = '';
        slide.removeAttribute('data-center');
        slide.setAttribute('aria-hidden', 'true');
      });
      void this.track.offsetHeight;
      parked.forEach(slide => slide.classList.remove('wm-showcase-carousel-slide--teleport'));
    }

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

    if (this.progressWrapDirection && fractionalIndex === undefined) {
      const direction = this.progressWrapDirection;
      this.progressWrapDirection = 0;
      this.animateProgressWrap(index, direction);
      return;
    }

    this.setProgressTransform(index);
  }

  setProgressTransform(index, immediate) {
    this.progressWrapAnimation?.cancel();
    this.progressWrapAnimation = null;

    if (immediate) {
      this.progressBar.classList.add('wm-showcase-carousel-progress-bar--teleport');
      this.progressBar.style.transform = `translateX(${index * 100}%)`;
      void this.progressBar.offsetHeight;
      this.progressBar.classList.remove('wm-showcase-carousel-progress-bar--teleport');
      return;
    }

    this.progressBar.style.transform = `translateX(${index * 100}%)`;
  }

  /**
   * On a loop the bar keeps travelling the way the carousel is going: it runs
   * off the end it is leaving, then comes back in from the opposite edge, the
   * way the slides themselves wrap. Sweeping it straight back across the track
   * would read as moving backwards.
   *
   * The two legs are one animation with a pair of keyframes sharing offset 0.5,
   * which is the jump across the gap. Duration and easing are read back off the
   * element so the bar keeps following --carousel-transition.
   */
  animateProgressWrap(target, direction) {
    const count = this.data.length;
    const from = this.progressWrapFrom;
    const exit = direction === 1 ? count : -1;
    const entry = direction === 1 ? -1 : count;

    this.setProgressTransform(target, true);
    if (typeof this.progressBar.animate !== 'function') return;

    const style = window.getComputedStyle(this.progressBar);
    const duration = (parseFloat(style.transitionDuration) || 0.6) * 1000;
    const easing = style.transitionTimingFunction || 'ease';

    this.progressWrapAnimation = this.progressBar.animate(
      [
        { transform: `translateX(${from * 100}%)`, easing },
        { transform: `translateX(${exit * 100}%)`, offset: 0.5 },
        { transform: `translateX(${entry * 100}%)`, offset: 0.5, easing },
        { transform: `translateX(${target * 100}%)` }
      ],
      { duration, fill: 'none' }
    );
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
    // A move that goes forward but lands on a lower index (or the reverse) is
    // the loop wrapping; the progress bar animates that as a wrap too.
    this.progressWrapDirection = this.loop
      && ((step === 1 && target < this.centerIndex) || (step === -1 && target > this.centerIndex))
      ? step
      : 0;
    this.progressWrapFrom = this.centerIndex;
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
        this.cancelDragFrame();
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

    // touch-action: pan-y already hands horizontal gestures to the plugin, so
    // there is nothing to preventDefault here and the listener stays passive.
    this.dragDeltaX = this.applyEdgeResistance(dx);
    this.requestDragFrame();
  }

  /**
   * Phones deliver pointer moves faster than they paint, so the offset is
   * recorded on every event but written once per frame. Writing straight off
   * the event means several full style passes per frame and a visibly stuttery
   * drag.
   */
  requestDragFrame() {
    if (this.dragFrame !== null) return;
    this.dragFrame = requestAnimationFrame(() => {
      this.dragFrame = null;
      this.applyDragOffset();
    });
  }

  cancelDragFrame() {
    if (this.dragFrame === null) return;
    cancelAnimationFrame(this.dragFrame);
    this.dragFrame = null;
  }

  applyDragOffset() {
    const delta = this.dragDeltaX;

    this.slides.forEach((slide, index) => {
      const position = this.positions[index];
      if (position) {
        slide.style.transform = `translate3d(${position.x + delta}px, -50%, 0) scale(${position.scale})`;
      }
    });

    const width = this.lastWidth || this.carousel.clientWidth || 1;
    this.updateProgress(this.centerIndex - delta / width);
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
    this.cancelDragFrame();
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
    this.cancelDragFrame();
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
    this.carousel.addEventListener('pointermove', this.boundHandlePointerMove, { passive: true });
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
    this.cancelDragFrame();
    clearTimeout(this.resizeTimeout);
    this.progressWrapAnimation?.cancel();
    this.progressWrapAnimation = null;

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
    this.el.removeAttribute('data-carousel-hide-inactive-text');
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
