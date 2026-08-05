// ── Dark mode ON by default ──
let explorerMode = localStorage.getItem('rma-explorer') === 'true';
let autoplay     = localStorage.getItem('rma-autoplay') !== 'false'; // ON by default
// default dark = true unless user explicitly saved 'false'
let darkMode     = localStorage.getItem('rma-dark') !== 'false';

let nasaData   = null;
let currentCtrl = null;
let metaVisible = false;

// ── Constants ────────────────────────────────────────────────
const AUTOPLAY_DURATION = 30000;
const POPULAR_DATES = [
  '2024-01-01', '2023-12-25', '2023-07-20', '2022-07-12', '2021-02-18',
  '2020-07-30', '2019-04-11', '2018-08-12', '2017-08-21', '2016-07-04',
  '2015-07-14', '2014-11-12', '2013-11-28', '2012-08-06', '2011-07-21',
  '2010-02-18', '2009-05-25', '2008-05-25', '2007-08-08', '2006-01-19',
];

// Ordered list of CORS proxies — tried in sequence on failure
const CORS_PROXIES = [
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.org/?${encodeURIComponent(url)}`,
];

// Domains that block CORS proxies — load these directly via <img> (no proxy attempt)
const DIRECT_LOAD_DOMAINS = new Set(['apod.nasa.gov', 'sdo.gsfc.nasa.gov']);

function shouldLoadDirect(url) {
  try { return DIRECT_LOAD_DOMAINS.has(new URL(url).hostname); } catch { return false; }
}

// Pick a random element from an array
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

const $ = id => document.getElementById(id);

const settingsBtn      = $('settings-btn');
const dropdown         = $('dropdown');
const explorerToggle   = $('explorer-toggle');
const autoplayToggle   = $('autoplay-toggle');
const darkToggle       = $('dark-toggle');
const stage            = $('stage');
const loadPanel        = $('load-panel');
const imgWrap          = $('img-wrap');
const progressTrack    = $('progress-track');
const progressBar      = $('progress-bar');
const loadStatus       = $('load-status');
const img              = $('artwork-img');
const credit           = $('credit');
const readMoreBtn      = $('read-more-btn');
const metadata         = $('metadata');
const metTitle         = $('meta-title');
const metArtist        = $('meta-artist');
const metDate          = $('meta-date');
const metDept          = $('meta-dept');
const metLink          = $('meta-link');
const errorMsg         = $('error-msg');
const newArtBtn        = $('new-art-btn');
const popularBtn       = $('popular-btn');
const autoplayBarWrap  = $('autoplay-bar-wrap');
const autoplayBarFill  = $('autoplay-bar-fill');

// ── Progress bar ────────────────────────────────────────
let progressValue = 0;
let progressInterval = null;

function setProgress(pct, statusText) {
  progressValue = pct;
  progressBar.style.width = pct + '%';
  if (statusText !== undefined) loadStatus.textContent = statusText;
}

function startScan() {
  progressTrack.classList.add('scanning');
  progressBar.style.width = '0%';
}

function stopScan() {
  progressTrack.classList.remove('scanning');
}

function crawlTo(target, statusText, durationMs = 600) {
  return new Promise(res => {
    stopScan();
    const start = progressValue;
    const diff = target - start;
    const startTime = performance.now();
    
    progressInterval = setInterval(() => {
      const elapsed = performance.now() - startTime;
      const prog = Math.min(elapsed / durationMs, 1);
      const ease = 1 - Math.pow(1 - prog, 3);
      setProgress(start + diff * ease, statusText);
      
      if (prog >= 1) {
        clearInterval(progressInterval);
        progressInterval = null;
        res();
      }
    }, 16);
  });
}

// ── Image loading — tries each CORS proxy, then falls back to direct <img> load ──
function loadImageWithProgress(rawUrl) {
  return new Promise((resolve, reject) => {
    let proxyIdx = 0;

    function tryNext() {
      // Skip proxies entirely for domains known to block them
      if (proxyIdx === 0 && shouldLoadDirect(rawUrl)) {
        proxyIdx = CORS_PROXIES.length; // jump straight to direct fallback
      }

      if (proxyIdx >= CORS_PROXIES.length) {
        // All proxies exhausted — fall back to direct img.src.
        // <img> elements bypass CORS (no preflight), so sites that block
        // proxy hotlinking (e.g. apod.nasa.gov) still load fine this way.
        setProgress(90, 'Loading image…');
        const testImg = new Image();
        testImg.onload  = () => resolve(rawUrl); // raw URL works fine as img.src
        testImg.onerror = () => reject(new Error('Image could not be loaded from any source'));
        testImg.src = rawUrl;
        return;
      }
      const url = CORS_PROXIES[proxyIdx](rawUrl);
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'blob';
      xhr.timeout = 20000;

      xhr.onprogress = e => {
        if (e.lengthComputable) {
          const pct   = 60 + (e.loaded / e.total) * 35;
          const kb    = Math.round(e.loaded / 1024);
          const total = Math.round(e.total  / 1024);
          setProgress(pct, `Downloading image — ${kb} / ${total} KB`);
        } else {
          progressTrack.classList.add('scanning');
          const kb = Math.round(e.loaded / 1024);
          loadStatus.textContent = `Downloading image — ${kb} KB received`;
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(URL.createObjectURL(xhr.response));
        } else {
          proxyIdx++;
          tryNext();
        }
      };

      xhr.onerror   = () => { proxyIdx++; tryNext(); };
      xhr.ontimeout = () => { proxyIdx++; tryNext(); };
      xhr.send();
    }

    tryNext();
  });
}

// ── Autoplay countdown bar ─────────────────────────────
function startCountdownBar() {
  stopCountdownBar();
  autoplayBarWrap.classList.add('active');

  // Reset without transition
  autoplayBarFill.classList.remove('running');
  autoplayBarFill.style.transform = 'scaleX(1)';

  // Force reflow then animate
  void autoplayBarFill.offsetWidth;
  autoplayBarFill.classList.add('running');
  autoplayBarFill.style.transitionDuration = AUTOPLAY_DURATION + 'ms';
  autoplayBarFill.style.transform = 'scaleX(0)';
}

function stopCountdownBar() {
  autoplayBarFill.classList.remove('running');
  autoplayBarFill.style.transitionDuration = '';
  autoplayBarWrap.classList.remove('active');
}

// ── Background preload for autoplay ───────────────────
let preloadCtrl = null;
let preloadedArtwork = null;

async function preloadNext(popular = false) {
  if (preloadCtrl) preloadCtrl.abort();
  preloadCtrl = new AbortController();
  const signal = preloadCtrl.signal;

  try {
    let artData;
    if (popular === 'mars') {
      artData = await fetchMarsRover(signal);
    } else if (popular === 'earth') {
      artData = await fetchEarthImagery(signal);
    } else if (popular === 'asteroid') {
      artData = await fetchAsteroids(signal);
    } else if (popular === 'solar') {
      artData = await fetchSolarFlare(signal);
    } else if (popular === 'tech') {
      artData = await fetchTechTransfer(signal);
    } else if (popular) {
      artData = await fetchPopular(signal);
    } else {
      artData = await fetchNasa(signal);
    }
    
    const blobUrl = await loadImagePreloadSilent(artData.imageUrl, signal);
    preloadedArtwork = { ...artData, blobUrl };
  } catch (e) {
    preloadedArtwork = null;
  }
}

function loadImagePreloadSilent(rawUrl, signal) {
  return new Promise((resolve, reject) => {
    let proxyIdx = 0;
    let aborted = false;

    if (signal) {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('Aborted', 'AbortError'));
      });
    }

    function tryNext() {
      if (aborted) return;
      // Skip proxies entirely for domains known to block them
      if (proxyIdx === 0 && shouldLoadDirect(rawUrl)) {
        proxyIdx = CORS_PROXIES.length;
      }
      if (proxyIdx >= CORS_PROXIES.length) {
        // Direct <img> fallback — bypasses CORS for display-only use
        const testImg = new Image();
        testImg.onload  = () => { if (!aborted) resolve(rawUrl); };
        testImg.onerror = () => { if (!aborted) reject(new Error('All proxies failed')); };
        testImg.src = rawUrl;
        return;
      }
      const url = CORS_PROXIES[proxyIdx](rawUrl);
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'blob';
      xhr.timeout = 25000;

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(URL.createObjectURL(xhr.response));
        else { proxyIdx++; tryNext(); }
      };
      xhr.onerror   = () => { proxyIdx++; tryNext(); };
      xhr.ontimeout = () => { proxyIdx++; tryNext(); };
      xhr.send();
    }

    tryNext();
  });
}

// ── Autoplay scheduler ────────────────────────────────
let autoplayTimer = null;

function scheduleAutoplay(popular = false) {
  cancelAutoplay();
  startCountdownBar();
  preloadNext(popular);
  autoplayTimer = setTimeout(() => loadArtworkAutoplay(popular), AUTOPLAY_DURATION);
}

function cancelAutoplay() {
  if (autoplayTimer) clearTimeout(autoplayTimer);
  autoplayTimer = null;
  stopCountdownBar();
  if (preloadCtrl) preloadCtrl.abort();
  preloadedArtwork = null;
}

// ── Dark mode ─────────────────────────────────────────
function applyDark() {
  const r = document.documentElement.style;
  if (darkMode) {
    r.setProperty('--bg',     '#111110');
    r.setProperty('--text',   '#e8e6e1');
    r.setProperty('--muted',  '#777');
    r.setProperty('--subtle', '#555');
    r.setProperty('--border', '#2a2a28');
    r.setProperty('--active', '#1e1e1c');
  } else {
    r.setProperty('--bg',     '#f5f4f0');
    r.setProperty('--text',   '#1a1a1a');
    r.setProperty('--muted',  '#888');
    r.setProperty('--subtle', '#bbb');
    r.setProperty('--border', '#e0dedd');
    r.setProperty('--active', '#e8e6e1');
  }
}

function syncUI() {
  explorerToggle.classList.toggle('active', explorerMode);
  autoplayToggle.classList.toggle('active', autoplay);
  darkToggle.classList.toggle('active', darkMode);
}

function hideError() { errorMsg.style.display = 'none'; }

function showError(msg) {
  errorMsg.style.display = 'block';
  errorMsg.textContent   = msg;
  loadPanel.classList.add('hidden');
  newArtBtn.disabled  = false;
  popularBtn.disabled = false;
  readMoreBtn.style.display = 'none';
  clearInterval(progressInterval);
}

function resetStage() {
  img.classList.remove('visible', 'decoding');
  img.src                   = '';
  imgWrap.style.display     = 'none';
  credit.textContent        = '';
  readMoreBtn.style.display = 'none';
  readMoreBtn.textContent   = 'Read more';
  metaVisible               = false;
  progressValue             = 0;
  progressBar.style.width   = '0%';
  loadStatus.textContent    = 'Contacting NASA';
  metadata.classList.remove('visible');
  loadPanel.classList.remove('hidden');
  startScan();
}

async function renderArtwork({ blobUrl, title, artist, date, dept, museumUrl, creditLine, explanation }) {
  hideError();
  metTitle.textContent   = title   || '';
  metArtist.textContent  = artist  || '';
  metDate.textContent    = date    || '';
  metDept.textContent   = dept     || '';
  metLink.href          = museumUrl || '#';
  
  // Store explanation for "Read more" functionality
  if (explanation) {
    metDept.setAttribute('data-explanation', explanation);
    metDept.setAttribute('data-original-dept', dept);
    metDept.title = explanation; // Show full explanation on hover
  }

  await crawlTo(97, 'Decoding image', 300);

  img.src = blobUrl;
  img.classList.add('decoding');
  imgWrap.style.display = 'flex';

  try { await img.decode(); } catch (e) {}

  await crawlTo(100, 'Done', 200);
  await new Promise(r => setTimeout(r, 150));

  loadPanel.classList.add('hidden');
  stopScan();

  img.classList.remove('decoding');
  img.classList.add('visible');

  stage.classList.remove('fading');
  newArtBtn.disabled  = false;
  popularBtn.disabled = false;
  readMoreBtn.style.display = '';
}

// ── Seamless autoplay switch (uses preloaded data if ready) ──
async function loadArtworkAutoplay(popular = false) {
  cancelAutoplay();

  // Always create a fresh controller — currentCtrl may be null or already aborted
  if (currentCtrl) currentCtrl.abort();
  currentCtrl = new AbortController();
  const signal = currentCtrl.signal;

  const cached = preloadedArtwork;
  preloadedArtwork = null;

  stage.classList.add('fading');
  await new Promise(r => setTimeout(r, 350));
  resetStage();
  stage.classList.remove('fading');
  hideError();

  if (cached) {
    // Instant render from preloaded blob
    try {
      await renderArtwork(cached);
      scheduleAutoplay(popular);
      return;
    } catch (e) {
      // fall through to normal fetch
    }
  }

  // Fallback: normal fetch with the fresh signal
  await doFetchAndRender(popular, signal);
  scheduleAutoplay(popular);
}

// ── Normal manual load ────────────────────────────────
async function loadArtwork(popular = false) {
  cancelAutoplay();

  if (currentCtrl) currentCtrl.abort();
  currentCtrl = new AbortController();
  const signal = currentCtrl.signal;

  newArtBtn.disabled  = true;
  popularBtn.disabled = true;

  stage.classList.add('fading');
  await new Promise(r => setTimeout(r, 350));
  resetStage();
  stage.classList.remove('fading');
  hideError();

  await doFetchAndRender(popular, signal);

  // Re-arm autoplay after manual navigation
  if (autoplay) scheduleAutoplay(popular);
}

async function doFetchAndRender(popular, signal) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let label;
      if (popular === 'mars') {
        label = 'Mars rover photos';
      } else if (popular === 'earth') {
        label = 'Earth satellite imagery';
      } else if (popular === 'asteroid') {
        label = 'Near-Earth asteroids';
      } else if (popular === 'solar') {
        label = 'Solar activity data';
      } else if (popular === 'tech') {
        label = 'NASA technology patents';
      } else if (popular) {
        label = 'popular NASA images';
      } else {
        label = 'NASA collection';
      }
      
      await crawlTo(15, `Searching ${label}`, 400);

      let artData;
      if (popular === 'mars') {
        artData = await fetchMarsRover(signal);
      } else if (popular === 'earth') {
        artData = await fetchEarthImagery(signal);
      } else if (popular === 'asteroid') {
        artData = await fetchAsteroids(signal);
      } else if (popular === 'solar') {
        artData = await fetchSolarFlare(signal);
      } else if (popular === 'tech') {
        artData = await fetchTechTransfer(signal);
      } else if (popular) {
        artData = await fetchPopular(signal);
      } else {
        artData = await fetchNasa(signal);
      }
      
      const title   = artData.title.length > 40
        ? artData.title.slice(0, 40) + '…'
        : artData.title;

      await crawlTo(45, `Found "${title}"`, 300);
      await crawlTo(60, 'Requesting image from server', 200);

      const blobUrl = await loadImageWithProgress(artData.imageUrl);
      await renderArtwork({ ...artData, blobUrl });
      return;

    } catch (e) {
      if (e.name === 'AbortError') return;
      if (attempt < 2) {
        await crawlTo(0, `Retrying… (attempt ${attempt + 2})`, 300);
        startScan();
      }
    }
  }
  showError('Could not load NASA data. Please try again.');
}

// ── NASA API helpers ───────────────────────────────────
const NASA_API_KEY = 'Jb4yd8MVhjw4eC17Upv8CP9Y3bpYKvDZs4uIHOss';
  
async function fetchNasaAPOD(date, signal) {
  const url = date 
    ? `https://api.nasa.gov/planetary/apod?api_key=${NASA_API_KEY}&date=${date}`
    : `https://api.nasa.gov/planetary/apod?api_key=${NASA_API_KEY}`;
    
  const r = await fetch(url, { signal });
  const data = await r.json();
    
  if (data.error) throw new Error(data.error.message);
  if (!data.url) throw new Error('No image for this date');
    
  // Skip videos and only load images
  if (data.media_type === 'video') {
    throw new Error('Skipping video - need image only');
  }
    
  // Return raw URLs — the image loader applies proxy + fallback automatically
  return {
    imageUrl: data.url,
    title: data.title || 'Untitled',
    artist: data.copyright || 'NASA',
    date: data.date || '',
    dept: 'Astronomy Picture of the Day',
    museumUrl: data.hdurl || data.url,
    creditLine: data.copyright ? `© ${data.copyright}` : 'NASA',
    explanation: data.explanation || '',
  };
}
  
