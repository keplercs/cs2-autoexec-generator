/**
 * CS2 VCFG / VDF Parser
 * =====================
 * Parses Valve's KeyValues format (.vcfg, .vdf, config.cfg)
 * and converts it to structured JS objects + clean autoexec.cfg output.
 *
 * Valve KeyValues format example:
 *   "config"
 *   {
 *       "bindings"
 *       {
 *           "w"    "+forward"
 *           "space"    "+jump"
 *       }
 *       "sensitivity" "1.5"
 *   }
 *
 * SteamID math (no API needed):
 *   SteamID64 = 76561197960265728 + SteamID3_numeric
 *   Folder in userdata/ = SteamID3_numeric
 */

// ─────────────────────────────────────────────
// STEAM ID UTILITIES
// ─────────────────────────────────────────────

const SteamID = {
  UNIVERSE_OFFSET: 76561197960265728n, // BigInt for precision

  /**
   * SteamID64 string → SteamID3 numeric (folder name in userdata/)
   * e.g. "76561198105358041" → 145092313
   */
  fromSteamID64(id64) {
    const big = BigInt(id64);
    return Number(big - this.UNIVERSE_OFFSET);
  },

  /**
   * SteamID3 numeric → SteamID64 string
   * e.g. 145092313 → "76561198105358041"
   */
  toSteamID64(id3) {
    return String(BigInt(id3) + this.UNIVERSE_OFFSET);
  },

  /**
   * SteamID3 numeric → formatted SteamID string
   * e.g. 145092313 → "STEAM_0:1:72546156"
   */
  toSteamIDString(id3) {
    const w = id3 & 1;           // auth bit (W)
    const v = (id3 - w) / 2;    // account number (V)
    return `STEAM_0:${w}:${v}`;
  },

  /**
   * Parse any Steam ID format → { id3, id64, steamIdString, formatted3 }
   */
  parse(input) {
    input = String(input).trim();

    let id3 = null;

    // SteamID64 (17 digits starting with 765)
    if (/^765\d{14}$/.test(input)) {
      id3 = this.fromSteamID64(input);
    }
    // [U:1:XXXXXXX]
    else if (/^\[U:1:(\d+)\]$/.test(input)) {
      id3 = parseInt(input.match(/\[U:1:(\d+)\]/)[1]);
    }
    // STEAM_0:W:V  → split('STEAM_0:1:72546156') = ['STEAM_0', '1', '72546156']
    else if (/^STEAM_\d:\d:\d+$/.test(input)) {
      const parts = input.split(':'); // ['STEAM_0', 'W', 'V']
      const w = parseInt(parts[1]);   // auth bit
      const v = parseInt(parts[2]);   // account number
      id3 = v * 2 + w;
    }
    // Raw number (already SteamID3)
    else if (/^\d+$/.test(input)) {
      id3 = parseInt(input);
    }

    if (id3 === null) return null;

    return {
      id3,
      id3Formatted: `[U:1:${id3}]`,
      id64: this.toSteamID64(id3),
      steamIdString: this.toSteamIDString(id3),
      folderName: String(id3), // name of folder in Steam/userdata/
    };
  },
};


// ─────────────────────────────────────────────
// VDF / VCFG TOKENIZER
// ─────────────────────────────────────────────

/**
 * Tokenize a VDF string into a flat list of tokens.
 * Handles: quoted strings, unquoted strings, { } delimiters, // comments
 */
