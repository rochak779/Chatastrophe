const START_PATTERNS = [
  /^\[(?<date>\d{1,4}[/.\-]\d{1,2}[/.\-]\d{1,4}),?\s+(?<time>\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]m)?)\]\s(?<body>.*)$/i,
  /^(?<date>\d{1,4}[/.\-]\d{1,2}[/.\-]\d{1,4}),?\s+(?<time>\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]m)?)\s[-–]\s(?<body>.*)$/i,
];

const FILE_PATTERN = /(?:<attached:\s*)?([^<>\n]*?\.(?:webp|gif|jpe?g|png|heic|mp4|mov|3gp|opus|ogg|m4a|mp3|wav|pdf|docx?|xlsx?|pptx?|zip))(?:>)?/i;

export const TYPES = ['text', 'sticker', 'gif', 'image', 'video', 'voiceNote', 'audio', 'document', 'unknownMedia'];

function parseStart(line) {
  for (const pattern of START_PATTERNS) {
    const match = line.replace(/^\u200e/, '').match(pattern);
    if (match) return match.groups;
  }
  return null;
}

function splitSender(body) {
  const separator = body.indexOf(': ');
  if (separator < 1) return null;
  return { sender: body.slice(0, separator).trim(), content: body.slice(separator + 2) };
}

export function parseTranscript(text) {
  const messages = [];
  let current = null;

  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const start = parseStart(rawLine);
    if (start) {
      if (current) messages.push(current);
      const senderContent = splitSender(start.body);
      current = senderContent ? { ...senderContent, date: start.date, time: start.time } : null;
    } else if (current) {
      current.content += `\n${rawLine}`;
    }
  }
  if (current) messages.push(current);
  return messages;
}

export function classifyMessage(content) {
  const lower = content.toLowerCase();
  const filename = content.match(FILE_PATTERN)?.[1]?.trim() ?? '';
  const file = filename.toLowerCase();

  if (/\bstk[-_]|\.webp$/.test(file) || /<sticker omitted>|sticker omitted/.test(lower)) return { type: 'sticker', filename };
  if (/\bgif[-_]|\.gif$/.test(file) || /gif omitted/.test(lower)) return { type: 'gif', filename };
  if (/\bptt[-_]|voice message omitted|voice note omitted/.test(lower) || /\bptt[-_]/.test(file)) return { type: 'voiceNote', filename };
  if (/\bimg[-_]|\.(jpe?g|png|heic)$/.test(file) || /image omitted|photo omitted/.test(lower)) return { type: 'image', filename };
  if (/\bvid[-_]|\.(mp4|mov|3gp)$/.test(file) || /video omitted/.test(lower)) return { type: 'video', filename };
  if (/\baud[-_]|\.(opus|ogg|m4a|mp3|wav)$/.test(file) || /audio omitted/.test(lower)) return { type: 'audio', filename };
  if (/\.(pdf|docx?|xlsx?|pptx?|zip)$/.test(file) || /document omitted/.test(lower)) return { type: 'document', filename };
  if (/media omitted/.test(lower)) return { type: 'unknownMedia', filename };
  return { type: 'text', filename: '' };
}

export function summarize(messages) {
  const users = new Map();
  for (const message of messages) {
    if (!users.has(message.sender)) users.set(message.sender, Object.fromEntries(TYPES.map((type) => [type, 0])));
    users.get(message.sender)[classifyMessage(message.content).type] += 1;
  }
  return [...users.entries()]
    .map(([sender, counts]) => ({ sender, ...counts, total: Object.values(counts).reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total || a.sender.localeCompare(b.sender));
}

export function participantDisplayNames(rows) {
  const parsedNames = rows.map((row) => parseParticipantName(row.sender));
  const firstNameCounts = new Map();
  for (const name of parsedNames) {
    const key = name.first.toLocaleLowerCase();
    firstNameCounts.set(key, (firstNameCounts.get(key) ?? 0) + 1);
  }
  return new Map(rows.map((row, index) => {
    const name = parsedNames[index];
    const hasCollision = firstNameCounts.get(name.first.toLocaleLowerCase()) > 1;
    return [row.sender, hasCollision && name.last ? `${name.first} ${name.last}` : name.first];
  }));
}

function parseParticipantName(sender) {
  const cleaned = sender
    .replace(/^[~\s\u00a0\u202f]+/u, '')
    .replace(/\s*\([^)]*\)\s*/gu, ' ')
    .trim();
  const nameParts = cleaned
    .split(/\s+/u)
    .filter((part) => /[\p{L}\p{N}]/u.test(part) && !/^[-–—]+$/u.test(part));
  if (!nameParts.length) return { first: cleaned || 'Unknown', last: '' };
  return { first: nameParts[0], last: nameParts.length > 1 ? nameParts.at(-1) : '' };
}