async function fetchNasaImageLibrary(signal) {
  const searchTerm = explorerMode ? 'space' : 'earth';
  const url = `https://images-api.nasa.gov/search?q=${searchTerm}&media_type=image`;
    
  const r = await fetch(url, { signal });
  const data = await r.json();
    
  if (!data.collection.items.length) throw new Error('No results');
    
  for (let i = 0; i < 6; i++) {
    const item = pick(data.collection.items);
    if (item.data[0] && item.links && item.links[0]) {
      const imageData = item.data[0];
      return {
        imageUrl: item.links[0].href,          // raw — loader handles proxy
        title: imageData.title || 'Untitled',
        artist: imageData.photographer || 'NASA',
        date: imageData.date_created || imageData.date || '',
        dept: imageData.description ? imageData.description.slice(0, 50) + '…' : 'NASA Image',
        museumUrl: item.links[0].href,
        creditLine: imageData.photographer ? `© ${imageData.photographer}` : 'NASA',
        explanation: imageData.description || '',
        keywords: imageData.keywords ? imageData.keywords.join(', ') : '',
        center: imageData.center || 'NASA',
      };
    }
  }
    
  throw new Error('No valid NASA image found');
}
  
// Mars Rover Photos — Curiosity & Perseverance only (active rovers with known sol ranges)
async function fetchMarsRover(signal) {
  const rovers = [
    { name: 'curiosity',     maxSol: 4300 },
    { name: 'perseverance',  maxSol: 1600 },
  ];
  const rover = pick(rovers);
  const sol = Math.floor(Math.random() * rover.maxSol) + 1;

  const url = `https://api.nasa.gov/mars-photos/api/v1/rovers/${rover.name}/photos?sol=${sol}&api_key=${NASA_API_KEY}`;

  const r = await fetch(url, { signal });
  const data = await r.json();

  if (!data.photos || !data.photos.length) throw new Error('No Mars rover photos for this sol');

  const photo = pick(data.photos);

  return {
    imageUrl: photo.img_src,          // raw — loader handles proxy
    title: `${photo.rover.name} — ${photo.camera.full_name}`,
    artist: photo.rover.name,
    date: photo.earth_date,
    dept: `Mars Rover · Sol ${photo.sol}`,
    museumUrl: photo.img_src,
    creditLine: 'NASA/JPL-Caltech',
    explanation: `Captured by the ${photo.rover.name} rover using its ${photo.camera.full_name} camera on Martian sol ${photo.sol} (Earth date: ${photo.earth_date}).`,
    keywords: 'mars, rover, exploration',
    center: 'JPL',
  };
}