function tokenizeVDF(src) {
  const tokens = [];
  let i = 0;
  const len = src.length;

  while (i < len) {
    const ch = src[i];

    // Whitespace
    if (/\s/.test(ch)) { i++; continue; }

    // Line comment //
    if (ch === '/' && src[i + 1] === '/') {
      while (i < len && src[i] !== '\n') i++;
      continue;
    }

    // Block comment /* */
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < len - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // Braces
    if (ch === '{' || ch === '}') {
      tokens.push({ type: ch === '{' ? 'OPEN' : 'CLOSE', value: ch });
      i++;
      continue;
    }

    // Quoted string
    if (ch === '"') {
      let str = '';
      i++; // skip opening quote
      while (i < len) {
        if (src[i] === '\\' && i + 1 < len) {
          const esc = src[i + 1];
          if (esc === '"') str += '"';
          else if (esc === '\\') str += '\\';
          else if (esc === 'n') str += '\n';
          else if (esc === 't') str += '\t';
          else str += esc;
          i += 2;
          continue;
        }
        if (src[i] === '"') { i++; break; }
        str += src[i++];
      }
      tokens.push({ type: 'STRING', value: str });
      continue;
    }

    // Unquoted token (up to whitespace or brace)
    let word = '';
    while (i < len && !/[\s{}"\/]/.test(src[i])) {
      word += src[i++];
    }
    if (word) tokens.push({ type: 'STRING', value: word });
  }

  return tokens;
}


// ─────────────────────────────────────────────
// VDF / VCFG PARSER  (tokens → nested object)
// ─────────────────────────────────────────────

/**
 * Parse a VDF token stream into a nested JS object.
 * Duplicate keys become arrays automatically.
 */
function parseVDFTokens(tokens) {
  let pos = 0;

  function parseObject() {
    const obj = {};

    while (pos < tokens.length) {
      const tok = tokens[pos];

      if (tok.type === 'CLOSE') { pos++; return obj; }
      if (tok.type !== 'STRING') { pos++; continue; }

      const key = tok.value;
      pos++;

      if (pos >= tokens.length) break;
      const next = tokens[pos];

      let value;
      if (next.type === 'OPEN') {
        pos++; // consume {
        value = parseObject();
      } else if (next.type === 'STRING') {
        value = next.value;
        pos++;
      } else {
        continue;
      }

      // Handle duplicate keys → array
      if (key in obj) {
        if (!Array.isArray(obj[key])) obj[key] = [obj[key]];
        obj[key].push(value);
      } else {
        obj[key] = value;
      }
    }

    return obj;
  }

  // Top-level can be multiple root keys
  const root = {};
  while (pos < tokens.length) {
    if (tokens[pos].type !== 'STRING') { pos++; continue; }
    const key = tokens[pos].value;
    pos++;
    if (pos >= tokens.length) break;
    const next = tokens[pos];
    if (next.type === 'OPEN') {
      pos++;
      root[key] = parseObject();
    } else if (next.type === 'STRING') {
      root[key] = next.value;
      pos++;
    }
  }
  return root;
}

/**
 * Main entry: parse a VDF/VCFG string → nested object
 */
function parseVDF(src) {
  const tokens = tokenizeVDF(src);
  return parseVDFTokens(tokens);
}


// ─────────────────────────────────────────────
// VCFG FILE EXTRACTORS
// ─────────────────────────────────────────────

/**
 * Extract bindings from cs2_user_keys_0_slot0.vcfg
 * Returns: { key: command, ... }
 * e.g. { "w": "+forward", "space": "+jump", "mwheeldown": "+jump" }
 */
function extractBindings(vcfgContent) {
  const parsed = parseVDF(vcfgContent);

  // Navigate: root → any top key → "bindings" object
  const bindings = {};

  function findBindings(obj) {
    if (typeof obj !== 'object' || obj === null) return;
    if ('bindings' in obj && typeof obj.bindings === 'object') {
      Object.assign(bindings, obj.bindings);
      return;
    }
    for (const v of Object.values(obj)) {
      if (typeof v === 'object') findBindings(v);
    }
  }

  findBindings(parsed);
  return bindings;
}

/**
 * Extract ConVars from cs2_user_convars_0_slot0.vcfg or cs2_machine_convars.vcfg
 * Returns: { convar: value, ... }
 */
function extractConVars(vcfgContent) {
  const parsed = parseVDF(vcfgContent);
  const convars = {};

  function flattenConVars(obj, depth = 0) {
    if (typeof obj !== 'object' || obj === null) return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') {
        convars[k] = v;
      } else if (typeof v === 'object' && depth < 4) {
        flattenConVars(v, depth + 1);
      }
    }
  }

  flattenConVars(parsed);
  return convars;
}

