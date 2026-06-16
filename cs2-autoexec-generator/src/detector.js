/**
 * CS2 Steam Account Detector
 * ===========================
 * Scans Steam's userdata/ folder using the File System Access API (browser)
 * or Node.js fs module (CLI/Electron/Tauri) — no API key required.
 *
 * Strategy:
 *   1. Find all numeric folders in Steam/userdata/  → each is a SteamID3
 *   2. For each folder, check if subfolder 730/ exists  → CS2 data present
 *   3. Read localconfig.vdf  → extract display name, last played
 *   4. Inventory which CS2 config files are present
 *   5. Return sorted account list (CS2 first, then by last played desc)
 *
 * SteamID math (no API needed):
 *   SteamID64 = 76561197960265728 + SteamID3_numeric
 *   folder name in userdata/ = SteamID3_numeric
 *
 * Default Steam install paths by OS:
 *   Windows : C:\Program Files (x86)\Steam
 *   Linux   : ~/.local/share/Steam
 *   macOS   : ~/Library/Application Support/Steam
 */

// ─────────────────────────────────────────────
// STEAMID UTILITIES
// ─────────────────────────────────────────────

const SteamID = {
  UNIVERSE_OFFSET: 76561197960265728n,

  fromSteamID64(id64) {
    return Number(BigInt(id64) - this.UNIVERSE_OFFSET);
  },
  toSteamID64(id3) {
    return String(BigInt(id3) + this.UNIVERSE_OFFSET);
  },
  toSteamIDString(id3) {
    const w = id3 & 1;
    const v = (id3 - w) / 2;
    return `STEAM_0:${w}:${v}`;
  },

  /** Accepts any Steam ID format → { id3, id3Formatted, id64, steamIdString, folderName } */
  parse(input) {
    input = String(input).trim();
    let id3 = null;

    if (/^765\d{14}$/.test(input)) {
      id3 = this.fromSteamID64(input);
    } else if (/^\[U:1:(\d+)\]$/.test(input)) {
      id3 = parseInt(input.match(/\[U:1:(\d+)\]/)[1]);
    } else if (/^STEAM_\d:\d:\d+$/.test(input)) {
      const parts = input.split(':'); // ['STEAM_0', 'W', 'V']
      id3 = parseInt(parts[2]) * 2 + parseInt(parts[1]);
    } else if (/^\d{1,15}$/.test(input)) {
      id3 = parseInt(input);
    }

    if (id3 === null || isNaN(id3)) return null;

    return {
      id3,
      id3Formatted: `[U:1:${id3}]`,
      id64: this.toSteamID64(id3),
      steamIdString: this.toSteamIDString(id3),
      folderName: String(id3),
    };
  },
};


// ─────────────────────────────────────────────
// MINIMAL VDF PARSER  (for localconfig.vdf)
// ─────────────────────────────────────────────