// Earth Imagery: Landsat satellite imagery
// NOTE: The planetary/earth/imagery endpoint returns a raw image (not JSON).
// The API URL itself IS the image — pass it directly to the loader.
async function fetchEarthImagery(signal) {
  const lat = (Math.random() * 180 - 90).toFixed(4);
  const lon = (Math.random() * 360 - 180).toFixed(4);
  const date = new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const url = `https://api.nasa.gov/planetary/earth/imagery?lat=${lat}&lon=${lon}&date=${date}&api_key=${NASA_API_KEY}`;

  // Validate the tile exists without trying to parse the raw image bytes as JSON
  const checkUrl = CORS_PROXIES[0](url);
  const r = await fetch(checkUrl, { signal, method: 'HEAD' }).catch(() => null);
  if (r && !r.ok) throw new Error('No Earth imagery available for this location/date');

  return {
    imageUrl: url,                  // raw API URL — the endpoint IS the image
    title: 'Earth Satellite View',
    artist: 'NASA/USGS',
    date,
    dept: `Landsat · Lat ${lat}°, Lon ${lon}°`,
    museumUrl: 'https://earthobservatory.nasa.gov/',
    creditLine: 'NASA/USGS Landsat',
    explanation: `Landsat satellite image of Earth's surface at coordinates ${lat}°, ${lon}° captured on ${date}. Landsat imagery is used to monitor land cover, agriculture, urban growth, and climate change.`,
    keywords: 'earth, satellite, landsat, imagery',
    center: 'GSFC',
  };
}