/**
 * Parse cs2_video.txt (slightly different — not nested VDF, flat key-value)
 */
function extractVideoSettings(videoTxtContent) {
  const parsed = parseVDF(videoTxtContent);
  const settings = {};

  function flatten(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') settings[k] = v;
      else flatten(v);
    }
  }

  flatten(parsed);
  return settings;
}


// ─────────────────────────────────────────────
// CATEGORIZER — groups convars by section
// ─────────────────────────────────────────────

const CONVAR_CATEGORIES = {
  crosshair: [
    'cl_crosshairstyle', 'cl_crosshairsize', 'cl_crosshairgap',
    'cl_crosshairthickness', 'cl_crosshairalpha', 'cl_crosshaircolor',
    'cl_crosshaircolor_r', 'cl_crosshaircolor_g', 'cl_crosshaircolor_b',
    'cl_crosshairdot', 'cl_crosshair_t', 'cl_crosshair_drawoutline',
    'cl_crosshair_outlinethickness', 'cl_crosshairusealpha',
    'cl_crosshairgap_useweaponvalue', 'cl_crosshair_recoil',
    'cl_crosshair_dynamic_maxdist_splitratio',
    'cl_crosshair_dynamic_splitalpha_innermod',
    'cl_crosshair_dynamic_splitalpha_outermod',
    'cl_crosshair_dynamic_splitdist',
    'cl_crosshair_sniper_show_normal_inaccuracy',
    'cl_crosshair_sniper_width',
    'cl_crosshair_friendly_warning',
  ],
  mouse: [
    'sensitivity', 'm_rawinput', 'm_mouseaccel1', 'm_mouseaccel2',
    'm_customaccel', 'm_customaccel_exponent', 'm_customaccel_max',
    'm_customaccel_scale', 'm_pitch', 'm_yaw',
    'zoom_sensitivity_ratio_mouse', 'cl_debounce_zoom',
  ],
  viewmodel: [
    'viewmodel_fov', 'viewmodel_offset_x', 'viewmodel_offset_y',
    'viewmodel_offset_z', 'viewmodel_presetpos',
    'cl_prefer_lefthanded', 'cl_righthand',
    'viewmodel_recoil', 'cl_bob_lower_amt',
    'cl_bobamt_lat', 'cl_bobamt_vert', 'cl_bobcycle',
  ],
  hud: [
    'cl_hud_color', 'cl_hud_background_alpha', 'hud_scaling',
    'cl_hud_radar_scale', 'cl_hud_playercount_pos',
    'cl_hud_playercount_showcount', 'cl_showloadout',
    'cl_draw_only_deathnotices', 'cl_drawhud',
    'safezonex', 'safezoney',
  ],
  radar: [
    'cl_radar_scale', 'cl_radar_always_centered', 'cl_radar_rotate',
    'cl_radar_square_with_scoreboard', 'cl_radar_icon_scale_min',
    'cl_hud_radar_scale', 'cl_teamid_overhead_always',
  ],
  network: [
    'rate', 'cl_cmdrate', 'cl_updaterate',
    'cl_interp', 'cl_interp_ratio',
    'cl_lagcompensation', 'net_client_steamdatagram_enable_override',
  ],
  audio: [
    'volume', 'voice_scale', 'snd_mixahead',
    'snd_headphone_pan_exponent', 'snd_headphone_pan_radial_weight',
    'snd_musicvolume', 'snd_musicvolume_multiplier_inoverlay',
    'snd_deathcamera_volume', 'snd_roundstart_volume',
    'snd_roundend_volume', 'snd_tensecond_volume',
    'snd_mvp_volume', 'cl_clutch_mode',
  ],
  fps: [
    'fps_max', 'fps_max_ui', 'fps_max_shadow_deferred',
    'r_dynamic_lighting', 'r_lowlatency',
    'mat_monitorgamma', 'mat_monitorgamma_tv_enabled',
  ],
  gameplay: [
    'cl_autohelp', 'cl_autobuy', 'cl_rebuy',
    'cl_color', 'cl_dm_buyrandomweapons',
    'player_nevershow_communityservermessage',
    'cl_show_clan_in_death_notice', 'cl_teamid_overhead_always',
    'cl_disable_round_end_report',
  ],
};

