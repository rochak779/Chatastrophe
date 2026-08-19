import JSZip from 'jszip';
import '@fontsource-variable/bricolage-grotesque';
import { classifyMessage, parseTranscript, participantDisplayNames, summarize, TYPES } from './parser.js';
import './style.css';
import { inject } from '@vercel/analytics';

// Initialize Vercel Analytics
inject();

const labels = {
  text: 'Text', sticker: 'Stickers', gif: 'GIFs', image: 'Images', video: 'Videos',
  voiceNote: 'Voice notes', audio: 'Audio', document: 'Documents', unknownMedia: 'Unknown media',
};

document.querySelector('#app').innerHTML = `
  <nav class="nav">
    <a class="brand" href="#"><span>C</span> Chatastrophe</a>
    <div class="privacy-pill"><i></i> Local & private</div>
  </nav>
  <section class="hero">
    <div class="hero-copy">
      <h1>SEE THE<br><em>CHAOS.</em></h1>
      <p>Turn your WhatsApp chats into a playful recap. Find out who sends what.</p>
      <div class="privacy-note"><span>✓</span> Nothing gets uploaded. Ever.</div>
    </div>
    <div class="hero-side">
      <div class="hero-art" aria-hidden="true">
        <div class="chat-card card-one"><span class="card-emoji">😂</span><small>128×</small></div>
        <div class="chat-card card-two"><span class="card-emoji">🔥</span><small>Top reaction</small></div>
        <div class="chat-card card-three"><span class="card-emoji"><span class="gif-placeholder"><b>G</b><b>I</b><b>F</b></span></span><small>12 GIFs</small></div>
      </div>
      <label class="dropzone" id="dropzone">
        <input id="file" type="file" accept=".zip,.txt,text/plain,application/zip" />
        <span class="upload-icon">＋</span>
        <span class="drop-label"><strong>Drop your chats</strong><small>.zip works best</small></span>
      </label>
      <p class="status" id="status" aria-live="polite"></p>
    </div>
  </section>
  <section id="results" class="results" hidden></section>
  <footer><span>C</span> Chatastrophe · Built for group chat historians. No chat data leaves this page.</footer>
`;

const fileInput = document.querySelector('#file');
const dropzone = document.querySelector('#dropzone');
const status = document.querySelector('#status');
const results = document.querySelector('#results');
let activeObjectUrls = [];

document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('motion-paused', document.hidden);
});

dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('dragging'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragging');
  if (event.dataTransfer.files[0]) analyze(event.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => fileInput.files[0] && analyze(fileInput.files[0]));

async function readExport(file) {
  if (file.name.toLowerCase().endsWith('.txt')) return { text: await file.text(), mediaEntries: new Map(), groupTitle: '' };
  if (!file.name.toLowerCase().endsWith('.zip')) throw new Error('Please choose a .zip or .txt export.');
  const zip = await JSZip.loadAsync(file);
  const textFiles = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith('.txt'));
  if (!textFiles.length) throw new Error('No transcript (.txt) was found inside this ZIP.');
  const likelyChat = textFiles.find((entry) => /chat|whatsapp/i.test(entry.name)) ?? textFiles[0];
  const mediaEntries = new Map();
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || entry === likelyChat || entry.name.includes('__MACOSX/')) continue;
    mediaEntries.set(normalizeFilename(entry.name), entry);
  }
  const groupTitle = file.name
    .replace(/\.zip$/i, '')
    .replace(/^WhatsApp Chat (?:with\s+|-\s*)/i, '')
    .replace(/\s+\(\d+\)$/u, '')
    .trim();
  return { text: await likelyChat.async('string'), mediaEntries, groupTitle };
}

async function analyze(file) {
  status.textContent = `Reading ${file.name}…`;
  results.hidden = true;
  dropzone.classList.add('processing');
  fileInput.disabled = true;
  try {
    setHeroGif();
    revokeMediaUrls();
    const { text, mediaEntries, groupTitle } = await readExport(file);
    const messages = parseTranscript(text, { groupTitle });
    if (!messages.length) throw new Error('No messages were recognized. The export format may not be supported yet.');
    status.textContent = 'Preparing media previews…';
    const mediaByUser = await prepareMedia(messages, mediaEntries);
    setHeroGif(mediaByUser);
    render(summarize(messages), mediaByUser, buildMilestones(messages), messages.length, file.name);
    status.textContent = '';
  } catch (error) {
    status.textContent = error.message;
  } finally {
    dropzone.classList.remove('processing');
    fileInput.disabled = false;
  }
}