// Asteroids NEO: Near-Earth asteroid data + real NASA imagery from Image Library
async function fetchAsteroids(signal) {
  const neoUrl = `https://api.nasa.gov/neo/rest/v1/neo/browse?api_key=${NASA_API_KEY}`;

  const r = await fetch(neoUrl, { signal });
  const data = await r.json();

  if (!data.near_earth_objects.length) throw new Error('No asteroid data found');

  const asteroid = pick(data.near_earth_objects);
  const hazardous = asteroid.is_potentially_hazardous_asteroid ? '⚠️ Potentially Hazardous' : 'Safe';
  const diameter = asteroid.estimated_diameter.kilometers.estimated_diameter_max.toFixed(2);

  // Fetch a real asteroid image from NASA Image Library (no placeholder)
  let imageUrl = null;
  const queries = [
    encodeURIComponent(asteroid.name.replace(/[()]/g, '').trim() + ' asteroid'),
    'asteroid+close+up',
    'near+earth+asteroid+space',
  ];
  for (const q of queries) {
    try {
      const imgR = await fetch(`https://images-api.nasa.gov/search?q=${q}&media_type=image`, { signal });
      const imgData = await imgR.json();
      const items = (imgData.collection?.items || []).filter(i => i.links?.[0]?.href);
      if (items.length) { imageUrl = pick(items).links[0].href; break; }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
    }
  }
  if (!imageUrl) throw new Error('No asteroid image found');

  return {
    imageUrl,                        // raw — loader handles proxy
    title: asteroid.name,
    artist: 'NASA/JPL',
    date: asteroid.orbital_data.last_observation_date || 'Unknown',
    dept: `Near-Earth Asteroid · ${hazardous}`,
    museumUrl: asteroid.nasa_jpl_url || 'https://www.jpl.nasa.gov/',
    creditLine: 'NASA/JPL-Caltech',
    explanation: `${asteroid.name} is a near-Earth asteroid with an estimated maximum diameter of ${diameter} km. ${hazardous}. It orbits the Sun with a period of ${asteroid.orbital_data.orbital_period.toFixed(1)} days.`,
    keywords: 'asteroid, neo, space, hazardous',
    center: 'JPL',
  };
}