/**
 * Categorize a flat convars object into sections.
 * Returns { crosshair: {...}, mouse: {...}, ... , uncategorized: {...} }
 */
function categorizeConVars(convars) {
  const result = {};
  const assigned = new Set();

  for (const [category, keys] of Object.entries(CONVAR_CATEGORIES)) {
    result[category] = {};
    for (const key of keys) {
      if (key in convars) {
        result[category][key] = convars[key];
        assigned.add(key);
      }
    }
  }

  // Anything not matched goes to uncategorized
  result.uncategorized = {};
  for (const [k, v] of Object.entries(convars)) {
    if (!assigned.has(k)) result.uncategorized[k] = v;
  }

  return result;
}


// ─────────────────────────────────────────────
// AUTOEXEC GENERATOR
// ─────────────────────────────────────────────

const SECTION_LABELS = {
  crosshair: 'CROSSHAIR',
  mouse:     'MOUSE',
  viewmodel: 'VIEWMODEL',
  hud:       'HUD',
  radar:     'RADAR',
  network:   'NETWORK',
  audio:     'AUDIO',
  fps:       'FPS / PERFORMANCE',
  gameplay:  'GAMEPLAY',
};

/**
 * Generate a clean autoexec.cfg string from categorized data.
 *
 * @param {Object} opts
 * @param {Object} opts.categorized  - output of categorizeConVars()
 * @param {Object} opts.bindings     - output of extractBindings()
 * @param {Object} opts.options      - { includeUncat, addComments, execOnSave, header }
 * @returns {string} autoexec.cfg content
 */
function generateAutoexec({
  categorized = {},
  bindings = {},
  options = {},
}) {
  const {
    includeUncat = false,
    addComments = true,
    execOnSave = true,
    header = true,
  } = options;

  const lines = [];
  const now = new Date().toISOString().split('T')[0];

  // ── Header ────────────────────────────────
  if (header) {
    lines.push('// ═══════════════════════════════════════════');
    lines.push('// CS2 AUTOEXEC.CFG');
    lines.push(`// Generated: ${now}`);
    lines.push('// Place in: game/csgo/cfg/autoexec.cfg');
    lines.push('// Launch option: +exec autoexec');
    lines.push('// ═══════════════════════════════════════════');
    lines.push('');
  }

  // ── ConVar Sections ───────────────────────
  for (const [section, label] of Object.entries(SECTION_LABELS)) {
    const vars = categorized[section];
    if (!vars || Object.keys(vars).length === 0) continue;

    if (addComments) {
      lines.push(`// ── ${label} ${'─'.repeat(Math.max(0, 40 - label.length))}`);
    }

    for (const [k, v] of Object.entries(vars)) {
      // Quote value if it contains spaces
      const val = /\s/.test(v) ? `"${v}"` : v;
      lines.push(`${k} ${val}`);
    }
    lines.push('');
  }

  // ── Uncategorized ─────────────────────────
  if (includeUncat && categorized.uncategorized) {
    const extra = Object.entries(categorized.uncategorized);
    if (extra.length > 0) {
      if (addComments) lines.push('// ── EXTRA ──────────────────────────────');
      for (const [k, v] of extra) {
        const val = /\s/.test(v) ? `"${v}"` : v;
        lines.push(`${k} ${val}`);
      }
      lines.push('');
    }
  }

  // ── Bindings ──────────────────────────────
  const bindEntries = Object.entries(bindings);
  if (bindEntries.length > 0) {
    if (addComments) lines.push('// ── BINDS ───────────────────────────────');

    for (const [key, cmd] of bindEntries) {
      // Multi-command: "cmd1; cmd2" stays as-is
      // Values with spaces need quoting
      const val = /\s/.test(cmd) && !cmd.startsWith('"') ? `"${cmd}"` : cmd;
      lines.push(`bind "${key}" "${val.replace(/^"|"$/g, '')}"`);
    }
    lines.push('');
  }

  // ── Footer ────────────────────────────────
  if (addComments) {
    lines.push('// ── END ─────────────────────────────────');
  }
  if (execOnSave) {
    lines.push('host_writeconfig');
  }

  return lines.join('\n');
}