function parseVDFSimple(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '/' && src[i+1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '{') { tokens.push('OPEN');  i++; continue; }
    if (ch === '}') { tokens.push('CLOSE'); i++; continue; }
    if (ch === '"') {
      let s = ''; i++;
      while (i < src.length) {
        if (src[i] === '\\' && i+1 < src.length) { s += src[i+1]; i += 2; continue; }
        if (src[i] === '"') { i++; break; }
        s += src[i++];
      }
      tokens.push(s);
    } else {
      let w = '';
      while (i < src.length && !/[\s{}"\/]/.test(src[i])) w += src[i++];
      if (w) tokens.push(w);
    }
  }

  let pos = 0;
  function parseObj() {
    const obj = {};
    while (pos < tokens.length) {
      if (tokens[pos] === 'CLOSE') { pos++; return obj; }
      const key = tokens[pos++];
      if (pos >= tokens.length) break;
      if (tokens[pos] === 'OPEN') { pos++; obj[key] = parseObj(); }
      else obj[key] = tokens[pos++];
    }
    return obj;
  }

  const root = {};
  while (pos < tokens.length) {
    if (tokens[pos] === 'OPEN' || tokens[pos] === 'CLOSE') { pos++; continue; }
    const key = tokens[pos++];
    if (pos >= tokens.length) break;
    if (tokens[pos] === 'OPEN') { pos++; root[key] = parseObj(); }
    else root[key] = tokens[pos++];
  }
  return root;
}


// ─────────────────────────────────────────────
// LOCALCONFIG.VDF EXTRACTOR
// ─────────────────────────────────────────────

/**
 * localconfig.vdf structure (simplified):
 * "UserLocalConfigStore"
 * {
 *   "friends"   { "PersonaName" "Kepler420" }
 *   "apptickets"
 *   {
 *     "730" { "LastPlayed" "1700000000" }   ← CS2 = app 730
 *   }
 *   "Software"
 *   {
 *     "Valve" { "Steam" { "language" "english" } }
 *   }
 * }
 */
function extractLocalConfig(content) {
  if (!content) return {};

  let parsed;
  try { parsed = parseVDFSimple(content); } catch { return {}; }

  const result = { personaName: null, lastPlayed: null, hasCS2: false, language: null };

  function walk(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 8) return;
    for (const [k, v] of Object.entries(obj)) {
      const lk = k.toLowerCase();
      if (lk === 'personaname' && typeof v === 'string') result.personaName = v;
      if (lk === 'language' && typeof v === 'string' && !result.language) result.language = v;
      if (k === '730' && typeof v === 'object') {
        result.hasCS2 = true;
        const lp = v['LastPlayed'] || v['lastplayed'];
        if (lp) result.lastPlayed = new Date(parseInt(lp) * 1000);
      }
      if (typeof v === 'object') walk(v, depth + 1);
    }
  }

  walk(parsed);
  return result;
}


// ─────────────────────────────────────────────
// CS2 CONFIG FILE RELATIVE PATHS
// ─────────────────────────────────────────────

const CS2_CONFIG_FILES = {
  userConvars:    'local/cfg/cs2_user_convars_0_slot0.vcfg',
  machineConvars: 'local/cfg/cs2_machine_convars.vcfg',
  userKeys:       'local/cfg/cs2_user_keys_0_slot0.vcfg',
  videoTxt:       'local/cfg/cs2_video.txt',
  userConvarsSlot1: 'local/cfg/cs2_user_convars_0_slot1.vcfg',
  userKeysSlot1:    'local/cfg/cs2_user_keys_0_slot1.vcfg',
};

const LOCALCONFIG_PATHS = ['config/localconfig.vdf', '7/remote/localconfig.vdf'];


// ─────────────────────────────────────────────
// DEFAULT STEAM PATHS  (by OS)
// ─────────────────────────────────────────────

function getHomeDir() {
  if (typeof process !== 'undefined' && process.env) {
    return process.env.HOME || process.env.USERPROFILE || '~';
  }
  return '~';
}

function getDefaultSteamPaths() {
  let platform = 'unknown';
  if (typeof process !== 'undefined') {
    platform = process.platform;
  } else if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('win')) platform = 'win32';
    else if (ua.includes('linux')) platform = 'linux';
    else if (ua.includes('mac')) platform = 'darwin';
  }

  const home = getHomeDir();
  const pathsByOS = {
    win32: [
      'C:\\Program Files (x86)\\Steam',
      'C:\\Program Files\\Steam',
      'D:\\Steam',
      'D:\\Program Files (x86)\\Steam',
      'E:\\Steam',
    ],
    linux: [
      `${home}/.local/share/Steam`,
      `${home}/.steam/steam`,
      `${home}/.steam/Steam`,
    ],
    darwin: [
      `${home}/Library/Application Support/Steam`,
    ],
  };

  return { platform, candidates: pathsByOS[platform] || [] };
}


// ─────────────────────────────────────────────
// NODE.JS DETECTOR
// ─────────────────────────────────────────────