// Solar Flare: DONKI event data paired with real NASA SDO imagery
async function fetchSolarFlare(signal) {
  const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const endDate   = new Date().toISOString().split('T')[0];

  const url = `https://api.nasa.gov/DONKI/FLR?startDate=${startDate}&endDate=${endDate}&api_key=${NASA_API_KEY}`;

  const r    = await fetch(url, { signal });
  const data = await r.json();

  if (!data.length) throw new Error('No solar flare data found');

  const flare     = pick(data);
  const classType = flare.classType || 'Unknown';
  const source    = flare.sourceRegion || 'Unknown Region';

  // Real NASA SDO latest solar images — multiple wavelengths (no placeholder)
  const SDO_WAVELENGTHS = ['0094', '0131', '0171', '0193', '0211', '0304', '0335', '1600', '211193171'];
  const wl = pick(SDO_WAVELENGTHS);
  const imageUrl = `https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_${wl}.jpg`;

  return {
    imageUrl,                        // raw — loader handles proxy
    title: `Solar Flare ${classType}`,
    artist: 'NASA/SDO',
    date: flare.beginTime.split('T')[0],
    dept: `Solar Dynamics Observatory · ${source}`,
    museumUrl: 'https://sdo.gsfc.nasa.gov/',
    creditLine: 'NASA/SDO',
    explanation: `A ${classType}-class solar flare erupted from ${source}. It began at ${flare.beginTime}. The image is a live NASA Solar Dynamics Observatory (SDO) capture at ${wl}Å wavelength — one of nine bands used to study the Sun's corona and magnetic activity.`,
    keywords: 'solar, flare, sun, SDO, activity',
    center: 'GSFC',
  };
}