// ─────────────────────────────────────────────
// DIFF / MERGE  — compare two configs
// ─────────────────────────────────────────────

/**
 * Diff two flat convar objects.
 * Returns { added, removed, changed: [{key, oldVal, newVal}] }
 */
function diffConVars(oldVars, newVars) {
  const added = {};
  const removed = {};
  const changed = [];

  for (const [k, v] of Object.entries(newVars)) {
    if (!(k in oldVars)) added[k] = v;
    else if (oldVars[k] !== v) changed.push({ key: k, oldVal: oldVars[k], newVal: v });
  }
  for (const k of Object.keys(oldVars)) {
    if (!(k in newVars)) removed[k] = oldVars[k];
  }

  return { added, removed, changed };
}


// ─────────────────────────────────────────────
// HIGH-LEVEL PIPELINE
// ─────────────────────────────────────────────

/**
 * Full pipeline: takes raw file contents → returns autoexec string + metadata.
 *
 * @param {Object} files
 * @param {string} [files.userConvars]   content of cs2_user_convars_0_slot0.vcfg
 * @param {string} [files.machineConvars] content of cs2_machine_convars.vcfg
 * @param {string} [files.userKeys]      content of cs2_user_keys_0_slot0.vcfg
 * @param {string} [files.videoTxt]      content of cs2_video.txt
 * @param {Object} [options]             options forwarded to generateAutoexec()
 *
 * @returns {{ autoexec: string, categorized: Object, bindings: Object, stats: Object }}
 */
function vcfgToAutoexec(files = {}, options = {}) {
  const allConVars = {};

  if (files.userConvars) {
    Object.assign(allConVars, extractConVars(files.userConvars));
  }
  if (files.machineConvars) {
    // Machine convars have lower priority — don't overwrite user ones
    const machine = extractConVars(files.machineConvars);
    for (const [k, v] of Object.entries(machine)) {
      if (!(k in allConVars)) allConVars[k] = v;
    }
  }
  if (files.videoTxt) {
    const video = extractVideoSettings(files.videoTxt);
    for (const [k, v] of Object.entries(video)) {
      if (!(k in allConVars)) allConVars[k] = v;
    }
  }

  const bindings = files.userKeys ? extractBindings(files.userKeys) : {};
  const categorized = categorizeConVars(allConVars);

  const autoexec = generateAutoexec({ categorized, bindings, options });

  const stats = {
    totalConVars: Object.keys(allConVars).length,
    totalBinds: Object.keys(bindings).length,
    sections: Object.fromEntries(
      Object.entries(categorized).map(([k, v]) => [k, Object.keys(v).length])
    ),
  };

  return { autoexec, categorized, bindings, allConVars, stats };
}


// ─────────────────────────────────────────────
// EXPORTS  (works in Node.js and as ES module)
// ─────────────────────────────────────────────

const CS2Parser = {
  // Core parser
  parseVDF,
  tokenizeVDF,

  // Extractors
  extractBindings,
  extractConVars,
  extractVideoSettings,

  // Organizers
  categorizeConVars,
  CONVAR_CATEGORIES,

  // Generator
  generateAutoexec,

  // Diff/merge
  diffConVars,

  // Main pipeline
  vcfgToAutoexec,

  // Steam ID utilities
  SteamID,
};