function setHeroGif(mediaByUser) {
  const container = document.querySelector('.card-three .card-emoji');
  if (!container) return;
  const gif = mediaByUser
    ? [...mediaByUser.values()].flat().find((item) => item.type === 'gif' && item.available)
    : null;
  if (!gif) {
    container.innerHTML = '<span class="gif-placeholder"><b>G</b><b>I</b><b>F</b></span>';
    return;
  }
  container.innerHTML = gif.filename.toLowerCase().endsWith('.gif')
    ? `<img class="hero-gif-media" src="${gif.url}" alt="">`
    : `<video class="hero-gif-media" src="${gif.url}" muted autoplay loop playsinline></video>`;
}

async function prepareMedia(messages, entries) {
  const mediaByUser = new Map();
  for (const message of messages) {
    const classification = classifyMessage(message.content);
    if (classification.type === 'text') continue;
    const item = { ...classification, date: message.date, time: message.time, url: '', available: false };
    const entry = classification.filename ? entries.get(normalizeFilename(classification.filename)) : null;
    if (entry) {
      const bytes = await entry.async('arraybuffer');
      const blob = new Blob([bytes], { type: mimeType(classification.filename) });
      item.url = URL.createObjectURL(blob);
      item.available = true;
      if (['sticker', 'gif'].includes(classification.type)) {
        item.fingerprint = await fingerprint(bytes, classification.filename);
      }
      activeObjectUrls.push(item.url);
    }
    if (!mediaByUser.has(message.sender)) mediaByUser.set(message.sender, []);
    mediaByUser.get(message.sender).push(item);
  }
  return mediaByUser;
}

function render(rows, mediaByUser, milestones, messageCount, filename) {
  const displayNames = participantDisplayNames(rows);
  const mediaCount = rows.reduce((sum, row) => sum + row.total - row.text, 0);
  const stickerCount = rows.reduce((sum, row) => sum + row.sticker, 0);
  const gifCount = rows.reduce((sum, row) => sum + row.gif, 0);
  const voiceCount = rows.reduce((sum, row) => sum + row.voiceNote, 0);
  results.innerHTML = `
    <nav class="result-nav"><a href="#overview">Overview</a><a href="#top-media">Top media</a><a href="#scoreboard">Scoreboard</a><a href="#participants">Participants</a></nav>
    <div class="results-kicker" id="overview"><span>YOUR REPLAY</span><p>${escapeHtml(filename)}</p></div>
    <div class="summary">
      <div class="stat stat-blue"><small>People in the chaos</small><span data-count="${rows.length}">${rows.length}</span><b>participants</b></div>
      <div class="stat stat-lime"><small>Total activity</small><span data-count="${messageCount}">${messageCount.toLocaleString()}</span><b>messages</b></div>
      <div class="stat stat-yellow"><small>Beyond the words</small><span data-count="${mediaCount}">${mediaCount.toLocaleString()}</span><b>media drops</b></div>
      <div class="stat stat-pink"><small>The essentials</small><span data-count="${stickerCount + gifCount + voiceCount}">${stickerCount + gifCount + voiceCount}</span><b>stickers · GIFs · voices</b></div>
    </div>
    <a class="scroll-cue" href="#top-media"><span>Scroll to explore</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v15m-6-6 6 6 6-6"/></svg></a>
    <div id="top-media">${stickerBoard(rows, mediaByUser)}</div>
    <section class="leaderboard-card" id="scoreboard">
      <div class="table-heading"><div><h2>The scoreboard</h2><p>Powered Entirely by Stickers</p></div><button id="csv">↓ Download CSV</button></div>
      <div class="leader-tabs">${[['total','All'],['sticker','Stickers'],['gif','GIFs'],['voiceNote','Voice'],['image','Images']].map(([type,label]) => `<button class="leader-tab ${type === 'total' ? 'active' : ''}" data-type="${type}">${label}</button>`).join('')}</div>
      <div id="leader-list" class="leader-list"></div>
      <button id="leader-more" class="outline-action"></button>
    </section>
    <section class="gallery-section" id="participants">
      <div class="section-heading"><div><h2>Everyone's drops</h2></div></div>
      <div id="participant-rail" class="participant-rail"></div>
      <div class="explorer-card">
        <div class="explorer-head"><div id="explorer-person"></div><div id="media-filters" class="media-filters"></div></div>
        <div id="explorer-grid" class="media-grid explorer-grid"></div>
        <button id="media-more" class="outline-action"></button>
      </div>
    </section>
    <dialog id="media-modal"><button class="modal-close" aria-label="Close">×</button><div id="modal-content"></div></dialog>`;
  results.hidden = false;
  document.querySelector('#csv').addEventListener('click', (event) => {
    downloadCsv(rows);
    acknowledgeDownload(event.currentTarget);
  });
  setupLeaderboard(rows, displayNames, mediaByUser, milestones);
  setupParticipantExplorer(rows, mediaByUser, displayNames);
  setupResultNavigation();
  playReplayUnlock(rows, mediaByUser, messageCount);
}