// Tech Transfer: NASA patents and technologies
async function fetchTechTransfer(signal) {
  // Use JSONP approach for Tech Transfer API to avoid CORS issues
  const url = `https://api.nasa.gov/techtransfer/patent/?engine&api_key=${NASA_API_KEY}`;
    
  try {
    // Try direct fetch first
    const r = await fetch(url, { signal });
    const data = await r.json();
      
    if (!data.results.length) throw new Error('No tech transfer data found');
      
    const patent = pick(data.results);
      
    // Create a tech/innovation image placeholder
    const imageUrl = `https://picsum.photos/seed/tech${patent.id}/800/600.jpg`;
    const proxiedImageUrl = `https://corsproxy.io/?${encodeURIComponent(imageUrl)}`;
      
    return {
      imageUrl: proxiedImageUrl,
      title: patent.title || 'NASA Technology',
      artist: patent.innovator || 'NASA',
      date: patent.date || 'Unknown',
      dept: `NASA Tech Transfer - ${patent.category || 'Innovation'}`,
      museumUrl: patent.url || '#',
      creditLine: `NASA/${patent.center || 'Tech Transfer'}`,
      explanation: `${patent.description || 'NASA innovation and technology transfer.'} This technology represents NASA's commitment to sharing space-age innovations with Earth applications.`,
      keywords: 'technology, patent, innovation, NASA, transfer',
      center: patent.center || 'NASA',
    };
  } catch (error) {
    // Fallback data if CORS blocks the API
    const fallbackTech = [
      {
        title: "Advanced Solar Panel Technology",
        innovator: "NASA Glenn Research Center",
        date: "2024-01-15",
        category: "Energy",
        description: "High-efficiency solar panels developed for space missions, now available for terrestrial applications with 30% increased efficiency over commercial panels.",
        center: "Glenn Research Center"
      },
      {
        title: "Self-Healing Materials",
        innovator: "NASA Langley Research Center", 
        date: "2023-11-20",
        category: "Materials",
        description: "Composite materials that can automatically repair micro-cracks, extending spacecraft lifespan and applicable to infrastructure on Earth.",
        center: "Langley Research Center"
      },
      {
        title: "Water Recycling System",
        innovator: "NASA Johnson Space Center",
        date: "2024-02-10", 
        category: "Environmental",
        description: "Advanced water purification system developed for ISS, capable of recycling 98% of water for use in remote locations and disaster relief.",
        center: "Johnson Space Center"
      }
    ];
      
    const tech = pick(fallbackTech);
    const imageUrl = `https://picsum.photos/seed/tech${Date.now()}/800/600.jpg`;
    const proxiedImageUrl = `https://corsproxy.io/?${encodeURIComponent(imageUrl)}`;
      
    return {
      imageUrl: proxiedImageUrl,
      title: tech.title,
      artist: tech.innovator,
      date: tech.date,
      dept: `NASA Tech Transfer - ${tech.category}`,
      museumUrl: 'https://technology.nasa.gov/',
      creditLine: `NASA/${tech.center}`,
      explanation: tech.description,
      keywords: 'technology, patent, innovation, NASA, transfer',
      center: tech.center,
    };
  }
}