// Node.js / CommonJS
// ES Module
if (typeof window !== 'undefined') {
  window.CS2Parser = CS2Parser;
}

// CS2Parser available as window.CS2Parser


// ─────────────────────────────────────────────
// USAGE EXAMPLES (run with: node cs2-vcfg-parser.js)
// ─────────────────────────────────────────────

if (typeof process !== 'undefined' && process.argv[1]?.includes('cs2-vcfg-parser')) {
  console.log('\n=== CS2 VCFG Parser — Self-Test ===\n');

  // 1) SteamID conversions
  const id = SteamID.parse('76561198105358041');
  console.log('SteamID parse from ID64:');
  console.log(' Folder name (SteamID3):', id.folderName);   // → 145092313
  console.log(' SteamID64:',             id.id64);          // → 76561198105358041
  console.log(' SteamID string:',        id.steamIdString); // → STEAM_0:1:72546156
  console.log(' SteamID3 formatted:',    id.id3Formatted);  // → [U:1:145092313]

  const id2 = SteamID.parse('[U:1:145092313]');
  console.log('\nSteamID parse from ID3:', id2.id64, '→ same result:', id2.id64 === id.id64);

  // 2) VDF parsing
  const sampleVCFG = `
"cs2_user_keys_0_slot0"
{
    "bindings"
    {
        "w"          "+forward"
        "a"          "+moveleft"
        "s"          "+back"
        "d"          "+moveright"
        "space"      "+jump"
        "ctrl"       "+duck"
        "shift"      "+speed"
        "mouse1"     "+attack"
        "mouse2"     "+attack2"
        "mwheeldown" "+jump"
        "mwheelup"   "+jump"
        "r"          "+reload"
        "e"          "+use"
        "g"          "drop"
        "b"          "buymenu"
        "1"          "slot1"
        "2"          "slot2"
        "3"          "slot3"
        "4"          "slot4"
        "5"          "slot5"
        "tab"        "+showscores"
        "y"          "messagemode"
        "u"          "messagemode2"
    }
}
  `;

  const sampleConvars = `
"cs2_user_convars_0_slot0"
{
    "sensitivity"              "1.3"
    "cl_crosshairstyle"        "4"
    "cl_crosshairsize"         "3"
    "cl_crosshairgap"          "-2"
    "cl_crosshairthickness"    "1"
    "cl_crosshairalpha"        "255"
    "cl_crosshaircolor"        "5"
    "cl_crosshaircolor_r"      "255"
    "cl_crosshaircolor_g"      "255"
    "cl_crosshaircolor_b"      "255"
    "cl_crosshairdot"          "0"
    "cl_crosshair_t"           "0"
    "cl_crosshair_drawoutline" "0"
    "viewmodel_fov"            "68"
    "viewmodel_offset_x"       "2"
    "viewmodel_offset_y"       "2"
    "viewmodel_offset_z"       "-2"
    "cl_prefer_lefthanded"     "0"
    "hud_scaling"              "0.85"
    "cl_hud_color"             "5"
    "cl_radar_scale"           "0.35"
    "cl_radar_always_centered" "0"
    "cl_radar_rotate"          "1"
    "volume"                   "0.5"
    "voice_scale"              "0.7"
    "rate"                     "786432"
    "cl_interp_ratio"          "1"
    "fps_max"                  "0"
}
  `;

  const result = vcfgToAutoexec(
    { userKeys: sampleVCFG, userConvars: sampleConvars },
    { addComments: true, execOnSave: true, includeUncat: false }
  );

  console.log('\n── Stats ──');
  console.log(JSON.stringify(result.stats, null, 2));

  console.log('\n── Generated autoexec.cfg ──');
  console.log(result.autoexec);
}