async function detectAccountsNode(steamPath) {
  const { default: fs } = await import('fs/promises');
  const { default: path } = await import('path');
  const { candidates } = getDefaultSteamPaths();
  const searchPaths = steamPath ? [steamPath, ...candidates] : candidates;

  // Find Steam installation
  let steamRoot = null;
  for (const candidate of searchPaths) {
    try {
      await fs.access(path.join(candidate, 'userdata'));
      steamRoot = candidate;
      break;
    } catch { /* not found */ }
  }

  if (!steamRoot) {
    return {
      ok: false,
      error: 'Steam installation not found. Pass your Steam path manually.',
      accounts: [],
      cs2Accounts: [],
      steamRoot: null,
    };
  }

  const userdataPath = path.join(steamRoot, 'userdata');
  let entries;
  try { entries = await fs.readdir(userdataPath); }
  catch { return { ok: false, error: `Cannot read ${userdataPath}`, accounts: [], cs2Accounts: [], steamRoot }; }

  const accounts = [];

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const steamIdInfo = SteamID.parse(entry);
    if (!steamIdInfo) continue;

    const accountPath  = path.join(userdataPath, entry);
    const cs2Path      = path.join(accountPath, '730');

    const account = {
      ...steamIdInfo,
      steamRoot,
      accountPath,
      cs2Path,
      hasCS2: false,
      configFiles: {},
      profile: { personaName: `Account ${entry}`, lastPlayed: null, language: null, hasCS2: false },
    };

    // Check CS2 folder
    try { await fs.access(cs2Path); account.hasCS2 = true; } catch { /* absent */ }

    // Read localconfig.vdf for display name
    for (const lcPath of LOCALCONFIG_PATHS) {
      try {
        const content = await fs.readFile(path.join(accountPath, lcPath), 'utf8');
        const profile = extractLocalConfig(content);
        if (profile.personaName || profile.lastPlayed) {
          account.profile = { ...account.profile, ...profile };
          break;
        }
      } catch { /* try next */ }
    }

    // Inventory CS2 config files
    if (account.hasCS2) {
      for (const [key, relPath] of Object.entries(CS2_CONFIG_FILES)) {
        try {
          await fs.access(path.join(cs2Path, relPath));
          account.configFiles[key] = path.join(cs2Path, relPath);
        } catch { /* absent */ }
      }
    }

    accounts.push(account);
  }

  accounts.sort((a, b) => {
    if (a.hasCS2 !== b.hasCS2) return a.hasCS2 ? -1 : 1;
    return (b.profile.lastPlayed?.getTime() ?? 0) - (a.profile.lastPlayed?.getTime() ?? 0);
  });

  return { ok: true, error: null, steamRoot, userdataPath, accounts, cs2Accounts: accounts.filter(a => a.hasCS2) };
}

async function readCS2ConfigsNode(account) {
  const { default: fs } = await import('fs/promises');
  const files = {};
  for (const [key, fullPath] of Object.entries(account.configFiles)) {
    try { files[key] = await fs.readFile(fullPath, 'utf8'); }
    catch { files[key] = null; }
  }
  return files;
}


// ─────────────────────────────────────────────
// BROWSER DETECTOR  (File System Access API)
// ─────────────────────────────────────────────

function isFSAccessAvailable() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

async function readFileFromHandle(dirHandle, ...segments) {
  try {
    let cur = dirHandle;
    for (let i = 0; i < segments.length - 1; i++) cur = await cur.getDirectoryHandle(segments[i]);
    const fh = await cur.getFileHandle(segments[segments.length - 1]);
    return await (await fh.getFile()).text();
  } catch { return null; }
}

async function listSubdirs(dirHandle) {
  const names = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'directory') names.push(name);
  }
  return names;
}