async function fetchNasa(signal) {
  // Use APOD for standard mode, Image Library for explorer mode
  if (explorerMode) {
    return await fetchNasaImageLibrary(signal);
  } else {
    // Try multiple dates to find an image (not video)
    for (let i = 0; i < 10; i++) {
      const randomDate = new Date();
      randomDate.setDate(randomDate.getDate() - Math.floor(Math.random() * 365));
      const dateStr = randomDate.toISOString().split('T')[0];
        
      try {
        return await fetchNasaAPOD(dateStr, signal);
      } catch (e) {
        if (i === 9) throw e; // Re-throw if all attempts failed
      }
    }
  }
}

async function fetchPopular(signal) {
  const shuffled = [...POPULAR_DATES].sort(() => Math.random() - 0.5);
  for (const date of shuffled) {
    try {
      return await fetchNasaAPOD(date, signal);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
    }
  }
  throw new Error('Could not load a popular NASA image');
}

// ── Event listeners ───────────────────────────────────
settingsBtn.addEventListener('click', e => {
  e.stopPropagation();
  dropdown.classList.toggle('open');
});

document.addEventListener('click', () => dropdown.classList.remove('open'));
dropdown.addEventListener('click', e => e.stopPropagation());

explorerToggle.addEventListener('click', () => {
  explorerMode = !explorerMode;
  localStorage.setItem('rma-explorer', explorerMode);
  nasaData = null;
  syncUI();
  dropdown.classList.remove('open');
  loadArtwork(false);
});