function moveToReplay() {
  const overview = document.querySelector('#overview');
  if (!overview) return;
  const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  requestAnimationFrame(() => overview.scrollIntoView({ behavior, block: 'start' }));
}

function playReplayUnlock(rows, mediaByUser, messageCount) {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('[data-count]').forEach((element) => {
    const target = Number(element.dataset.count);
    if (reduceMotion) {
      element.textContent = target.toLocaleString();
      return;
    }
    const started = performance.now();
    const duration = 720;
    const tick = (now) => {
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - progress, 4);
      element.textContent = Math.round(target * eased).toLocaleString();
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  if (reduceMotion) {
    moveToReplay();
    return;
  }

  const visualItems = rows.flatMap((row) => mediaByUser.get(row.sender) ?? [])
    .filter((item) => ['sticker', 'gif'].includes(item.type) && item.available)
    .slice(0, 3);
  const moment = document.createElement('div');
  moment.className = 'unlock-moment';
  moment.setAttribute('role', 'status');
  moment.innerHTML = `<div class="unlock-copy"><small>${messageCount.toLocaleString()} messages decoded</small><strong>Replay unlocked</strong></div>${visualItems.map((item, index) => `<div class="unlock-media unlock-${index + 1}">${wallMedia(item)}</div>`).join('')}`;
  document.body.append(moment);
  moment.addEventListener('animationend', (event) => {
    if (event.animationName === 'unlock-leaves') {
      moment.remove();
      moveToReplay();
    }
  });
}

function acknowledgeDownload(button) {
  const original = button.textContent;
  button.textContent = 'Saved locally ✓';
  button.classList.add('confirmed');
  setTimeout(() => {
    button.textContent = original;
    button.classList.remove('confirmed');
  }, 1600);
}

function setupLeaderboard(rows, displayNames, mediaByUser, milestones) {
  let category = 'total';
  let expanded = false;
  const list = document.querySelector('#leader-list');
  const more = document.querySelector('#leader-more');
  const draw = () => {
    const sorted = [...rows].sort((a, b) => b[category] - a[category] || b.total - a.total);
    const shown = expanded ? sorted : sorted.slice(0, 5);
    const max = Math.max(1, sorted[0]?.[category] ?? 1);
    list.innerHTML = shown.map((row, index) => {
      const hasMedia = (mediaByUser.get(row.sender) ?? []).length > 0;
      return `<button type="button" class="leader-row" data-sender="${escapeHtml(row.sender)}" ${hasMedia ? `aria-label="View ${escapeHtml(displayNames.get(row.sender))}'s media"` : 'disabled title="No media to preview"'}>
      <b>${index + 1}</b><span class="avatar">${escapeHtml(initials(displayNames.get(row.sender)))}</span>
      <strong>${escapeHtml(displayNames.get(row.sender))}</strong>
      <span class="leader-bar"><i style="width:${Math.max(3, row[category] / max * 100)}%"></i></span>
      <em>${row[category].toLocaleString()}</em>
      ${milestoneMarkup(milestones.get(row.sender))}
    </button>`;
    }).join('');
    more.hidden = rows.length <= 5;
    more.textContent = expanded ? 'Show top 5' : `View all ${rows.length}`;
  };
  document.querySelectorAll('.leader-tab').forEach((button) => button.addEventListener('click', () => {
    category = button.dataset.type;
    expanded = false;
    document.querySelectorAll('.leader-tab').forEach((tab) => tab.classList.toggle('active', tab === button));
    draw();
  }));
  more.addEventListener('click', () => { expanded = !expanded; draw(); });
  list.addEventListener('click', (event) => {
    const row = event.target.closest('.leader-row[data-sender]');
    if (!row || row.disabled) return;
    openParticipant(row.dataset.sender);
  });
  draw();
}

function buildMilestones(messages) {
  const milestones = new Map();
  for (const message of messages) {
    const type = classifyMessage(message.content).type;
    if (!['text', 'sticker', 'gif'].includes(type)) continue;
    if (!milestones.has(message.sender)) milestones.set(message.sender, {});
    const participant = milestones.get(message.sender);
    if (!participant[type]) participant[type] = formatChatDate(message.date);
  }
  return milestones;
}

function milestoneMarkup(milestone = {}) {
  const items = [
    ['💬', 'First text', milestone.text],
    ['🏷️', 'First sticker', milestone.sticker],
    ['🎞️', 'First GIF', milestone.gif],
  ];
  return `<span class="leader-milestones">${items.map(([emoji, label, date]) => `<span><i aria-hidden="true">${emoji}</i><b>${label}</b> ${escapeHtml(date || '—')}</span>`).join('')}</span>`;
}

function formatChatDate(value) {
  const parts = value.split(/[/.\-]/).map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return value;
  let [first, second, third] = parts;
  let day;
  let month;
  let year;
  if (first > 31) [year, month, day] = [first, second, third];
  else if (second > 12) [month, day, year] = [first, second, third];
  else [day, month, year] = [first, second, third];
  if (year < 100) year += 2000;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(date);
}

function openParticipant(sender) {
  const chip = [...document.querySelectorAll('.participant-chip')].find((item) => item.dataset.sender === sender);
  if (!chip) return;
  chip.click();
  const section = document.querySelector('#participants');
  const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  section.scrollIntoView({ behavior, block: 'start' });
  document.querySelectorAll('.result-nav a').forEach((link) => link.classList.toggle('active', link.getAttribute('href') === '#participants'));
}

function setupParticipantExplorer(rows, mediaByUser, displayNames) {
  const people = rows.filter((row) => (mediaByUser.get(row.sender) ?? []).length);
  if (!people.length) {
    document.querySelector('.explorer-card').innerHTML = '<p class="explorer-empty">No media records were found in this export.</p>';
    return;
  }
  let activeSender = people[0].sender;
  let activeType = 'all';
  let expanded = false;
  const rail = document.querySelector('#participant-rail');
  const filters = document.querySelector('#media-filters');
  const grid = document.querySelector('#explorer-grid');
  const person = document.querySelector('#explorer-person');
  const more = document.querySelector('#media-more');

  rail.innerHTML = people.map((row, index) => `<button class="participant-chip ${index === 0 ? 'active' : ''}" data-sender="${escapeHtml(row.sender)}"><span class="avatar">${escapeHtml(initials(displayNames.get(row.sender)))}</span>${escapeHtml(displayNames.get(row.sender))}</button>`).join('');

  const draw = () => {
    const row = rows.find((item) => item.sender === activeSender);
    const rawItems = mediaByUser.get(activeSender) ?? [];
    const allItems = deduplicateParticipantMedia(rawItems);
    const availableTypes = TYPES.filter((type) => type !== 'text' && rawItems.some((item) => item.type === type));
    if (activeType !== 'all' && !availableTypes.includes(activeType)) activeType = 'all';
    filters.innerHTML = [`<button class="media-filter ${activeType === 'all' ? 'active' : ''}" data-type="all">All <b>${rawItems.length}</b></button>`, ...availableTypes.map((type) => `<button class="media-filter ${activeType === type ? 'active' : ''}" data-type="${type}">${labels[type]} <b>${row[type]}</b></button>`)].join('');
    let filtered = activeType === 'all' ? allItems : allItems.filter((item) => item.type === activeType);
    if (['sticker', 'gif'].includes(activeType)) {
      filtered = filtered
        .map((item, originalIndex) => ({ item, originalIndex }))
        .sort((a, b) => b.item.duplicateCount - a.item.duplicateCount || a.originalIndex - b.originalIndex)
        .map(({ item }) => item);
    }
    const shown = expanded ? filtered : filtered.slice(0, 8);
    const sentCount = activeType === 'all' ? rawItems.length : row[activeType];
    person.innerHTML = `<span class="avatar">${escapeHtml(initials(displayNames.get(activeSender)))}</span><div><strong>${escapeHtml(displayNames.get(activeSender))}</strong><small>${sentCount} ${activeType === 'all' ? 'media items' : labels[activeType].toLowerCase()}</small></div>`;
    grid.innerHTML = shown.map((item, index) => mediaTile(item, index)).join('');
    more.hidden = filtered.length <= 8;
    more.textContent = expanded ? 'Show less' : `Show ${filtered.length - 8} more`;
    filters.querySelectorAll('.media-filter').forEach((button) => button.addEventListener('click', () => { activeType = button.dataset.type; expanded = false; draw(); }));
    grid.querySelectorAll('.media-tile[data-previewable="true"]').forEach((tile) => tile.addEventListener('click', (event) => {
      if (event.target.closest('audio, video[controls], a')) return;
      openMediaModal(shown[Number(tile.dataset.index)]);
    }));
  };
  rail.querySelectorAll('.participant-chip').forEach((button) => button.addEventListener('click', () => {
    activeSender = button.dataset.sender;
    activeType = 'all';
    expanded = false;
    rail.querySelectorAll('.participant-chip').forEach((chip) => chip.classList.toggle('active', chip === button));
    draw();
  }));
  more.addEventListener('click', () => { expanded = !expanded; draw(); });
  draw();
}

function setupResultNavigation() {
  document.querySelectorAll('.result-nav a').forEach((link) => link.addEventListener('click', () => {
    document.querySelectorAll('.result-nav a').forEach((item) => item.classList.toggle('active', item === link));
  }));
}

function stickerBoard(rows, mediaByUser) {
  const media = rows.flatMap((row) => (mediaByUser.get(row.sender) ?? []))
    .filter((item) => ['sticker', 'gif'].includes(item.type) && item.available);
  const ranked = new Map();
  for (const item of media) {
    const key = item.fingerprint || normalizeFilename(item.filename);
    const existing = ranked.get(key);
    if (existing) existing.count += 1;
    else ranked.set(key, { ...item, count: 1 });
  }
  const topMedia = [...ranked.values()].sort((a, b) => b.count - a.count).slice(0, 8);
  if (!topMedia.length) return `<section class="sticker-board empty-board"><div><h2>Sticker Board</h2><p>No previewable stickers or GIFs were found. Export again with “Include media” to build the wall.</p></div></section>`;
  const colors = ['aqua', 'purple', 'pink', 'orange', 'lime', 'cream'];
  return `<section class="sticker-section">
    <div class="sticker-heading"><div><h2>Sticker Board</h2></div></div>
    <div class="sticker-frame"><div class="sticker-board">${topMedia.map((item, index) => `<article class="sticker-cell ${colors[index % colors.length]}">${wallMedia(item)}${item.count > 1 ? `<b class="use-count">×${item.count}</b>` : ''}</article>`).join('')}</div></div>
  </section>`;
}

function wallMedia(item) {
  if (item.type === 'gif' && !item.filename.toLowerCase().endsWith('.gif')) {
    return `<video src="${item.url}" muted autoplay loop playsinline aria-label="Popular GIF"></video>`;
  }
  return `<img src="${item.url}" alt="Popular ${item.type}" loading="lazy">`;
}

function mediaTile(item, index = 0) {
  const name = escapeHtml(item.filename || labels[item.type]);
  let preview;
  if (!item.available) {
    preview = `<div class="missing"><span>File unavailable</span><small>Export with media to preview</small></div>`;
  } else if (['sticker', 'image'].includes(item.type) || (item.type === 'gif' && item.filename.toLowerCase().endsWith('.gif'))) {
    preview = `<img src="${item.url}" alt="${name}" loading="lazy">`;
  } else if (['gif', 'video'].includes(item.type)) {
    preview = `<video src="${item.url}" controls muted playsinline ${item.type === 'gif' ? 'autoplay loop' : ''}></video>`;
  } else if (['voiceNote', 'audio'].includes(item.type)) {
    preview = `<div class="audio-preview"><span>♪</span><audio src="${item.url}" controls preload="none"></audio></div>`;
  } else {
    preview = `<a class="document-preview" href="${item.url}" download="${name}"><span>↓</span><strong>Download file</strong></a>`;
  }
  const previewable = item.available && ['sticker', 'gif', 'image', 'video'].includes(item.type);
  return `<article class="media-tile" data-index="${index}" data-previewable="${previewable}"><div class="preview ${item.type}">${preview}${item.duplicateCount > 1 ? `<b class="media-count">×${item.duplicateCount}</b>` : ''}</div><div class="media-meta"><span>${labels[item.type]}</span><time>${escapeHtml(item.date)} · ${escapeHtml(item.time)}</time></div></article>`;
}

function deduplicateParticipantMedia(items) {
  const result = [];
  const repeatedMedia = new Map();
  for (const item of items) {
    if (!['sticker', 'gif'].includes(item.type)) {
      result.push({ ...item, duplicateCount: 1 });
      continue;
    }
    const identity = item.fingerprint || (item.filename ? normalizeFilename(item.filename) : '');
    if (!identity) {
      result.push({ ...item, duplicateCount: 1 });
      continue;
    }
    const key = `${item.type}:${identity}`;
    const existing = repeatedMedia.get(key);
    if (existing) {
      existing.duplicateCount += 1;
    } else {
      const uniqueItem = { ...item, duplicateCount: 1 };
      repeatedMedia.set(key, uniqueItem);
      result.push(uniqueItem);
    }
  }
  return result;
}

function openMediaModal(item) {
  if (!item?.available) return;
  const modal = document.querySelector('#media-modal');
  const content = document.querySelector('#modal-content');
  content.innerHTML = ['gif', 'video'].includes(item.type) && !item.filename.toLowerCase().endsWith('.gif')
    ? `<video src="${item.url}" controls autoplay ${item.type === 'gif' ? 'loop' : ''} playsinline></video>`
    : `<img src="${item.url}" alt="${escapeHtml(labels[item.type])}">`;
  modal.showModal();
  modal.querySelector('.modal-close').onclick = () => modal.close();
  modal.onclick = (event) => { if (event.target === modal) modal.close(); };
}

function normalizeFilename(value) {
  const decoded = value.split('/').pop().replace(/[\u200e\u200f]/g, '').trim();
  try { return decodeURIComponent(decoded).toLowerCase(); } catch { return decoded.toLowerCase(); }
}

function mimeType(filename) {
  const extension = filename.split('.').pop().toLowerCase();
  return ({
    webp: 'image/webp', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic',
    mp4: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp', opus: 'audio/ogg; codecs=opus', ogg: 'audio/ogg',
    m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', pdf: 'application/pdf', zip: 'application/zip',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  })[extension] ?? 'application/octet-stream';
}

async function fingerprint(bytes, fallback) {
  if (!globalThis.crypto?.subtle) return normalizeFilename(fallback);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function initials(name) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0] ?? '').join('').toUpperCase();
}

function revokeMediaUrls() {
  activeObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  activeObjectUrls = [];
}

function downloadCsv(rows) {
  const columns = ['sender', 'total', ...TYPES];
  const csv = [columns, ...rows.map((row) => columns.map((column) => row[column]))]
    .map((line) => line.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','))
    .join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  link.download = 'whatsapp-group-metrics.csv';
  link.click();
  URL.revokeObjectURL(link.href);
}

function escapeHtml(value) {
  const node = document.createElement('div');
  node.textContent = value;
  return node.innerHTML;
}