async function detectAccountsBrowser(steamDirHandle) {
  if (!isFSAccessAvailable()) {
    return { ok: false, error: 'File System Access API not supported. Use Chrome or Edge.', accounts: [], cs2Accounts: [] };
  }

  try {
    if (!steamDirHandle) {
      steamDirHandle = await window.showDirectoryPicker({
        id: 'steam-folder',
        startIn: 'desktop',
        mode: 'read',
      });
    }

    let userdataHandle;
    try { userdataHandle = await steamDirHandle.getDirectoryHandle('userdata'); }
    catch {
      return {
        ok: false,
        error: 'No "userdata" folder found. Select the Steam root folder (e.g. C:\\Program Files (x86)\\Steam)',
        accounts: [], cs2Accounts: [], steamDirHandle,
      };
    }

    const subdirs  = await listSubdirs(userdataHandle);
    const accounts = [];

    for (const entry of subdirs) {
      if (!/^\d+$/.test(entry)) continue;
      const steamIdInfo = SteamID.parse(entry);
      if (!steamIdInfo) continue;

      let accountDirHandle;
      try { accountDirHandle = await userdataHandle.getDirectoryHandle(entry); }
      catch { continue; }

      const account = {
        ...steamIdInfo,
        accountDirHandle,
        hasCS2: false,
        configFiles: {},
        configHandles: {},
        profile: { personaName: `Account ${entry}`, lastPlayed: null, language: null, hasCS2: false },
      };

      // Check CS2 folder
      let cs2Handle = null;
      try {
        cs2Handle = await accountDirHandle.getDirectoryHandle('730');
        account.hasCS2 = true;
        account.cs2DirHandle = cs2Handle;
      } catch { /* no CS2 */ }

      // Read localconfig.vdf
      for (const lcPath of LOCALCONFIG_PATHS) {
        const content = await readFileFromHandle(accountDirHandle, ...lcPath.split('/'));
        if (content) {
          const profile = extractLocalConfig(content);
          if (profile.personaName || profile.lastPlayed) {
            account.profile = { ...account.profile, ...profile };
            break;
          }
        }
      }

      // Inventory CS2 config file handles
      if (cs2Handle) {
        for (const [key, relPath] of Object.entries(CS2_CONFIG_FILES)) {
          const segments = relPath.split('/');
          try {
            let cur = cs2Handle;
            for (let i = 0; i < segments.length - 1; i++) cur = await cur.getDirectoryHandle(segments[i]);
            const fh = await cur.getFileHandle(segments[segments.length - 1]);
            account.configHandles[key] = fh;
            account.configFiles[key]   = relPath;
          } catch { /* absent */ }
        }
      }

      accounts.push(account);
    }

    accounts.sort((a, b) => {
      if (a.hasCS2 !== b.hasCS2) return a.hasCS2 ? -1 : 1;
      return (b.profile.lastPlayed?.getTime() ?? 0) - (a.profile.lastPlayed?.getTime() ?? 0);
    });

    return { ok: true, error: null, steamDirHandle, accounts, cs2Accounts: accounts.filter(a => a.hasCS2) };

  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, error: 'Folder selection cancelled.', accounts: [], cs2Accounts: [] };
    return { ok: false, error: `Unexpected error: ${err.message}`, accounts: [], cs2Accounts: [] };
  }
}

async function readCS2ConfigsBrowser(account) {
  const files = {};
  for (const [key, fh] of Object.entries(account.configHandles)) {
    try { files[key] = await (await fh.getFile()).text(); }
    catch { files[key] = null; }
  }
  return files;
}


// ─────────────────────────────────────────────
// UNIFIED API
// ─────────────────────────────────────────────

async function detectAccounts(opts = {}) {
  const isNode = typeof process !== 'undefined' && !!process.versions?.node;
  return isNode ? detectAccountsNode(opts.steamPath) : detectAccountsBrowser(opts.dirHandle);
}

async function readCS2Configs(account) {
  const isNode = typeof process !== 'undefined' && !!process.versions?.node;
  return isNode ? readCS2ConfigsNode(account) : readCS2ConfigsBrowser(account);
}


// ─────────────────────────────────────────────
// DISPLAY HELPER
// ─────────────────────────────────────────────

function formatAccountForUI(account) {
  const lastPlayed = account.profile.lastPlayed
    ? account.profile.lastPlayed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : 'Never';
  const configCount = Object.keys(account.configFiles).length;
  return {
    id:         account.folderName,
    id3:        account.id3Formatted,
    id64:       account.id64,
    steamUrl:   `https://steamcommunity.com/profiles/${account.id64}`,
    name:       account.profile.personaName,
    lastPlayed,
    hasCS2:     account.hasCS2,
    configCount,
    language:   account.profile.language,
    badge:      account.hasCS2 ? `${configCount} config file${configCount !== 1 ? 's' : ''}` : 'No CS2 data',
  };
}


// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────

const CS2SteamDetector = {
  detectAccounts,
  readCS2Configs,
  detectAccountsNode,
  detectAccountsBrowser,
  readCS2ConfigsNode,
  readCS2ConfigsBrowser,
  formatAccountForUI,
  extractLocalConfig,
  isFSAccessAvailable,
  getDefaultSteamPaths,
  CS2_CONFIG_FILES,
  SteamID,
};