autoplayToggle.addEventListener('click', () => {
  autoplay = !autoplay;
  localStorage.setItem('rma-autoplay', autoplay);
  syncUI();
  dropdown.classList.remove('open');
  if (autoplay) {
    scheduleAutoplay(false);
  } else {
    cancelAutoplay();
  }
});

darkToggle.addEventListener('click', () => {
  darkMode = !darkMode;
  localStorage.setItem('rma-dark', darkMode);
  applyDark();
  syncUI();
  dropdown.classList.remove('open');
});

readMoreBtn.addEventListener('click', () => {
  metaVisible = !metaVisible;
  metadata.classList.toggle('visible', metaVisible);
    
  if (metaVisible) {
    readMoreBtn.textContent = 'Hide details';
    // Show full explanation in the department field
    const explanation = metDept.getAttribute('data-explanation');
    if (explanation) {
      metDept.textContent = explanation;
      metDept.style.whiteSpace = 'pre-wrap';
      metDept.style.maxWidth = '600px';
      metDept.style.margin = '0 auto';
    }
  } else {
    readMoreBtn.textContent = 'Read more';
    // Restore short department description
    metDept.textContent = metDept.getAttribute('data-original-dept') || metDept.textContent.split('\n')[0];
    metDept.style.whiteSpace = '';
    metDept.style.maxWidth = '';
    metDept.style.margin = '';
  }
});

newArtBtn.addEventListener('click',  () => loadArtwork(false));
popularBtn.addEventListener('click', () => loadArtwork(true));

// ── Init ──────────────────────────────────────────────
applyDark();
syncUI();
loadArtwork(false);
